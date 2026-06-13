import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  NOTIFICATION_ALL_STATES,
  NOTIFICATION_WORKFLOW_NAME,
  NOTIFICATION_WORKFLOW_SCHEMA_VERSION,
  nextNotificationEvents,
  notificationStateToLegacyStatus,
  parseNotificationEventRequest,
  transitionNotificationWorkflow,
  type NotificationChannel,
  type NotificationFailureKind,
  type NotificationWorkflowEvent,
  type NotificationWorkflowSnapshot,
  type NotificationWorkflowState,
} from '@sitelayer/workflows'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { buildPaginationMeta, isValidUuid, parsePagination } from '../http-utils.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

export type NotificationRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * Shape returned to the client. `read_at` is stored inside the `payload`
 * jsonb (no migration in this slice — the worker drain owns the row's
 * delivery columns; the user-read flag is an additive extension we keep
 * inline for now). When migration `054_notifications_read_at.sql` lands
 * and adds a real column, the SELECT/UPDATE here flips to it without
 * touching consumers.
 */
type NotificationRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  kind: string
  subject: string
  body_text: string
  payload: Record<string, unknown>
  read_at: string | null
  created_at: string
  // Delivery-state fields, recipient-scoped, derived from the latest
  // workflow_event_log snapshot for this row (null for pre-workflow rows
  // with no event log). Lets the mobile inbox show a delivery badge
  // without exposing the company-wide admin queue to non-admins.
  state: NotificationWorkflowState | null
  channel: NotificationChannel | null
  failure_kind: NotificationFailureKind | null
  failed_at: string | null
}

// Notifications page in a feed — keep a smaller default than the global
// 100, but the upper bound is the shared 500 cap (set via maxLimit).
const NOTIFICATIONS_DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// Admin notification queue (company-scoped delivery view) + the RETRY/VOID
// workflow-event surface. Mirrors the deterministic-workflow pattern in
// rental-billing-state.ts.
//
// Reconciliation note — the `notifications.status` column only stores the
// collapsed legacy vocabulary (`pending` / `sending` / `sent` / `failed` /
// `voided`); the worker projects the reducer's eight states down to those
// via `workflowStateToLegacyStatus` (apps/worker/src/notifications.ts). The
// canonical eight-state vocabulary — and the `failure_kind` / `error` /
// `channel` discriminators the frontend hook needs — live in
// `workflow_event_log.snapshot_after` (the JSONB reducer output). So the
// queue join reaches into the latest event-log snapshot for each row and
// reconstructs the true `NotificationWorkflowSnapshot`, falling back to the
// row's own `status` for legacy rows that predate the workflow / have no
// event log yet. There is intentionally NO `failure_kind` / `channel`
// column on the table (migration 081 header documents this), so adding one
// is out of scope; we adapt the API response to the hook's contract here.
// ---------------------------------------------------------------------------

const NOTIFICATION_QUEUE_LIMIT = 200

// Frontend-contract row. Field names match apps/web/src/lib/api/notifications-queue.ts
// NotificationQueueRow exactly — `state` is the canonical eight-state
// workflow state, `failure_kind` / `error` / `channel` are derived from the
// latest workflow_event_log snapshot.
type NotificationQueueRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  channel: NotificationChannel | null
  state: NotificationWorkflowState
  state_version: number
  failure_kind: NotificationFailureKind | null
  error: string | null
  delivery_attempts: number | null
  next_attempt_at: string | null
  sent_at: string | null
  failed_at: string | null
  created_at: string
}

// Raw row read by the queue join: the notifications columns plus the latest
// workflow_event_log snapshot_after JSONB (or null for legacy rows).
type NotificationQueueDbRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  status: string
  state_version: number
  error: string | null
  last_delivery_error: string | null
  delivery_attempts: number | null
  next_attempt_at: string | null
  sent_at: string | null
  created_at: string
  // workflow_event_log.snapshot_after for the highest state_version row of
  // this notification, or null when none has been written yet.
  snapshot_after: NotificationWorkflowSnapshot | null
}

// Project the notifications columns the queue surface needs, joined (via the
// QUEUE_FROM lateral) to the latest workflow_event_log snapshot for the
// canonical reducer state.
const QUEUE_SELECT = `
  n.id,
  n.company_id,
  n.recipient_clerk_user_id,
  n.recipient_email,
  n.kind,
  n.subject,
  n.status,
  coalesce(n.state_version, 1) as state_version,
  n.error,
  n.last_delivery_error,
  coalesce(n.delivery_attempts, 0) as delivery_attempts,
  n.next_attempt_at,
  n.sent_at,
  n.created_at,
  wel.snapshot_after
`

// RETURNING projection for the UPDATE path — same columns, but no table
// alias (RETURNING references the target table directly) and snapshot_after
// is synthesized as null (the lateral join isn't visible to RETURNING; the
// route re-attaches the fresh reducer snapshot in JS).
const QUEUE_RETURNING = `
  id,
  company_id,
  recipient_clerk_user_id,
  recipient_email,
  kind,
  subject,
  status,
  coalesce(state_version, 1) as state_version,
  error,
  last_delivery_error,
  coalesce(delivery_attempts, 0) as delivery_attempts,
  next_attempt_at,
  sent_at,
  created_at,
  null::jsonb as snapshot_after
`

const QUEUE_FROM = `
  from notifications n
  left join lateral (
    select snapshot_after
    from workflow_event_log
    where entity_id = n.id
      and workflow_name = '${NOTIFICATION_WORKFLOW_NAME}'
    order by state_version desc
    limit 1
  ) wel on true
`

const VALID_QUEUE_STATES = new Set<string>(NOTIFICATION_ALL_STATES)

// Collapse the reducer's eight states down to the legacy `status` vocabulary
// the worker also writes. The collapse map is the single shared
// `notificationStateToLegacyStatus` exported from `@sitelayer/workflows`
// (next to the reducer) — the worker and this route both import it so the
// two writers of `notifications.status` can never drift.

// Recover the canonical eight-state snapshot for a row. Prefer the latest
// workflow_event_log snapshot (authoritative); fall back to projecting the
// collapsed `status` column for legacy rows with no event log. The `failed`
// collapse is ambiguous (provider vs clerk_unreachable vs clerk_not_found),
// so legacy `failed` rows resolve to `failed_provider` — the most common,
// retryable terminal — and surface no `failure_kind`.
function rowToSnapshot(row: NotificationQueueDbRow): NotificationWorkflowSnapshot {
  const snap = row.snapshot_after
  if (snap && typeof snap.state === 'string' && VALID_QUEUE_STATES.has(snap.state)) {
    return {
      ...snap,
      // state_version on the row is authoritative for the optimistic check
      // (snapshot_after.state_version is the post-transition version that was
      // current when the log row was written; the row carries the live one).
      state_version: row.state_version,
    }
  }
  let state: NotificationWorkflowState
  switch (row.status) {
    case 'sent':
      state = 'sent'
      break
    case 'sending':
      state = 'sending'
      break
    case 'failed':
      state = 'failed_provider'
      break
    case 'voided':
      state = 'voided'
      break
    default:
      state = 'pending'
  }
  return {
    state,
    state_version: row.state_version,
    error: row.error ?? row.last_delivery_error ?? null,
    failure_kind: null,
  }
}

function rowToQueueRow(row: NotificationQueueDbRow): NotificationQueueRow {
  const snapshot = rowToSnapshot(row)
  return {
    id: row.id,
    company_id: row.company_id,
    recipient_clerk_user_id: row.recipient_clerk_user_id,
    recipient_email: snapshot.recipient_email ?? row.recipient_email ?? null,
    kind: row.kind,
    subject: row.subject,
    channel: snapshot.channel ?? null,
    state: snapshot.state,
    state_version: row.state_version,
    failure_kind: snapshot.failure_kind ?? null,
    error: snapshot.error ?? row.error ?? row.last_delivery_error ?? null,
    delivery_attempts: row.delivery_attempts ?? null,
    next_attempt_at: row.next_attempt_at,
    sent_at: row.sent_at,
    // failed_at travels on the SEND_FAILED event; surface it from the snapshot.
    failed_at: snapshot.failed_at ?? null,
    created_at: row.created_at,
  }
}

// Snapshot response for the workflow-event POST — same shape as every other
// workflow ({ state, state_version, next_events, context }). The frontend
// NotificationSnapshot.context is the full queue row.
function notificationSnapshotResponse(row: NotificationQueueDbRow): {
  state: NotificationWorkflowState
  state_version: number
  next_events: ReturnType<typeof nextNotificationEvents>
  context: NotificationQueueRow
} {
  const queueRow = rowToQueueRow(row)
  return {
    state: queueRow.state,
    state_version: queueRow.state_version,
    next_events: nextNotificationEvents(queueRow.state),
    context: queueRow,
  }
}

/**
 * The events UPDATE is keyed on the same (company_id, id) pair the FOR UPDATE
 * lock just matched, so an empty RETURNING is theoretically unreachable — but
 * the legacy hand-rolled path mapped it to a 404 rather than a 500. This
 * sentinel preserves that exact contract through the primitive's `persist`
 * callback (which can only return a row or throw).
 */
class NotificationUpdateMissingError extends Error {}

function buildNotificationReducerEvent(
  eventType: 'RETRY' | 'VOID',
  reason: string | null,
  nowIso: string,
): NotificationWorkflowEvent {
  if (eventType === 'RETRY') {
    return { type: 'RETRY', retried_at: nowIso }
  }
  return { type: 'VOID', voided_at: nowIso, reason: reason ?? null }
}

// Project the schema's columns plus a synthesized `read_at` derived from
// payload->>'read_at'. Keeping this string in one constant means the
// list and read-mark queries return the same shape.
const SELECT_PROJECTION = `
  id, company_id, recipient_clerk_user_id,
  kind, subject, body_text, payload,
  (payload->>'read_at') as read_at,
  created_at
`

/**
 * Per-user notification feed. Reads the same `notifications` ledger that
 * the worker drains into for Loop 2 (Field Event Escalation) and the
 * project-lifecycle assignment fan-out. Scoped to
 * `recipient_clerk_user_id = currentUserId` and the active company so a
 * user can only see their own queue.
 *
 * - GET  /api/notifications?unread=1&kind=worker_issue_resolved&limit=20
 *        Returns rows ordered by created_at desc.
 * - POST /api/notifications/:id/read
 *        Marks read_at = now() for a single row owned by the caller.
 *        404s when the row exists but isn't theirs (no leak).
 *
 * The route does not gate on role — any authenticated user can poll
 * their own notifications row, the same way wk-issue lets any user file
 * a ticket. Recipient scoping is enforced via the WHERE clause.
 */
export async function handleNotificationRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: NotificationRouteCtx,
): Promise<boolean> {
  // Admin notification queue — company-scoped (NOT per-recipient) delivery
  // view for admin/office. Surfaces the canonical workflow state + delivery
  // columns the Notification-queue UI renders.
  if (req.method === 'GET' && url.pathname === '/api/notifications/queue') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const stateFilter = url.searchParams.get('state')
    const params: unknown[] = [ctx.company.id]
    // Canonical-state filter: the live state lives in the joined event-log
    // snapshot, with the row's collapsed `status` as the legacy fallback.
    // Both arms must agree so a `?state=` filter is exact across rows that
    // do and don't have an event log yet.
    let stateClause = ''
    if (stateFilter && VALID_QUEUE_STATES.has(stateFilter)) {
      params.push(stateFilter)
      const idx = params.length
      const legacy = notificationStateToLegacyStatus(stateFilter as NotificationWorkflowState)
      params.push(legacy)
      const legacyIdx = params.length
      stateClause = ` and (
        case
          when wel.snapshot_after is not null then wel.snapshot_after->>'state' = $${idx}
          else n.status = $${legacyIdx}
        end
      )`
    } else if (stateFilter) {
      // Unknown state value → empty result rather than a silent full list.
      ctx.sendJson(200, { notifications: [] })
      return true
    }

    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<NotificationQueueDbRow>(
        `select ${QUEUE_SELECT}
         ${QUEUE_FROM}
         where n.company_id = $1${stateClause}
         order by n.created_at desc
         limit ${NOTIFICATION_QUEUE_LIMIT}`,
        params,
      ),
    )
    ctx.sendJson(200, { notifications: result.rows.map(rowToQueueRow) })
    return true
  }

  // Workflow-event dispatch (RETRY / VOID) for one notification row.
  const eventMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseNotificationEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const eventType = parsed.value.event
    const reason = parsed.value.event === 'VOID' ? (parsed.value.reason ?? null) : null
    const stateVersion = parsed.value.state_version

    try {
      const outcome = await withMutationTx(ctx.company.id, async (client: PoolClient) => {
        try {
          return await dispatchWorkflowEvent<
            NotificationQueueDbRow,
            NotificationWorkflowSnapshot,
            NotificationWorkflowEvent
          >(client, {
            definition: {
              name: NOTIFICATION_WORKFLOW_NAME,
              schemaVersion: NOTIFICATION_WORKFLOW_SCHEMA_VERSION,
              reduce: transitionNotificationWorkflow,
            },
            companyId: ctx.company.id,
            entityType: 'notification',
            entityId: id,
            // Post-lock optimistic check: concurrent POSTs with the same
            // state_version serialize on the row lock; the second sees the
            // bumped version and 409s. Same pattern as rental-billing-state.ts.
            expectedStateVersion: stateVersion,
            actorUserId: ctx.currentUserId,
            loadSnapshot: async (c) => {
              const lockedResult = await c.query<NotificationQueueDbRow>(
                `select ${QUEUE_SELECT}
                 ${QUEUE_FROM}
                 where n.company_id = $1 and n.id = $2
                 for update of n`,
                [ctx.company.id, id],
              )
              const current = lockedResult.rows[0]
              if (!current) return null
              return { row: current, snapshot: rowToSnapshot(current) }
            },
            buildEvent: () => buildNotificationReducerEvent(eventType, reason, new Date().toISOString()),
            persist: async (c, next) => {
              const nextStatus = notificationStateToLegacyStatus(next.state)
              // RETRY re-enters `pending` — the worker claim query is
              // `where status = 'pending' and next_attempt_at <= now()`
              // (apps/worker/src/notifications.ts), so reset next_attempt_at to
              // now() for immediate re-claim and clear the stale error. VOID is
              // terminal; stash the reason in `error` and leave scheduling alone.
              const updateSql =
                eventType === 'RETRY'
                  ? `update notifications
                       set status = $3,
                           state_version = $4,
                           next_attempt_at = now(),
                           error = null,
                           last_delivery_error = null
                     where company_id = $1 and id = $2
                     returning ${QUEUE_RETURNING}`
                  : `update notifications
                       set status = $3,
                           state_version = $4,
                           error = $5
                     where company_id = $1 and id = $2
                     returning ${QUEUE_RETURNING}`
              // The RETURNING projection can't reach the lateral join, so we
              // re-attach the reducer's fresh snapshot to the returned row below.
              const updateParams =
                eventType === 'RETRY'
                  ? [ctx.company.id, id, nextStatus, next.state_version]
                  : [ctx.company.id, id, nextStatus, next.state_version, next.error ?? null]
              const updateResult = await c.query<NotificationQueueDbRow>(updateSql, updateParams)
              const updated = updateResult.rows[0]
              if (!updated) throw new NotificationUpdateMissingError()
              // Stamp the fresh reducer snapshot onto the returned row so the
              // response context carries the new canonical state / failure_kind /
              // channel rather than the pre-update event-log snapshot.
              updated.snapshot_after = next
              return updated
            },
          })
        } catch (err) {
          // Legacy contract: an empty UPDATE RETURNING (unreachable in
          // practice — the row is locked) responded 404, not 500.
          if (err instanceof NotificationUpdateMissingError) return { kind: 'not_found' as const }
          throw err
        }
      })

      if (outcome.kind === 'not_found') {
        ctx.sendJson(404, { error: 'notification not found' })
        return true
      }
      if (outcome.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: notificationSnapshotResponse(outcome.row),
        })
        return true
      }
      if (outcome.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: outcome.message,
          snapshot: notificationSnapshotResponse(outcome.row),
        })
        return true
      }

      ctx.sendJson(200, notificationSnapshotResponse(outcome.row))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const unreadOnly = url.searchParams.get('unread') === '1'
    const kind = url.searchParams.get('kind')
    const pagination = parsePagination(url.searchParams, { defaultLimit: NOTIFICATIONS_DEFAULT_LIMIT })
    if (!pagination.ok) {
      ctx.sendJson(400, { error: pagination.error })
      return true
    }

    const filters: string[] = ['n.company_id = $1', 'n.recipient_clerk_user_id = $2']
    const params: unknown[] = [ctx.company.id, ctx.currentUserId]
    if (unreadOnly) filters.push("(n.payload->>'read_at') is null")
    if (kind) {
      params.push(kind)
      filters.push(`n.kind = $${params.length}`)
    }
    params.push(pagination.value.limit)
    params.push(pagination.value.offset)

    // Recipient-scoped feed enriched with the latest workflow_event_log
    // snapshot so the mobile inbox can render a delivery badge
    // (state/channel/failure_kind) without exposing the admin queue. Rows
    // without an event log (pre-workflow) degrade to null delivery fields.
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<NotificationRow>(
        `select
           n.id, n.company_id, n.recipient_clerk_user_id,
           n.kind, n.subject, n.body_text, n.payload,
           (n.payload->>'read_at') as read_at,
           n.created_at,
           wel.snapshot_after->>'state' as state,
           wel.snapshot_after->>'channel' as channel,
           wel.snapshot_after->>'failure_kind' as failure_kind,
           wel.snapshot_after->>'failed_at' as failed_at
         from notifications n
         left join lateral (
           select snapshot_after
           from workflow_event_log
           where entity_id = n.id
             and workflow_name = '${NOTIFICATION_WORKFLOW_NAME}'
           order by state_version desc
           limit 1
         ) wel on true
         where ${filters.join(' and ')}
         order by n.created_at desc
         limit $${params.length - 1} offset $${params.length}`,
        params,
      ),
    )
    ctx.sendJson(200, {
      notifications: result.rows,
      pagination: buildPaginationMeta(pagination.value, result.rowCount ?? result.rows.length),
    })
    return true
  }

  const readMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
  if (req.method === 'POST' && readMatch) {
    const id = readMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    // Scope the update to (company, recipient) so a caller can never
    // mark someone else's notification read — even if they guess the id.
    // jsonb_set with create_missing=true on payload->>'read_at' keeps the
    // existing payload contents intact while stamping the read time.
    const updated = await withMutationTx(ctx.company.id, (c) =>
      c.query<NotificationRow>(
        `update notifications
         set payload = jsonb_set(
           coalesce(payload, '{}'::jsonb),
           '{read_at}',
           to_jsonb(coalesce(payload->>'read_at', now()::text)),
           true
         )
       where id = $1
         and company_id = $2
         and recipient_clerk_user_id = $3
       returning ${SELECT_PROJECTION},
         null::text as state,
         null::text as channel,
         null::text as failure_kind,
         null::text as failed_at`,
        [id, ctx.company.id, ctx.currentUserId],
      ),
    )
    if (updated.rowCount === 0) {
      ctx.sendJson(404, { error: 'notification not found' })
      return true
    }
    ctx.sendJson(200, { notification: updated.rows[0] })
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `notifications` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const notificationsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'notifications',
  order: 760,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
    handleNotificationRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
    }),
}

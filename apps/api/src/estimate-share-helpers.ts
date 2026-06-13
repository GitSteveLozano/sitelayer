import type { Pool, PoolClient } from 'pg'
import { createLogger } from '@sitelayer/logger'
import {
  projectLifecycleWorkflow,
  type ProjectLifecycleWorkflowEvent,
  type ProjectLifecycleWorkflowSnapshot,
} from '@sitelayer/workflows'
import { verifyShareToken, type VerifyShareTokenResult } from './estimate-share-token.js'
import { enqueueNotification, recordMutationLedger, withMutationTx } from './mutation-tx.js'
import { listOperatorRecipientUserIds } from './notifications.js'
import { dispatchWorkflowEvent } from './workflow-dispatch.js'
import { PROJECT_LIFECYCLE_COLUMNS, rowToSnapshot, type ProjectLifecycleRow } from './routes/project-lifecycle.js'

export const logger = createLogger('api:estimate-shares')

// Customer-facing URL prefix (React Router route, served by the SPA).
// Used to construct the share_url that's emailed/sent to the recipient.
export const PORTAL_ESTIMATES_PATH_PREFIX = '/portal/estimates/'
// API endpoint prefix (handled by handlePublicEstimateShareRoutes).
export const API_PORTAL_ESTIMATES_PATH_PREFIX = '/api/portal/estimates/'

export type EstimateLineSnapshot = {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
}

export type EstimateSnapshot = {
  bid_total: number
  scope_total: number
  lines: EstimateLineSnapshot[]
  /** ISO timestamp recorded at snapshot time (informational). */
  captured_at: string
}

export type EstimateShareRow = {
  id: string
  company_id: string
  project_id: string
  estimate_snapshot: EstimateSnapshot
  share_token: string
  recipient_email: string | null
  recipient_name: string | null
  sent_at: string
  expires_at: string
  accepted_at: string | null
  declined_at: string | null
  decline_reason: string | null
  viewed_at: string | null
  view_count: number
  signature_data_url: string | null
  signer_name: string | null
  signer_ip: string | null
  // estimate_share workflow columns (migration 115).
  status: string | null
  state_version: number
  message: string | null
  include_signed_link: boolean | null
  revoked_at: string | null
  // Public-surface access audit (migration 011). Distinct from viewed_at/
  // view_count (the customer-funnel "first view" signal): these bump on EVERY
  // public hit — GET view + accept/decline/finalize + capture lifecycle — so a
  // forwarded link shows abnormal access regardless of the terminal funnel
  // state. Surfaced to the owner so they can spot a leaked link.
  last_accessed_at: string | null
  access_count: number
  created_at: string
  updated_at: string
}

export const SHARE_COLUMNS = `
  id, company_id, project_id, estimate_snapshot, share_token,
  recipient_email, recipient_name, sent_at, expires_at,
  accepted_at, declined_at, decline_reason, viewed_at, view_count,
  signature_data_url, signer_name, host(signer_ip) as signer_ip,
  status, state_version, message, include_signed_link, revoked_at,
  last_accessed_at, access_count,
  created_at, updated_at
`

// ---------------------------------------------------------------------------
// Helpers — kept in this module so the auth + portal handlers share one
// view of "valid token + non-expired + still resolvable".
// ---------------------------------------------------------------------------

export type ProjectRow = {
  id: string
  bid_total: number
  lifecycle_state: string
  lifecycle_state_version: number
}

export async function loadProject(
  executor: Pool | PoolClient,
  companyId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await executor.query<{
    id: string
    bid_total: string | number | null
    lifecycle_state: string
    lifecycle_state_version: number
  }>(
    `select id, bid_total, lifecycle_state, lifecycle_state_version
     from projects
     where company_id = $1 and id = $2
     limit 1`,
    [companyId, projectId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    bid_total: Number(row.bid_total ?? 0),
    lifecycle_state: row.lifecycle_state,
    lifecycle_state_version: row.lifecycle_state_version,
  }
}

export async function snapshotEstimate(
  executor: Pool | PoolClient,
  companyId: string,
  projectId: string,
  bidTotal: number,
): Promise<EstimateSnapshot> {
  const result = await executor.query<{
    service_item_code: string
    quantity: string | number
    unit: string
    rate: string | number
    amount: string | number
    division_code: string | null
  }>(
    `select service_item_code, quantity, unit, rate, amount, division_code
     from estimate_lines
     where company_id = $1 and project_id = $2
     order by created_at asc, service_item_code asc`,
    [companyId, projectId],
  )
  const lines: EstimateLineSnapshot[] = result.rows.map((row) => ({
    service_item_code: row.service_item_code,
    quantity: Number(row.quantity),
    unit: row.unit,
    rate: Number(row.rate),
    amount: Number(row.amount),
    division_code: row.division_code,
  }))
  const scopeTotal = lines.reduce((sum, line) => sum + line.amount, 0)
  return {
    bid_total: bidTotal,
    scope_total: Math.round(scopeTotal * 100) / 100,
    lines,
    captured_at: new Date().toISOString(),
  }
}

export type ShareLookupOk = { ok: true; row: EstimateShareRow }
export type ShareLookupErr = { ok: false; status: number; error: string }
export type ShareLookupResult = ShareLookupOk | ShareLookupErr

export function classifyShareForRecipient(
  row: EstimateShareRow | null,
  verify: VerifyShareTokenResult,
): ShareLookupResult {
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  if (!row) return { ok: false, status: 404, error: 'share link not found' }
  // Revocation gate (migration 011): a revoked link is dead — the public
  // surface must reject BEFORE exposing the estimate or accepting an
  // accept/decline/finalize, even if the link has not yet expired. 410 Gone is
  // the right shape (the resource existed and is permanently unavailable). The
  // `status = 'revoked'` workflow column is checked too so a REVOKE that only
  // moved the workflow state still gates.
  if (row.revoked_at || row.status === 'revoked') {
    return { ok: false, status: 410, error: 'share link has been revoked' }
  }
  const expiresMs = new Date(row.expires_at).getTime()
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: 'share link has expired' }
  }
  return { ok: true, row }
}

/**
 * Bump the public-surface access audit on an estimate share link. Called
 * best-effort on every successful public portal hit AFTER the data has been
 * resolved — a cheap UPDATE in its own GUC-bound tx so it never blocks (or
 * fails) the read. `access_count` + `last_accessed_at` give the owner a usage
 * trail to spot a forwarded/leaked link. Swallows its own errors: the customer
 * must still get their estimate even if the audit write hiccups.
 */
export async function recordShareAccess(pool: Pool, row: EstimateShareRow): Promise<void> {
  try {
    await withMutationTx(row.company_id, (c) =>
      c.query(
        `update estimate_share_links
           set access_count = access_count + 1,
               last_accessed_at = now()
         where company_id = $1 and id = $2`,
        [row.company_id, row.id],
      ),
    )
  } catch (err) {
    logger.warn(
      { estimate_share_link_id: row.id, err: err instanceof Error ? err.message : String(err) },
      '[estimate-share] access audit bump failed (non-blocking)',
    )
  }
}

export async function loadShareByToken(
  executor: Pool | PoolClient,
  secret: string,
  token: string,
): Promise<ShareLookupResult> {
  const verify = verifyShareToken(token, secret)
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  const result = await executor.query<EstimateShareRow>(
    `select ${SHARE_COLUMNS}
     from estimate_share_links
     where share_token = $1
     limit 1`,
    [token],
  )
  return classifyShareForRecipient(result.rows[0] ?? null, verify)
}

export async function loadShareByTokenForUpdate(
  client: PoolClient,
  secret: string,
  token: string,
): Promise<ShareLookupResult> {
  const verify = verifyShareToken(token, secret)
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  const result = await client.query<EstimateShareRow>(
    `select ${SHARE_COLUMNS}
     from estimate_share_links
     where share_token = $1
     for update
     limit 1`,
    [token],
  )
  return classifyShareForRecipient(result.rows[0] ?? null, verify)
}

export async function loadProjectAndCompanyForShare(
  pool: Pool,
  row: EstimateShareRow,
): Promise<{ project_name: string; company_name: string; customer_name: string | null }> {
  const result = await pool.query<{
    project_name: string
    company_name: string
    customer_name: string | null
  }>(
    `select p.name as project_name, c.name as company_name, p.customer_name
     from projects p
     join companies c on c.id = p.company_id
     where p.company_id = $1 and p.id = $2
     limit 1`,
    [row.company_id, row.project_id],
  )
  const out = result.rows[0]
  return {
    project_name: out?.project_name ?? 'Estimate',
    company_name: out?.company_name ?? 'Sitelayer',
    customer_name: out?.customer_name ?? null,
  }
}

/**
 * Best-effort operator notification fan-out triggered when a customer
 * opens an estimate share link for the FIRST time. Subsequent views
 * silently update view_count + viewed_at without re-notifying — the
 * caller establishes "first view" via the prev_viewed_at CTE so this
 * helper just delivers.
 *
 * We don't await individual enqueue failures because the parent
 * function already wraps the fan-out in a `.catch(() => undefined)`:
 * the share view succeeds even if every notification fails. Per-row
 * errors are logged through `enqueueNotification` (mutation-tx).
 */
export async function fanOutFirstViewNotification(
  pool: Pool,
  row: EstimateShareRow,
  meta: { project_name: string; customer_name: string | null },
): Promise<void> {
  const customerLabel =
    row.recipient_name?.trim() || meta.customer_name?.trim() || row.recipient_email?.trim() || 'A customer'
  const subject = 'Customer viewed estimate'
  const bodyText = `${customerLabel} opened the estimate for ${meta.project_name}`
  const payload = {
    estimate_share_id: row.id,
    project_id: row.project_id,
    project_name: meta.project_name,
    customer_name: meta.customer_name,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    link_target: `/projects/${row.project_id}?tab=estimate`,
  }
  const recipients = await listOperatorRecipientUserIds(pool, row.company_id)
  if (recipients.length === 0) {
    // Broadcast row — worker logs via the console provider. Keeps the
    // signal visible even on a company that hasn't seated admin/office.
    await enqueueNotification({
      companyId: row.company_id,
      kind: 'estimate_share_viewed',
      subject,
      text: bodyText,
      payload,
    })
    return
  }
  for (const recipientUserId of recipients) {
    await enqueueNotification({
      companyId: row.company_id,
      recipientUserId,
      kind: 'estimate_share_viewed',
      subject,
      text: bodyText,
      payload,
    })
  }
}

export function shareStatus(row: EstimateShareRow): 'accepted' | 'declined' | 'expired' | 'revoked' | 'pending' {
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (row.revoked_at || row.status === 'revoked') return 'revoked'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired'
  return 'pending'
}

/**
 * Funnel status surfaced in the company-wide "estimates sent" timeline.
 * Distinct from `shareStatus` because the timeline cares about the
 * intermediate "viewed but not yet decided" state — the per-recipient
 * portal payload collapses that into `pending` (the customer doesn't
 * need to know about their own view bump).
 */
export type TimelineStatus = 'accepted' | 'declined' | 'expired' | 'revoked' | 'viewed' | 'sent'

export function computeTimelineStatus(row: {
  accepted_at: string | null
  declined_at: string | null
  expires_at: string
  viewed_at: string | null
  revoked_at?: string | null
  status?: string | null
}): TimelineStatus {
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (row.revoked_at || row.status === 'revoked') return 'revoked'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired'
  if (row.viewed_at) return 'viewed'
  return 'sent'
}

export function buildPortalView(row: EstimateShareRow, meta: { project_name: string; company_name: string }) {
  return {
    id: row.id,
    project_name: meta.project_name,
    company_name: meta.company_name,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    sent_at: row.sent_at,
    expires_at: row.expires_at,
    status: shareStatus(row),
    estimate: row.estimate_snapshot,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    decline_reason: row.decline_reason,
    signer_name: row.signer_name,
    // Don't return the signature image to viewers; only the existence
    // is surfaced via signer_name + accepted_at. The original image is
    // available to authenticated company users only (read direct from
    // the row).
  }
}

export function buildShareUrl(portalBaseUrl: string, token: string): string {
  const trimmed = portalBaseUrl.replace(/\/$/, '')
  return `${trimmed}${PORTAL_ESTIMATES_PATH_PREFIX}${encodeURIComponent(token)}`
}

// ---------------------------------------------------------------------------
// Lifecycle helper — best-effort transition routed through the SAME
// registered reducer + dispatch primitive the canonical lifecycle route uses
// (`apps/api/src/routes/project-lifecycle.ts`; reducer in
// `packages/workflows/src/project-lifecycle.ts`). This previously hand-rolled
// a parallel SEND/ACCEPT/DECLINE transition table and a hand-built
// `snapshot_after`, which silently dropped fields the reducer carries forward
// (e.g. `sent_at` on ACCEPT) and so wrote replay-divergent `workflow_event_log`
// rows for portal-driven lifecycle events. It now delegates to
// `dispatchWorkflowEvent`, so the share path and the staff route emit
// byte-identical event-log rows and stay replay-equal.
//
// Still "best-effort": the portal visitor holds no `state_version`, so we act
// on whatever the locked row currently is, and an illegal transition (the
// project isn't in the expected `from` state) is a logged no-op rather than an
// error — the share row remains the source of truth.
// ---------------------------------------------------------------------------

export type LifecycleEventKind = 'SEND' | 'ACCEPT' | 'DECLINE'

export type LifecycleApplyResult =
  | { kind: 'applied'; toState: string }
  | { kind: 'transition_failed'; fromState: string }
  | { kind: 'project_not_found' }

function buildLifecycleEvent(
  eventType: LifecycleEventKind,
  actorUserId: string,
  occurredAt: string,
  reason: string | undefined,
): ProjectLifecycleWorkflowEvent {
  if (eventType === 'DECLINE') {
    return reason !== undefined
      ? { type: 'DECLINE', actor_user_id: actorUserId, occurred_at: occurredAt, reason }
      : { type: 'DECLINE', actor_user_id: actorUserId, occurred_at: occurredAt }
  }
  return { type: eventType, actor_user_id: actorUserId, occurred_at: occurredAt }
}

export async function maybeApplyLifecycleEvent(
  client: PoolClient,
  args: {
    companyId: string
    projectId: string
    eventType: LifecycleEventKind
    actorUserId: string
    reason?: string
  },
): Promise<LifecycleApplyResult> {
  // The portal/admin share path supplies no client `state_version`, so read
  // the current row under the lock and echo its version as the expected one —
  // the optimistic check inside dispatchWorkflowEvent then can't conflict.
  const locked = await client.query<ProjectLifecycleRow>(
    `select ${PROJECT_LIFECYCLE_COLUMNS}
       from projects
      where company_id = $1 and id = $2 and deleted_at is null
      for update`,
    [args.companyId, args.projectId],
  )
  const current = locked.rows[0]
  if (!current) return { kind: 'project_not_found' }
  const occurredAt = new Date().toISOString()

  const result = await dispatchWorkflowEvent<
    ProjectLifecycleRow,
    ProjectLifecycleWorkflowSnapshot,
    ProjectLifecycleWorkflowEvent
  >(client, {
    definition: projectLifecycleWorkflow,
    companyId: args.companyId,
    entityType: 'project',
    entityId: args.projectId,
    expectedStateVersion: current.lifecycle_state_version,
    actorUserId: args.actorUserId,
    // Row is already locked above; just shape it for the primitive.
    loadSnapshot: async () => ({ row: current, snapshot: rowToSnapshot(current) }),
    buildEvent: () => buildLifecycleEvent(args.eventType, args.actorUserId, occurredAt, args.reason),
    persist: async (c, nextSnapshot) => {
      const updated = await c.query<ProjectLifecycleRow>(
        `update projects
            set lifecycle_state = $3,
                lifecycle_state_version = $4,
                lifecycle_sent_at = $5,
                lifecycle_accepted_at = $6,
                lifecycle_declined_at = $7,
                lifecycle_decline_reason = $8,
                lifecycle_started_at = $9,
                lifecycle_completed_at = $10,
                lifecycle_archived_at = $11,
                updated_at = now()
          where company_id = $1 and id = $2
          returning ${PROJECT_LIFECYCLE_COLUMNS}`,
        [
          args.companyId,
          args.projectId,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.sent_at ?? null,
          nextSnapshot.accepted_at ?? null,
          nextSnapshot.declined_at ?? null,
          nextSnapshot.decline_reason ?? null,
          nextSnapshot.started_at ?? null,
          nextSnapshot.completed_at ?? null,
          nextSnapshot.archived_at ?? null,
        ],
      )
      const row = updated.rows[0]
      if (!row) throw new Error('project lifecycle update returned no row')
      return row
    },
    // Mirror the canonical route's ACCEPT side effect so a portal accept
    // enqueues the same foreman-assignment notification a staff-driven ACCEPT
    // would. Per-state_version idempotency key matches the route shape so a
    // retry/duplicate ACCEPT upserts one outbox row.
    sideEffects: async (c, _next, updated) => {
      if (args.eventType !== 'ACCEPT') return
      await recordMutationLedger(c, {
        companyId: args.companyId,
        entityType: 'project',
        entityId: updated.id,
        action: 'notify_foreman_accepted',
        mutationType: 'notify_foreman_assignment',
        row: updated,
        outboxPayload: {
          project_id: updated.id,
          project_name: updated.name,
          customer_name: updated.customer_name,
          transition: 'accepted',
          actor_user_id: args.actorUserId,
          occurred_at: occurredAt,
        },
        idempotencyKey: `project_lifecycle:notify_foreman:${updated.id}:${updated.lifecycle_state_version}`,
      })
    },
  })

  if (result.kind === 'not_found') return { kind: 'project_not_found' }
  if (result.kind === 'version_conflict' || result.kind === 'illegal_transition') {
    return { kind: 'transition_failed', fromState: result.snapshot.state }
  }
  return { kind: 'applied', toState: result.snapshot.state }
}

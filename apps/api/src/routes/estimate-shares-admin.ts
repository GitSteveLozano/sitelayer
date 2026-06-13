import type http from 'node:http'
import type { Pool } from 'pg'
import {
  ESTIMATE_SHARE_WORKFLOW_NAME,
  ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION,
  transitionEstimateShareWorkflow,
  type EstimateShareWorkflowEvent,
  type EstimateShareWorkflowSnapshot,
} from '@sitelayer/workflows'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { generateShareToken } from '../estimate-share-token.js'
import { HttpError, parseJsonBody } from '../http-utils.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import {
  PORTAL_ESTIMATES_PATH_PREFIX,
  SHARE_COLUMNS,
  buildShareUrl,
  computeTimelineStatus,
  loadProject,
  logger,
  maybeApplyLifecycleEvent,
  shareStatus,
  snapshotEstimate,
  type EstimateShareRow,
} from '../estimate-share-helpers.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

/** Map a DB share row to the estimate_share workflow snapshot the reducer
 * expects. The `status` column may be null on a row written before migration
 * 115's backfill ran (no-op in tests / pre-cutover prod), so default it to the
 * derived `sent`-ish baseline via shareStatus(). */
function shareRowToSnapshot(row: EstimateShareRow): EstimateShareWorkflowSnapshot {
  const derived = shareStatus(row)
  const state = (row.status ?? (derived === 'pending' ? 'sent' : derived)) as EstimateShareWorkflowSnapshot['state']
  return {
    state,
    state_version: row.state_version ?? 1,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    message: row.message,
    include_signed_link: row.include_signed_link,
    sent_at: row.sent_at,
    expires_at: row.expires_at,
    viewed_at: row.viewed_at,
    view_count: row.view_count,
    accepted_at: row.accepted_at,
    signer_name: row.signer_name,
    declined_at: row.declined_at,
    decline_reason: row.decline_reason,
    revoked_at: row.revoked_at,
  }
}

/**
 * Sales Loop (Loop 5) — estimator → client share + accept/decline.
 *
 * Surface (authenticated):
 *   POST /api/projects/:id/estimate/share
 *     body: { recipient_email, recipient_name?, expires_in_days? }
 *     → snapshot the project's current estimate_lines + bid_total,
 *       generate a HMAC share token, persist the row, and return
 *       { share_token, share_url, expires_at, id }. If the project
 *       is in lifecycle_state='estimating', also dispatch a SEND
 *       event so the project moves to 'sent'. (No-op when the project
 *       is already past 'estimating' — the link is the artifact, the
 *       lifecycle transition is best-effort.)
 *
 *   GET /api/projects/:id/estimate/shares
 *     → list shares for this project, most-recent first.
 *
 *   POST /api/estimate-shares/:id/revoke
 *     → set expires_at = now() so subsequent portal lookups 410.
 *
 * Public surface (no Clerk auth, see handlePublicEstimateShareRoutes):
 *   GET  /api/portal/estimates/:share_token
 *   POST /api/portal/estimates/:share_token/accept
 *   POST /api/portal/estimates/:share_token/decline
 *
 * The CUSTOMER-FACING URL stays /portal/estimates/:share_token (a React
 * Router route in apps/web/src/portal/EstimateView.tsx). The React screen
 * fetches the API endpoints under /api/portal/* — Caddy routes /api/* to
 * the API container, so the API surface MUST live under /api/* to be
 * reachable through the production reverse proxy.
 */

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

// POST /api/projects/:id/estimate/share wire-format. Permissive: the route
// already trims + validates recipient_email and bounds expires_in_days; the
// schema only rejects malformed field *shapes* up front. expires_in_days is
// string-or-number to match the legacy `Number(rawExpiry)` coercion.
const EstimateShareCreateBodySchema = z
  .object({
    recipient_email: z.string().optional(),
    recipient_name: z.string().optional(),
    message: z.string().nullish(),
    include_signed_link: z.boolean().nullish(),
    expires_in_days: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

export type EstimateShareRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /** HMAC secret used to sign share tokens. Resolved at server boot. */
  shareSecret: string
  /** Public URL the portal lives under, e.g. https://app.example.com */
  portalBaseUrl: string
}

export async function handleEstimateShareRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: EstimateShareRouteCtx,
): Promise<boolean> {
  // POST /api/projects/:id/estimate/share — create a share + (best-effort) SEND
  const createMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate\/share$/)
  if (req.method === 'POST' && createMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = createMatch[1] ?? ''
    const parsedBody = parseJsonBody(EstimateShareCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const recipient_email = typeof body.recipient_email === 'string' ? body.recipient_email.trim() : ''
    const recipient_name = typeof body.recipient_name === 'string' ? body.recipient_name.trim() : ''
    // Compose fields (D10 SEND-TO-CLIENT composer). message is the editable
    // note; include_signed_link toggles the signable portal link + open
    // tracking. Both are persisted on the share row (migration 115) and carried
    // in the SEND workflow event so the send intent is part of the event log.
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : null
    const include_signed_link = body.include_signed_link === undefined ? true : Boolean(body.include_signed_link)
    const rawExpiry = body.expires_in_days
    let expires_in_days = 30
    if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
      const num = Number(rawExpiry)
      if (!Number.isFinite(num) || num <= 0 || num > 365) {
        ctx.sendJson(400, { error: 'expires_in_days must be a positive number ≤ 365' })
        return true
      }
      expires_in_days = Math.floor(num)
    }
    if (!recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) {
      ctx.sendJson(400, { error: 'recipient_email must be a valid email address' })
      return true
    }

    const result = await withMutationTx(async (client) => {
      const project = await loadProject(client, ctx.company.id, projectId)
      if (!project) return { kind: 'not_found' as const }

      const snapshot = await snapshotEstimate(client, ctx.company.id, projectId, project.bid_total)
      if (snapshot.lines.length === 0 && snapshot.bid_total <= 0) {
        return { kind: 'no_lines' as const }
      }

      const { token } = generateShareToken(ctx.shareSecret)

      // The row is CREATED directly in the workflow's initial state `sent`
      // (state_version 1) — the SEND compose step is the row-creation seed, not
      // a reducer transition (see packages/workflows/src/estimate-share.ts).
      const insertResult = await client.query<EstimateShareRow>(
        `insert into estimate_share_links (
           company_id, project_id, estimate_snapshot, share_token,
           recipient_email, recipient_name, sent_at, expires_at,
           status, state_version, message, include_signed_link
         )
         values (
           $1, $2, $3::jsonb, $4, $5, $6, now(), now() + ($7 || ' days')::interval,
           'sent', 1, $8, $9
         )
         returning ${SHARE_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          JSON.stringify(snapshot),
          token,
          recipient_email,
          recipient_name || null,
          String(expires_in_days),
          message,
          include_signed_link,
        ],
      )
      const row = insertResult.rows[0]
      if (!row) throw new HttpError(500, 'estimate share link insert returned no row')

      // Record the SEND in the workflow_event_log (state_version 0 → the seeded
      // `sent`/v1 row) so the estimate_share workflow has the same append-only
      // creation event every other workflow records outside the reducer.
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: ESTIMATE_SHARE_WORKFLOW_NAME,
        schemaVersion: ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION,
        entityType: 'estimate_share_link',
        entityId: row.id,
        stateVersion: 0,
        eventType: 'SEND',
        eventPayload: {
          type: 'SEND',
          recipient_email,
          recipient_name: recipient_name || null,
          message,
          include_signed_link,
          actor_user_id: ctx.currentUserId,
          sent_at: row.sent_at,
        },
        snapshotAfter: shareRowToSnapshot(row),
        actorUserId: ctx.currentUserId,
      })

      // Enqueue the `send_estimate_share` side-effect (the registered workflow
      // side-effect type). Idempotency key per share row so a replayed SEND
      // upserts the same outbox row. Delivered by the dedicated worker runner
      // apps/worker/src/runners/estimate-share-email.ts, which emails the
      // recipient their portal link; the mutation_type is registered in
      // DEDICATED_HANDLER_MUTATION_TYPES (@sitelayer/queue) so the generic
      // apply-with-no-work drain can never stamp it 'applied' without sending.
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'estimate_share_link',
        entityId: row.id,
        action: 'send_estimate_share',
        mutationType: 'send_estimate_share',
        row: { ...row, share_token: '[redacted]' },
        outboxPayload: {
          estimate_share_link_id: row.id,
          project_id: row.project_id,
          recipient_email,
          recipient_name: recipient_name || null,
          message,
          include_signed_link,
          share_url_path: `${PORTAL_ESTIMATES_PATH_PREFIX}${row.share_token}`,
        },
        idempotencyKey: `estimate_share:send:${row.id}`,
        actorUserId: ctx.currentUserId,
      })

      // Best-effort lifecycle SEND. Only fires if the project is at
      // 'estimating'; otherwise we leave the lifecycle alone — the link
      // is the artifact, the workflow is downstream.
      const lifecycleResult = await maybeApplyLifecycleEvent(client, {
        companyId: ctx.company.id,
        projectId,
        eventType: 'SEND',
        actorUserId: ctx.currentUserId,
      })
      if (lifecycleResult.kind === 'transition_failed') {
        logger.warn(
          { project_id: projectId, lifecycle_state: lifecycleResult.fromState, event: 'SEND' },
          '[estimate-share] lifecycle SEND skipped — illegal transition',
        )
      }

      return { kind: 'ok' as const, row }
    })

    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    if (result.kind === 'no_lines') {
      ctx.sendJson(409, { error: 'project has no estimate lines or bid_total to share' })
      return true
    }

    const row = result.row
    ctx.sendJson(201, {
      id: row.id,
      share_token: row.share_token,
      share_url: buildShareUrl(ctx.portalBaseUrl, row.share_token),
      expires_at: row.expires_at,
      sent_at: row.sent_at,
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
    })
    return true
  }

  // GET /api/projects/:id/estimate/shares — list per-project shares
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate\/shares$/)
  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1] ?? ''
    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<EstimateShareRow>(
        `select ${SHARE_COLUMNS}
       from estimate_share_links
       where company_id = $1 and project_id = $2
       order by sent_at desc
       limit 100`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, {
      shares: rows.rows.map((row) => ({
        id: row.id,
        recipient_email: row.recipient_email,
        recipient_name: row.recipient_name,
        sent_at: row.sent_at,
        expires_at: row.expires_at,
        accepted_at: row.accepted_at,
        declined_at: row.declined_at,
        decline_reason: row.decline_reason,
        viewed_at: row.viewed_at,
        view_count: row.view_count,
        // Public-surface access audit (migration 011) — usage the owner can
        // review to spot a forwarded/leaked link.
        last_accessed_at: row.last_accessed_at,
        access_count: row.access_count,
        revoked_at: row.revoked_at,
        status: shareStatus(row),
        // Don't leak the token in list responses; the caller already has it.
        share_url_path: `${PORTAL_ESTIMATES_PATH_PREFIX}${row.share_token}`,
      })),
    })
    return true
  }

  // GET /api/estimate-shares — company-scoped timeline of "estimates sent"
  // (one row per project, latest share). Powers the Estimates · Sent
  // screen surfaced from the Projects tab. Admin/office-only because it
  // exposes recipient_email + signer_name across every project in the
  // company.
  if (req.method === 'GET' && url.pathname === '/api/estimate-shares') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{
        id: string
        project_id: string
        project_name: string
        customer_name: string | null
        bid_total: string | number | null
        recipient_email: string | null
        recipient_name: string | null
        sent_at: string
        expires_at: string
        accepted_at: string | null
        declined_at: string | null
        decline_reason: string | null
        viewed_at: string | null
        view_count: number
        signer_name: string | null
        revoked_at: string | null
        last_accessed_at: string | null
        access_count: number
        status: string | null
      }>(
        `with latest as (
         select distinct on (project_id)
           id, project_id, recipient_email, recipient_name, sent_at,
           expires_at, accepted_at, declined_at, decline_reason,
           viewed_at, view_count, signer_name, revoked_at,
           last_accessed_at, access_count, status
         from estimate_share_links
         where company_id = $1
         order by project_id, sent_at desc
       )
       select l.id, l.project_id,
              p.name as project_name,
              p.customer_name,
              p.bid_total,
              l.recipient_email, l.recipient_name,
              l.sent_at, l.expires_at,
              l.accepted_at, l.declined_at, l.decline_reason,
              l.viewed_at, l.view_count, l.signer_name,
              l.revoked_at, l.last_accessed_at, l.access_count, l.status
       from latest l
       join projects p on p.id = l.project_id and p.company_id = $1
       order by l.sent_at desc
       limit 200`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, {
      shares: result.rows.map((row) => {
        const status = computeTimelineStatus(row)
        return {
          id: row.id,
          project_id: row.project_id,
          project_name: row.project_name,
          customer_name: row.customer_name,
          bid_total: Number(row.bid_total ?? 0),
          recipient_email: row.recipient_email,
          recipient_name: row.recipient_name,
          sent_at: row.sent_at,
          expires_at: row.expires_at,
          accepted_at: row.accepted_at,
          declined_at: row.declined_at,
          decline_reason: row.decline_reason,
          viewed_at: row.viewed_at,
          view_count: row.view_count,
          signer_name: row.signer_name,
          last_accessed_at: row.last_accessed_at,
          access_count: row.access_count,
          revoked_at: row.revoked_at,
          status,
        }
      }),
    })
    return true
  }

  // POST /api/estimate-shares/:id/revoke — invalidate a share, dispatched
  // through the estimate_share reducer (REVOKE) so the transition is the pure
  // registered one + recorded in the workflow_event_log like every other
  // workflow. Also expires the link (expires_at = now()) so the portal 410s.
  const revokeMatch = url.pathname.match(/^\/api\/estimate-shares\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = revokeMatch[1] ?? ''
    // The revoke surface takes no client-supplied state_version — the legacy
    // path locked the row and dispatched REVOKE against whatever version it
    // found. Capture the locked row's own state_version and feed it back as
    // the "expected" version so the primitive's post-lock optimistic check is
    // a no-op (same mutable-slot pattern as the legacy /submit alias in
    // daily-logs.ts). The reducer event's clock lives in buildEvent; the
    // persist fallback needs the same timestamp, so it travels by closure.
    let resolvedExpected = -1
    let revokedAt = ''
    const result = await withMutationTx((client) =>
      dispatchWorkflowEvent<EstimateShareRow, EstimateShareWorkflowSnapshot, EstimateShareWorkflowEvent>(client, {
        definition: {
          name: ESTIMATE_SHARE_WORKFLOW_NAME,
          schemaVersion: ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION,
          reduce: transitionEstimateShareWorkflow,
        },
        companyId: ctx.company.id,
        entityType: 'estimate_share_link',
        entityId: id,
        get expectedStateVersion() {
          return resolvedExpected
        },
        actorUserId: ctx.currentUserId,
        loadSnapshot: async (c) => {
          const lockedResult = await c.query<EstimateShareRow>(
            `select ${SHARE_COLUMNS}
             from estimate_share_links
             where company_id = $1 and id = $2
             for update`,
            [ctx.company.id, id],
          )
          const current = lockedResult.rows[0]
          if (!current) return null
          const snapshot = shareRowToSnapshot(current)
          resolvedExpected = snapshot.state_version
          return { row: current, snapshot }
        },
        buildEvent: () => {
          revokedAt = new Date().toISOString()
          return { type: 'REVOKE', revoked_at: revokedAt, revoked_by: ctx.currentUserId }
        },
        persist: async (c, next) => {
          const updateResult = await c.query<EstimateShareRow>(
            `update estimate_share_links
               set status = $3,
                   state_version = $4,
                   revoked_at = $5,
                   expires_at = now(),
                   updated_at = now()
             where company_id = $1 and id = $2
             returning ${SHARE_COLUMNS}`,
            [ctx.company.id, id, next.state, next.state_version, next.revoked_at ?? revokedAt],
          )
          const row = updateResult.rows[0]
          if (!row) throw new HttpError(500, 'estimate share revoke update returned no row')
          return row
        },
        sideEffects: async (c, _next, row) => {
          await recordMutationLedger(c, {
            companyId: ctx.company.id,
            entityType: 'estimate_share_link',
            entityId: row.id,
            action: 'revoked',
            row: { id: row.id, project_id: row.project_id, revoked_at: row.revoked_at },
            idempotencyKey: `estimate_share_link:revoked:${row.id}`,
            actorUserId: ctx.currentUserId,
          })
        },
      }),
    )

    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'share not found' })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: result.message })
      return true
    }
    // version_conflict is unreachable: expectedStateVersion is resolved from
    // the locked row itself, so the check always passes (legacy had no
    // optimistic check on this surface either).
    ctx.sendJson(200, {
      id: result.row.id,
      expires_at: result.row.expires_at,
      revoked_at: result.row.revoked_at,
      status: 'revoked',
    })
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `estimate-shares-admin` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const estimateSharesAdminRouteDescriptor: DispatchRouteDescriptor = {
  name: 'estimate-shares-admin',
  order: 720,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, ctx }) =>
    handleEstimateShareRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      shareSecret: ctx.estimateShareConfig.secret,
      portalBaseUrl: ctx.estimateShareConfig.portalBaseUrl,
    }),
}

import type http from 'node:http'
import type { Pool } from 'pg'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import {
  API_PORTAL_ESTIMATES_PATH_PREFIX,
  SHARE_COLUMNS,
  buildPortalView,
  fanOutFirstViewNotification,
  loadProjectAndCompanyForShare,
  loadShareByToken,
  loadShareByTokenForUpdate,
  logger,
  maybeApplyLifecycleEvent,
  type EstimateShareRow,
} from '../estimate-share-helpers.js'

// ---------------------------------------------------------------------------
// Public (portal) routes — no Clerk auth, no company scoping by header.
// ---------------------------------------------------------------------------

export type PublicEstimateShareCtx = {
  pool: Pool
  shareSecret: string
  /** Resolve the inbound IP for audit (X-Forwarded-For first hop). */
  resolveClientIp: () => string | null
  /** Same JSON body parser used by authenticated routes. */
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * Returns true when the request was a portal route and was handled.
 * Returning false leaves the request to fall through to the rest of
 * the public-routes / auth dispatch (it won't match any other handler
 * either, so the caller will 404 — but the boolean shape mirrors the
 * other modules).
 */
export async function handlePublicEstimateShareRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PublicEstimateShareCtx,
): Promise<boolean> {
  if (!url.pathname.startsWith(API_PORTAL_ESTIMATES_PATH_PREFIX)) return false

  // GET /api/portal/estimates/:token
  const getMatch = url.pathname.match(/^\/api\/portal\/estimates\/([^/]+)$/)
  if (req.method === 'GET' && getMatch) {
    const token = decodeURIComponent(getMatch[1] ?? '')
    const lookup = await loadShareByToken(ctx.pool, ctx.shareSecret, token)
    if (!lookup.ok) {
      ctx.sendJson(lookup.status, { error: lookup.error })
      return true
    }
    const { row } = lookup
    // Lazy first-view stamp + view_count bump. Don't bump for terminal
    // states — once a customer has accepted/declined the link is mostly
    // a record, not an active funnel step. The CTE captures the previous
    // viewed_at atomically so we can fan a "first view" operator
    // notification exactly once even under concurrent portal hits — the
    // first writer sees prev_viewed_at = NULL, every racing writer sees
    // the timestamp the first writer just stamped.
    let firstView = false
    if (!row.accepted_at && !row.declined_at) {
      const updateResult = await withMutationTx(row.company_id, (c) =>
        c.query<{ prev_viewed_at: string | null }>(
          `with prev as (
           select viewed_at as prev_viewed_at
           from estimate_share_links
           where id = $1
           for update
         )
         update estimate_share_links
           set viewed_at = coalesce(viewed_at, now()),
               view_count = view_count + 1,
               updated_at = now()
         where id = $1
         returning (select prev_viewed_at from prev) as prev_viewed_at`,
          [row.id],
        ),
      )
      firstView = updateResult.rows[0]?.prev_viewed_at == null
    }
    const meta = await loadProjectAndCompanyForShare(ctx.pool, row)
    if (firstView) {
      // Best-effort operator notification — failures are swallowed by
      // enqueueNotification (logged via mutation-tx) so the customer's
      // portal load is never blocked by a notification hiccup.
      await fanOutFirstViewNotification(ctx.pool, row, meta).catch(() => undefined)
    }
    ctx.sendJson(200, buildPortalView(row, meta))
    return true
  }

  // POST /api/portal/estimates/:token/accept
  const acceptMatch = url.pathname.match(/^\/api\/portal\/estimates\/([^/]+)\/accept$/)
  if (req.method === 'POST' && acceptMatch) {
    const token = decodeURIComponent(acceptMatch[1] ?? '')
    const body = await ctx.readBody()
    const signer_name = typeof body.signer_name === 'string' ? body.signer_name.trim() : ''
    const signature_data_url = typeof body.signature_data_url === 'string' ? body.signature_data_url.trim() : ''
    if (!signer_name) {
      ctx.sendJson(400, { error: 'signer_name is required' })
      return true
    }
    if (!signature_data_url || !signature_data_url.startsWith('data:image/')) {
      ctx.sendJson(400, { error: 'signature_data_url must be a data:image/* URL' })
      return true
    }
    if (signature_data_url.length > 1_500_000) {
      ctx.sendJson(413, { error: 'signature_data_url too large (max 1.5MB)' })
      return true
    }

    const ip = ctx.resolveClientIp()

    const result = await withMutationTx(async (client) => {
      const lookup = await loadShareByTokenForUpdate(client, ctx.shareSecret, token)
      if (!lookup.ok) return { kind: 'invalid' as const, status: lookup.status, error: lookup.error }
      const { row } = lookup

      // Idempotent: if already accepted, return the existing accepted_at.
      if (row.accepted_at) {
        return { kind: 'already_accepted' as const, row }
      }
      if (row.declined_at) {
        return { kind: 'already_declined' as const, row }
      }

      const updated = await client.query<EstimateShareRow>(
        `update estimate_share_links
           set accepted_at = now(),
               signer_name = $2,
               signature_data_url = $3,
               signer_ip = $4::inet,
               updated_at = now(),
               viewed_at = coalesce(viewed_at, now())
         where id = $1
         returning ${SHARE_COLUMNS}`,
        [row.id, signer_name, signature_data_url, ip],
      )
      const next = updated.rows[0]!

      await recordMutationLedger(client, {
        companyId: row.company_id,
        entityType: 'estimate_share_link',
        entityId: row.id,
        action: 'accepted',
        row: {
          id: row.id,
          project_id: row.project_id,
          accepted_at: next.accepted_at,
          signer_name: next.signer_name,
        },
        idempotencyKey: `estimate_share_link:accepted:${row.id}`,
        actorUserId: null,
      })

      const lifecycleResult = await maybeApplyLifecycleEvent(client, {
        companyId: row.company_id,
        projectId: row.project_id,
        eventType: 'ACCEPT',
        actorUserId: 'portal',
      })
      if (lifecycleResult.kind === 'transition_failed') {
        logger.warn(
          { project_id: row.project_id, lifecycle_state: lifecycleResult.fromState, event: 'ACCEPT' },
          '[estimate-share] lifecycle ACCEPT skipped — illegal transition',
        )
      }

      return { kind: 'ok' as const, row: next }
    })

    if (result.kind === 'invalid') {
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    if (result.kind === 'already_declined') {
      ctx.sendJson(409, { error: 'estimate was already declined', declined_at: result.row.declined_at })
      return true
    }
    if (result.kind === 'already_accepted') {
      ctx.sendJson(200, {
        ok: true,
        accepted_at: result.row.accepted_at,
        signer_name: result.row.signer_name,
        idempotent: true,
      })
      return true
    }
    ctx.sendJson(200, {
      ok: true,
      accepted_at: result.row.accepted_at,
      signer_name: result.row.signer_name,
      idempotent: false,
    })
    return true
  }

  // POST /api/portal/estimates/:token/decline
  const declineMatch = url.pathname.match(/^\/api\/portal\/estimates\/([^/]+)\/decline$/)
  if (req.method === 'POST' && declineMatch) {
    const token = decodeURIComponent(declineMatch[1] ?? '')
    const body = await ctx.readBody()
    const decline_reason = typeof body.decline_reason === 'string' ? body.decline_reason.trim().slice(0, 2000) : ''
    if (!decline_reason) {
      ctx.sendJson(400, { error: 'decline_reason is required' })
      return true
    }

    const result = await withMutationTx(async (client) => {
      const lookup = await loadShareByTokenForUpdate(client, ctx.shareSecret, token)
      if (!lookup.ok) return { kind: 'invalid' as const, status: lookup.status, error: lookup.error }
      const { row } = lookup
      if (row.declined_at) {
        return { kind: 'already_declined' as const, row }
      }
      if (row.accepted_at) {
        return { kind: 'already_accepted' as const, row }
      }

      const updated = await client.query<EstimateShareRow>(
        `update estimate_share_links
           set declined_at = now(),
               decline_reason = $2,
               updated_at = now(),
               viewed_at = coalesce(viewed_at, now())
         where id = $1
         returning ${SHARE_COLUMNS}`,
        [row.id, decline_reason],
      )
      const next = updated.rows[0]!

      await recordMutationLedger(client, {
        companyId: row.company_id,
        entityType: 'estimate_share_link',
        entityId: row.id,
        action: 'declined',
        row: {
          id: row.id,
          project_id: row.project_id,
          declined_at: next.declined_at,
          decline_reason: next.decline_reason,
        },
        idempotencyKey: `estimate_share_link:declined:${row.id}`,
        actorUserId: null,
      })

      const lifecycleResult = await maybeApplyLifecycleEvent(client, {
        companyId: row.company_id,
        projectId: row.project_id,
        eventType: 'DECLINE',
        actorUserId: 'portal',
        reason: decline_reason,
      })
      if (lifecycleResult.kind === 'transition_failed') {
        logger.warn(
          { project_id: row.project_id, lifecycle_state: lifecycleResult.fromState, event: 'DECLINE' },
          '[estimate-share] lifecycle DECLINE skipped — illegal transition',
        )
      }

      return { kind: 'ok' as const, row: next }
    })

    if (result.kind === 'invalid') {
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    if (result.kind === 'already_accepted') {
      ctx.sendJson(409, { error: 'estimate was already accepted', accepted_at: result.row.accepted_at })
      return true
    }
    if (result.kind === 'already_declined') {
      ctx.sendJson(200, {
        ok: true,
        declined_at: result.row.declined_at,
        decline_reason: result.row.decline_reason,
        idempotent: true,
      })
      return true
    }
    ctx.sendJson(200, {
      ok: true,
      declined_at: result.row.declined_at,
      decline_reason: result.row.decline_reason,
      idempotent: false,
    })
    return true
  }

  return false
}

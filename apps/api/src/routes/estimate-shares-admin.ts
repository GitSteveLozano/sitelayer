import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { generateShareToken } from '../estimate-share-token.js'
import { HttpError } from '../http-utils.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
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
    const body = await ctx.readBody()
    const recipient_email = typeof body.recipient_email === 'string' ? body.recipient_email.trim() : ''
    const recipient_name = typeof body.recipient_name === 'string' ? body.recipient_name.trim() : ''
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

      const insertResult = await client.query<EstimateShareRow>(
        `insert into estimate_share_links (
           company_id, project_id, estimate_snapshot, share_token,
           recipient_email, recipient_name, sent_at, expires_at
         )
         values (
           $1, $2, $3::jsonb, $4, $5, $6, now(), now() + ($7 || ' days')::interval
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
        ],
      )
      const row = insertResult.rows[0]
      if (!row) throw new HttpError(500, 'estimate share link insert returned no row')

      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'estimate_share_link',
        entityId: row.id,
        action: 'created',
        row: { ...row, share_token: '[redacted]' },
        idempotencyKey: `estimate_share_link:created:${row.id}`,
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
      }>(
        `with latest as (
         select distinct on (project_id)
           id, project_id, recipient_email, recipient_name, sent_at,
           expires_at, accepted_at, declined_at, decline_reason,
           viewed_at, view_count, signer_name
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
              l.viewed_at, l.view_count, l.signer_name
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
          status,
        }
      }),
    })
    return true
  }

  // POST /api/estimate-shares/:id/revoke — invalidate a share
  const revokeMatch = url.pathname.match(/^\/api\/estimate-shares\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = revokeMatch[1] ?? ''
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query<EstimateShareRow>(
        `update estimate_share_links
         set expires_at = now(), updated_at = now()
       where company_id = $1 and id = $2
       returning ${SHARE_COLUMNS}`,
        [ctx.company.id, id],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'share not found' })
      return true
    }
    ctx.sendJson(200, {
      id: row.id,
      expires_at: row.expires_at,
      status: 'revoked',
    })
    return true
  }

  return false
}

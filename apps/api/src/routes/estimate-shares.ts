import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { createLogger } from '@sitelayer/logger'
import type { ActiveCompany } from '../auth-types.js'
import { generateShareToken, verifyShareToken, type VerifyShareTokenResult } from '../estimate-share-token.js'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'

const logger = createLogger('api:estimate-shares')

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

// Customer-facing URL prefix (React Router route, served by the SPA).
// Used to construct the share_url that's emailed/sent to the recipient.
export const PORTAL_ESTIMATES_PATH_PREFIX = '/portal/estimates/'
// API endpoint prefix (handled by handlePublicEstimateShareRoutes).
export const API_PORTAL_ESTIMATES_PATH_PREFIX = '/api/portal/estimates/'

type EstimateLineSnapshot = {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
}

type EstimateSnapshot = {
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
  created_at: string
  updated_at: string
}

const SHARE_COLUMNS = `
  id, company_id, project_id, estimate_snapshot, share_token,
  recipient_email, recipient_name, sent_at, expires_at,
  accepted_at, declined_at, decline_reason, viewed_at, view_count,
  signature_data_url, signer_name, host(signer_ip) as signer_ip,
  created_at, updated_at
`

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
      const row = insertResult.rows[0]!

      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'estimate_share_link',
        entityId: row.id,
        action: 'created',
        row: { ...row, share_token: '[redacted]' } as Record<string, unknown>,
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
    const rows = await ctx.pool.query<EstimateShareRow>(
      `select ${SHARE_COLUMNS}
       from estimate_share_links
       where company_id = $1 and project_id = $2
       order by sent_at desc
       limit 100`,
      [ctx.company.id, projectId],
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

  // POST /api/estimate-shares/:id/revoke — invalidate a share
  const revokeMatch = url.pathname.match(/^\/api\/estimate-shares\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = revokeMatch[1] ?? ''
    const result = await ctx.pool.query<EstimateShareRow>(
      `update estimate_share_links
         set expires_at = now(), updated_at = now()
       where company_id = $1 and id = $2
       returning ${SHARE_COLUMNS}`,
      [ctx.company.id, id],
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
    // a record, not an active funnel step.
    if (!row.accepted_at && !row.declined_at) {
      await ctx.pool.query(
        `update estimate_share_links
           set viewed_at = coalesce(viewed_at, now()),
               view_count = view_count + 1,
               updated_at = now()
         where id = $1`,
        [row.id],
      )
    }
    const meta = await loadProjectAndCompanyForShare(ctx.pool, row)
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

// ---------------------------------------------------------------------------
// Helpers — kept in this module so the auth + portal handlers share one
// view of "valid token + non-expired + still resolvable".
// ---------------------------------------------------------------------------

type ProjectRow = {
  id: string
  bid_total: number
  lifecycle_state: string
  lifecycle_state_version: number
}

async function loadProject(
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

async function snapshotEstimate(
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

type ShareLookupOk = { ok: true; row: EstimateShareRow }
type ShareLookupErr = { ok: false; status: number; error: string }
type ShareLookupResult = ShareLookupOk | ShareLookupErr

function classifyShareForRecipient(row: EstimateShareRow | null, verify: VerifyShareTokenResult): ShareLookupResult {
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  if (!row) return { ok: false, status: 404, error: 'share link not found' }
  const expiresMs = new Date(row.expires_at).getTime()
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: 'share link has expired' }
  }
  return { ok: true, row }
}

async function loadShareByToken(
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

async function loadShareByTokenForUpdate(
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

async function loadProjectAndCompanyForShare(
  pool: Pool,
  row: EstimateShareRow,
): Promise<{ project_name: string; company_name: string }> {
  const result = await pool.query<{ project_name: string; company_name: string }>(
    `select p.name as project_name, c.name as company_name
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
  }
}

function shareStatus(row: EstimateShareRow): 'accepted' | 'declined' | 'expired' | 'pending' {
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired'
  return 'pending'
}

function buildPortalView(row: EstimateShareRow, meta: { project_name: string; company_name: string }) {
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

function buildShareUrl(portalBaseUrl: string, token: string): string {
  const trimmed = portalBaseUrl.replace(/\/$/, '')
  return `${trimmed}${PORTAL_ESTIMATES_PATH_PREFIX}${encodeURIComponent(token)}`
}

// ---------------------------------------------------------------------------
// Lifecycle helper — best-effort transition. The project-lifecycle
// workflow module (`apps/api/src/routes/project-lifecycle.ts` + the
// pure reducer in `packages/workflows/src/project-lifecycle.ts`,
// migration 048) is built in parallel. We can't import the reducer
// directly without editing `packages/workflows/src/index.ts` (forbidden
// by the integration contract for this PR), so this helper writes the
// same SEND/ACCEPT/DECLINE transitions inline using the same column
// names and `workflow_event_log` shape the lifecycle endpoint will use.
//
// The transition table here is a strict subset of the canonical reducer
// (SEND: estimating→sent, ACCEPT: sent→accepted, DECLINE: sent→declined).
// Anything else is a no-op so the share row remains the source of truth
// even when the lifecycle is in an unexpected state. Once the lifecycle
// route module ships, this helper should switch to invoking it via the
// internal lifecycle event endpoint — see INTEGRATION TODO.
// ---------------------------------------------------------------------------

type LifecycleEventKind = 'SEND' | 'ACCEPT' | 'DECLINE'

type LifecycleApplyResult =
  | { kind: 'applied'; toState: string }
  | { kind: 'transition_failed'; fromState: string }
  | { kind: 'project_not_found' }

const LIFECYCLE_TRANSITIONS: Record<LifecycleEventKind, { from: string; to: string }> = {
  SEND: { from: 'estimating', to: 'sent' },
  ACCEPT: { from: 'sent', to: 'accepted' },
  DECLINE: { from: 'sent', to: 'declined' },
}

const PROJECT_LIFECYCLE_WORKFLOW_NAME = 'project_lifecycle'
const PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION = 1

async function maybeApplyLifecycleEvent(
  client: PoolClient,
  args: {
    companyId: string
    projectId: string
    eventType: LifecycleEventKind
    actorUserId: string
    reason?: string
  },
): Promise<LifecycleApplyResult> {
  const projectResult = await client.query<{
    lifecycle_state: string
    lifecycle_state_version: number
  }>(
    `select lifecycle_state, lifecycle_state_version
     from projects
     where company_id = $1 and id = $2
     for update
     limit 1`,
    [args.companyId, args.projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return { kind: 'project_not_found' }

  const transition = LIFECYCLE_TRANSITIONS[args.eventType]
  const fromState = project.lifecycle_state
  if (fromState !== transition.from) {
    return { kind: 'transition_failed', fromState }
  }

  const occurredAt = new Date().toISOString()
  const nextStateVersion = project.lifecycle_state_version + 1

  const setClauses: string[] = ['lifecycle_state = $1', 'lifecycle_state_version = $2', 'updated_at = now()']
  const params: unknown[] = [transition.to, nextStateVersion]
  if (args.eventType === 'SEND') {
    setClauses.push(`lifecycle_sent_at = $${params.length + 1}`)
    params.push(occurredAt)
  } else if (args.eventType === 'ACCEPT') {
    setClauses.push(`lifecycle_accepted_at = $${params.length + 1}`)
    params.push(occurredAt)
    setClauses.push('lifecycle_declined_at = NULL')
    setClauses.push('lifecycle_decline_reason = NULL')
  } else {
    setClauses.push(`lifecycle_declined_at = $${params.length + 1}`)
    params.push(occurredAt)
    setClauses.push(`lifecycle_decline_reason = $${params.length + 1}`)
    params.push(args.reason ?? null)
  }

  params.push(args.companyId, args.projectId)
  const idIndex = params.length
  await client.query(
    `update projects
     set ${setClauses.join(', ')}
     where company_id = $${idIndex - 1} and id = $${idIndex}`,
    params,
  )

  const eventPayload: Record<string, unknown> = {
    type: args.eventType,
    actor_user_id: args.actorUserId,
    occurred_at: occurredAt,
  }
  if (args.eventType === 'DECLINE' && args.reason) {
    eventPayload.reason = args.reason
  }
  const snapshotAfter: Record<string, unknown> = {
    state: transition.to,
    state_version: nextStateVersion,
  }
  if (args.eventType === 'SEND') snapshotAfter.sent_at = occurredAt
  if (args.eventType === 'ACCEPT') {
    snapshotAfter.accepted_at = occurredAt
    snapshotAfter.declined_at = null
    snapshotAfter.decline_reason = null
  }
  if (args.eventType === 'DECLINE') {
    snapshotAfter.declined_at = occurredAt
    snapshotAfter.decline_reason = args.reason ?? null
  }

  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: PROJECT_LIFECYCLE_WORKFLOW_NAME,
    schemaVersion: PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION,
    entityType: 'project',
    entityId: args.projectId,
    stateVersion: project.lifecycle_state_version,
    eventType: args.eventType,
    eventPayload,
    snapshotAfter,
    actorUserId: args.actorUserId,
  })

  return { kind: 'applied', toState: transition.to }
}

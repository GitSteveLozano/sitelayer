import type http from 'node:http'
import type { Pool } from 'pg'
import { Sentry } from '../instrument.js'
import { LA_TEMPLATE, WORKFLOW_STAGES } from '@sitelayer/domain'
import { createLogger } from '@sitelayer/logger'
import type { AppTier } from '@sitelayer/config'
import type { ActiveCompany } from '../auth-types.js'
import {
  authorizeDebugTraceRequest,
  DebugTraceError,
  fetchSentryTrace,
  parseTraceIdFromSentryTraceHeader,
} from '../debug-trace.js'
import { HttpError } from '../http-utils.js'
import { buildListProjectsQuery, parseProjectsQuery } from '../projects-query.js'
import { getMemberships } from './companies.js'

const logger = createLogger('api:system')

/**
 * Handlers for the system / session-level GET endpoints that used to live
 * inline in server.ts:
 *   - GET /api/bootstrap
 *   - GET /api/spec
 *   - GET /api/session
 *   - GET /api/projects               (list — POST/PATCH live in routes/projects.ts)
 *   - GET /api/divisions
 *   - GET /api/debug/traces/:id
 *
 * All of these run AFTER auth + identity + company resolution, so they get
 * the full RouteContext shape.
 */

export type SystemRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /** Active Clerk (or fallback) user id; used by /api/session. */
  currentUserId: string
  sendJson: (status: number, body: unknown) => void
  /**
   * Per-response side-channels for headers we can't drive through sendJson.
   * Keeps the handler from importing http directly.
   */
  setHeader: (name: string, value: string) => void
  send304: (etag: string) => void
}

export type DebugTraceRouteCtx = SystemRouteCtx & {
  req: http.IncomingMessage
  url: URL
  requestId: string
  tier: AppTier
}

export async function handleSystemRoutes(req: http.IncomingMessage, url: URL, ctx: SystemRouteCtx): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    // ETag short-circuit using the company-bootstrap-state token bumped by
    // per-statement triggers on every bootstrap-source table (migration 014).
    // Saves the 11-query fan-out on a session restore where nothing has
    // changed.
    const tokenResult = await ctx.pool.query<{ token: string | null }>(
      'select token from company_bootstrap_state where company_id = $1',
      [ctx.company.id],
    )
    const token = tokenResult.rows[0]?.token
    const etag = token ? `"${token}"` : null
    if (etag) {
      ctx.setHeader('ETag', etag)
      ctx.setHeader('Cache-Control', 'private, no-cache')
      const ifNoneMatch = req.headers['if-none-match']
      const candidate = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch
      if (candidate && candidate === etag) {
        ctx.send304(etag)
        return true
      }
    }
    const bootstrap = await loadBootstrap(ctx.pool, ctx.company.id)
    ctx.sendJson(200, { company: ctx.company, ...bootstrap })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/spec') {
    // Per-tenant static config; same caching policy as /api/features.
    ctx.setHeader('Cache-Control', 'private, max-age=300')
    ctx.sendJson(200, {
      product: 'Sitelayer',
      company: ctx.company,
      workflow: WORKFLOW_STAGES,
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const membershipRows = await getMemberships(ctx.pool, ctx.currentUserId)
    ctx.sendJson(200, {
      user: { id: ctx.currentUserId, role: membershipRows[0]?.role ?? 'admin' },
      activeCompany: ctx.company,
      memberships: membershipRows,
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const query = parseProjectsQuery(url.searchParams)
    const built = buildListProjectsQuery(ctx.company.id, query)
    const result = await ctx.pool.query(built.sql, built.values)
    const projects = result.rows
    const nextCursor = projects.length === built.limit ? (projects[projects.length - 1]?.updated_at ?? null) : null
    ctx.sendJson(200, { projects, nextCursor })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/divisions') {
    const result = await ctx.pool.query(
      'select code, name, sort_order from divisions where company_id = $1 order by sort_order asc',
      [ctx.company.id],
    )
    ctx.sendJson(200, { divisions: result.rows })
    return true
  }

  return false
}

/**
 * Loads the parallel set of read queries that hydrate the SPA on session
 * start. Same SQL, ordering, and shape as the inline server.ts version.
 */
async function loadBootstrap(pool: Pool, companyId: string) {
  const [
    divisions,
    serviceItems,
    customers,
    projects,
    workers,
    pricingProfiles,
    bonusRules,
    integrations,
    mappings,
    schedules,
    laborEntries,
  ] = await Promise.all([
    pool.query('select code, name, sort_order from divisions where company_id = $1 order by sort_order asc', [
      companyId,
    ]),
    pool.query(
      'select code, name, category, unit, default_rate, source, version from service_items where company_id = $1 and deleted_at is null order by name asc',
      [companyId],
    ),
    pool.query(
      'select id, external_id, name, source, created_at from customers where company_id = $1 and deleted_at is null order by name asc',
      [companyId],
    ),
    pool.query(
      'select id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at from projects where company_id = $1 order by updated_at desc',
      [companyId],
    ),
    pool.query('select id, name, role, created_at from workers where company_id = $1 order by name asc', [companyId]),
    pool.query(
      'select id, name, is_default, config, version, created_at from pricing_profiles where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      'select id, name, config, is_active, version, created_at from bonus_rules where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      'select id, provider, provider_account_id, sync_cursor, last_synced_at, status, version from integration_connections where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      `
        select id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        from integration_mappings
        where company_id = $1 and deleted_at is null
        order by entity_type asc, created_at asc
        `,
      [companyId],
    ),
    pool.query(
      'select id, project_id, scheduled_for, crew, status from crew_schedules where company_id = $1 order by scheduled_for desc',
      [companyId],
    ),
    // Bootstrap returns recent labor history only — capped to the last year
    // and 1000 rows so the response stays bounded as company history grows.
    // Older entries are still readable through GET /api/labor-entries with
    // explicit filters.
    pool.query(
      `select id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at
         from labor_entries
        where company_id = $1
          and occurred_on >= (now() - interval '365 days')::date
        order by occurred_on desc, created_at desc
        limit 1000`,
      [companyId],
    ),
  ])

  return {
    template: LA_TEMPLATE,
    workflowStages: WORKFLOW_STAGES,
    divisions: divisions.rows,
    serviceItems: serviceItems.rows,
    customers: customers.rows,
    projects: projects.rows,
    workers: workers.rows,
    pricingProfiles: pricingProfiles.rows,
    bonusRules: bonusRules.rows,
    integrations: integrations.rows,
    integrationMappings: mappings.rows,
    schedules: schedules.rows,
    laborEntries: laborEntries.rows,
  }
}

// Token-bucket rate limit for the unauthenticated trace lookup endpoint.
// Keyed by (remoteAddr, first 8 chars of token) so a single shared token
// can't fan out across many sources without slowing down. Module-scoped on
// purpose: the bucket persists across requests for the lifetime of the
// process.
const debugRateBuckets = new Map<string, { tokens: number; updatedAt: number }>()
function debugRateLimit(key: string, capacity = 10, refillPerMs = 10 / 60_000): boolean {
  const now = Date.now()
  const current = debugRateBuckets.get(key) ?? { tokens: capacity, updatedAt: now }
  const elapsed = Math.max(0, now - current.updatedAt)
  const tokens = Math.min(capacity, current.tokens + elapsed * refillPerMs)
  if (tokens < 1) {
    debugRateBuckets.set(key, { tokens, updatedAt: now })
    return false
  }
  debugRateBuckets.set(key, { tokens: tokens - 1, updatedAt: now })
  return true
}

async function fetchQueueRowsForTraceOrRequest(
  pool: Pool,
  params: { traceId?: string; requestId?: string },
): Promise<{ outbox: unknown[]; syncEvents: unknown[] }> {
  const clauses: string[] = []
  const values: unknown[] = []
  if (params.requestId) {
    values.push(params.requestId)
    clauses.push(`request_id = $${values.length}`)
  }
  if (params.traceId) {
    values.push(`%${params.traceId}%`)
    clauses.push(`sentry_trace like $${values.length}`)
  }
  if (!clauses.length) return { outbox: [], syncEvents: [] }
  const where = clauses.join(' or ')
  const outbox = await pool.query(
    `select id, company_id, entity_type, entity_id, mutation_type, status, attempt_count, created_at, applied_at, request_id, sentry_trace
     from mutation_outbox where ${where} order by created_at asc limit 200`,
    values,
  )
  const syncEvents = await pool.query(
    `select id, company_id, entity_type, entity_id, direction, status, attempt_count, created_at, applied_at, request_id, sentry_trace
     from sync_events where ${where} order by created_at asc limit 200`,
    values,
  )
  return { outbox: outbox.rows, syncEvents: syncEvents.rows }
}

async function fetchAuditRowsForTraceOrRequest(
  pool: Pool,
  companyId: string,
  params: { traceId?: string; requestId?: string },
): Promise<unknown[]> {
  const clauses: string[] = ['company_id = $1']
  const values: unknown[] = [companyId]
  const correlationClauses: string[] = []
  if (params.requestId) {
    values.push(params.requestId)
    correlationClauses.push(`request_id = $${values.length}`)
  }
  if (params.traceId) {
    values.push(`%${params.traceId}%`)
    correlationClauses.push(`sentry_trace like $${values.length}`)
  }
  if (!correlationClauses.length) return []
  clauses.push(`(${correlationClauses.join(' or ')})`)
  const audit = await pool.query(
    `select id, actor_user_id, actor_role, entity_type, entity_id, action,
            before, after, request_id, sentry_trace, created_at
       from audit_events
      where ${clauses.join(' and ')}
      order by created_at asc
      limit 200`,
    values,
  )
  return audit.rows
}

/**
 * GET /api/debug/traces/:id — proxies Sentry's events-trace API and joins
 * matching mutation_outbox / sync_events / audit_events rows. Bearer-gated
 * via DEBUG_TRACE_TOKEN, tier-gated against prod unless DEBUG_ALLOW_PROD=1,
 * rate-limited by (remoteAddr, token-prefix). See routes/system.ts header
 * for the SLA: DOES NOT trigger withMutationTx.
 *
 * Returns true when this dispatcher should consider the request handled.
 */
export async function handleDebugTraceRoute(ctx: DebugTraceRouteCtx): Promise<boolean> {
  const { req, url, requestId, sendJson, pool, company, tier } = ctx
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/debug/traces/')) {
    return false
  }
  const authResult = authorizeDebugTraceRequest({
    debugToken: process.env.DEBUG_TRACE_TOKEN,
    tier,
    allowProd: process.env.DEBUG_ALLOW_PROD,
    authorizationHeader: req.headers['authorization'],
    requestId,
  })
  if (!authResult.ok) {
    if (authResult.authenticate) {
      ctx.setHeader('www-authenticate', 'Bearer realm="sitelayer-debug"')
    }
    sendJson(authResult.status, authResult.body)
    return true
  }
  const presented = authResult.presentedToken
  const rlKey = (req.socket.remoteAddress ?? 'unknown') + ':' + presented.slice(0, 8)
  if (!debugRateLimit(rlKey)) {
    ctx.setHeader('retry-after', '6')
    sendJson(429, { error: 'rate limit exceeded', request_id: requestId })
    return true
  }
  const lookupId = url.pathname.slice('/api/debug/traces/'.length).trim()
  const byRequest = url.searchParams.get('by') === 'request_id'
  if (!lookupId || lookupId.includes('/')) {
    sendJson(400, { error: 'invalid trace id', request_id: requestId })
    return true
  }
  logger.info({ scope: 'debug_trace', target: lookupId, by_request: byRequest }, 'debug trace lookup')
  Sentry.setTag('debug_trace_lookup', '1')
  try {
    let traceId = byRequest ? null : lookupId
    const queueRows = await fetchQueueRowsForTraceOrRequest(
      pool,
      byRequest ? { requestId: lookupId } : { traceId: lookupId },
    )
    if (byRequest && !traceId) {
      const hintRow = queueRows.outbox[0] ?? queueRows.syncEvents[0]
      const hintTrace = hintRow ? (hintRow as { sentry_trace: string | null }).sentry_trace : null
      traceId = parseTraceIdFromSentryTraceHeader(hintTrace)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    let sentryPayload: unknown = null
    let sentryError: string | null = null
    if (traceId) {
      try {
        sentryPayload = await fetchSentryTrace(traceId, controller.signal)
      } catch (err) {
        if (err instanceof DebugTraceError) {
          sentryError = err.message
        } else {
          sentryError = err instanceof Error ? err.message : 'sentry fetch failed'
        }
      } finally {
        clearTimeout(timeout)
      }
    } else {
      clearTimeout(timeout)
      sentryError = 'no trace_id found; pass ?by=request_id only when request has at least one enqueued row'
    }
    const auditRows = await fetchAuditRowsForTraceOrRequest(
      pool,
      company.id,
      byRequest ? { requestId: lookupId } : { traceId: traceId ?? lookupId },
    )
    sendJson(200, {
      request_id: requestId,
      lookup: { kind: byRequest ? 'request_id' : 'trace_id', id: lookupId },
      trace_id: traceId,
      sentry: sentryPayload,
      sentry_error: sentryError,
      queue: queueRows,
      audit_events: auditRows,
    })
  } catch (err) {
    logger.error({ err, scope: 'debug_trace' }, 'debug trace lookup failed')
    const status = err instanceof DebugTraceError ? err.status : err instanceof HttpError ? err.status : 500
    sendJson(status, {
      error: err instanceof Error ? err.message : 'debug trace lookup failed',
      request_id: requestId,
    })
  }
  return true
}

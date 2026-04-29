import { Sentry } from './instrument.js'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolConfig } from 'pg'
import { createLogger, getRequestContext, runWithRequestContext, type RequestContext } from '@sitelayer/logger'
import {
  authorizeDebugTraceRequest,
  DebugTraceError,
  fetchSentryTrace,
  parseTraceIdFromSentryTraceHeader,
} from './debug-trace.js'
import { LA_TEMPLATE, WORKFLOW_STAGES, formatMoney } from '@sitelayer/domain'
import { loadAppConfig, logAppConfigBanner, postgresOptionsForTier, TierConfigError } from './tier.js'
import { validateQboStateSecret } from './qbo-config.js'
import { normalizeCompanyRole, type ActiveCompany, type CompanyRole } from './auth-types.js'
import { handleAnalyticsRoutes } from './routes/analytics.js'
import { handleAuditEventRoutes } from './routes/audit-events.js'
import { handleBonusRuleRoutes } from './routes/bonus-rules.js'
import { handleClockRoutes } from './routes/clock.js'
import { handleCustomerRoutes } from './routes/customers.js'
import { handleLaborEntryRoutes } from './routes/labor-entries.js'
import { handleMaterialBillRoutes } from './routes/material-bills.js'
import { handlePricingProfileRoutes } from './routes/pricing-profiles.js'
import { handleQboMappingRoutes } from './routes/qbo-mappings.js'
import { handleRentalInventoryRoutes } from './routes/rental-inventory.js'
import { handleRentalRoutes } from './routes/rentals.js'
import { handleScheduleRoutes } from './routes/schedules.js'
import { handleTakeoffMeasurementRoutes } from './routes/takeoff-measurements.js'
import { handleServiceItemRoutes } from './routes/service-items.js'
import { handleSupportPacketRoutes } from './routes/support-packets.js'
import { handleSyncRoutes } from './routes/sync.js'
import { handleWorkerRoutes } from './routes/workers.js'
import { handleBlueprintRoutes } from './routes/blueprints.js'
import { handleProjectRoutes } from './routes/projects.js'
import { handleEstimateRoutes } from './routes/estimate.js'
import { assertBlueprintDocumentsBelongToProject, handleTakeoffWriteRoutes } from './routes/takeoff-write.js'
import { getMemberships, handleCompanyRoutes } from './routes/companies.js'
import {
  backfillCustomerMapping,
  handleQboRoutes,
  listIntegrationMappings,
  upsertIntegrationMapping,
} from './routes/qbo.js'
import {
  CORS_ALLOW_HEADERS,
  HttpError,
  getCorsOrigin as getCorsOriginImpl,
  readBody as readBodyImpl,
  sendJson as sendJsonImpl,
  sendRedirect,
} from './http-utils.js'
import { attachMutationTx } from './mutation-tx.js'
import { createBlueprintStorage, readStorageEnv, type BlueprintStorage } from './storage.js'
import { BlueprintUploadError } from './blueprint-upload.js'
import { renderEstimatePdf } from './pdf.js'
import { buildListProjectsQuery, parseProjectsQuery } from './projects-query.js'
// assertServiceItemCatalogStatus, loadServiceItemCatalogIndex, rejectionMessageForCatalog
// moved to routes/takeoff-write.ts.
import { AuthConfigError, AuthError, loadAuthConfig, resolveIdentity, type Identity } from './auth.js'
import { extractSvixHeaders, verifyClerkWebhook } from './clerk-webhook.js'
import {
  extractIntuitSignature,
  flattenQboWebhookPayload,
  parseQboWebhookPayload,
  verifyQboWebhook,
} from './qbo-webhook.js'
import { attachPool, observeRequest, renderMetrics } from './metrics.js'
import { loadEmailConfig } from './email.js'
import { applyRateLimit, createRateLimiter, isRateLimitExempt, loadRateLimitConfig } from './rate-limit.js'
import { assertVersion } from './version-guard.js'

const logger = createLogger('api')

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

async function fetchQueueRowsForTraceOrRequest(params: { traceId?: string; requestId?: string }) {
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

async function fetchAuditRowsForTraceOrRequest(companyId: string, params: { traceId?: string; requestId?: string }) {
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

let appConfig: ReturnType<typeof loadAppConfig>
try {
  appConfig = loadAppConfig()
  logAppConfigBanner(appConfig)
} catch (err) {
  if (err instanceof TierConfigError) {
    logger.fatal({ err }, '[tier] refusing to start')
    process.exit(1)
  }
  throw err
}

let storage: BlueprintStorage
try {
  storage = await createBlueprintStorage(readStorageEnv(process.env, appConfig.tier))
  logger.info({ backend: storage.backend, bucket: storage.bucket ?? null }, '[storage] ready')
} catch (err) {
  logger.fatal({ err }, '[storage] refusing to start')
  process.exit(1)
}

const emailConfig = loadEmailConfig()
logger.info(
  {
    provider: emailConfig.provider,
    from: emailConfig.from,
    resend_key: emailConfig.resendApiKey ? 'set' : 'missing',
    sendgrid_key: emailConfig.sendgridApiKey ? 'set' : 'missing',
  },
  '[email] ready',
)

// CompanyRole / ActiveCompany / normalizeCompanyRole moved to auth-types.ts so
// extracted route modules can import them without circular-importing server.ts.

const port = Number(process.env.PORT ?? 3001)
const databaseUrl = appConfig.databaseUrl
const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
const activeCompanySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'
const activeUserId = process.env.ACTIVE_USER_ID ?? 'demo-user'
let authConfig: ReturnType<typeof loadAuthConfig>
try {
  authConfig = loadAuthConfig(process.env)
} catch (err) {
  if (err instanceof AuthConfigError) {
    logger.fatal({ err }, '[auth] refusing to start')
    process.exit(1)
  }
  throw err
}
const buildSha = process.env.APP_BUILD_SHA ?? process.env.SENTRY_RELEASE ?? 'unknown'
const startedAt = new Date().toISOString()
const metricsToken = process.env.API_METRICS_TOKEN?.trim() || null
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
if (appConfig.tier === 'prod' && !metricsToken) {
  logger.fatal('[metrics] APP_TIER=prod requires API_METRICS_TOKEN')
  process.exit(1)
}
if (appConfig.tier === 'prod' && allowedOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin))) {
  logger.fatal({ allowed_origins: allowedOrigins }, '[cors] APP_TIER=prod refuses localhost ALLOWED_ORIGINS')
  process.exit(1)
}
const qboClientId = process.env.QBO_CLIENT_ID ?? 'demo'
const qboClientSecret = process.env.QBO_CLIENT_SECRET ?? 'demo'
const qboRedirectUri = process.env.QBO_REDIRECT_URI ?? 'http://localhost:3001/api/integrations/qbo/callback'
const qboSuccessRedirectUri = process.env.QBO_SUCCESS_REDIRECT_URI ?? 'http://localhost:3000/?qbo=connected'
const qboEnvironment = (process.env.QBO_ENVIRONMENT ?? 'sandbox') as 'sandbox' | 'production'
const qboBaseUrl =
  process.env.QBO_BASE_URL ??
  (qboEnvironment === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com')
const qboStateSecretCheck = validateQboStateSecret({
  tier: appConfig.tier,
  stateSecret: process.env.QBO_STATE_SECRET ?? null,
  clientSecret: qboClientSecret,
})
if (!qboStateSecretCheck.ok) {
  if (qboStateSecretCheck.reason === 'missing') {
    logger.fatal('[qbo] APP_TIER=prod requires QBO_STATE_SECRET to be set')
  } else {
    logger.fatal('[qbo] APP_TIER=prod requires QBO_STATE_SECRET to differ from QBO_CLIENT_SECRET')
  }
  process.exit(1)
}
const qboStateSecret = qboStateSecretCheck.stateSecret
const clerkWebhookSecret = process.env.CLERK_WEBHOOK_SECRET?.trim() || null
const qboWebhookVerifier = process.env.QBO_WEBHOOK_VERIFIER?.trim() || null
const maxJsonBodyBytes = Number(process.env.MAX_JSON_BODY_BYTES ?? 20 * 1024 * 1024)
const maxBlueprintUploadBytes = Number(process.env.MAX_BLUEPRINT_UPLOAD_BYTES ?? 200 * 1024 * 1024)
// Gate the presigned-URL 302 redirect on the blueprint download path. Off by
// default so we don't break PDF.js fetches until Spaces CORS is validated;
// when off, the API streams bytes itself the same way it did pre-streaming.
const blueprintDownloadPresigned =
  process.env.BLUEPRINT_DOWNLOAD_PRESIGNED === '1' || process.env.BLUEPRINT_DOWNLOAD_PRESIGNED === 'true'

// Pool circuit-breaker knobs.
// - max bounds connection count so a slow-query storm can't exhaust Postgres.
// - statement_timeout / query_timeout fail individual queries fast instead of
//   stalling /health behind them.
// - healthProbeTimeout caps the /health DB probe so the endpoint stays
//   reachable even when Postgres is wedged.
// - application_name is set so DB-side `pg_stat_activity` debug is easier.
const pgPoolMax = (() => {
  // Production handles parallel /api/bootstrap fan-out (11 queries) plus concurrent
  // user requests on a 4 vCPU droplet. Default to 40 for prod, 20 elsewhere; env
  // override always wins.
  const tierDefault = appConfig.tier === 'prod' ? 40 : 20
  const raw = process.env.PG_POOL_MAX
  if (raw === undefined || raw === '') return tierDefault
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : tierDefault
})()
const pgStatementTimeoutMs = (() => {
  const n = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000
})()
const pgQueryTimeoutMs = (() => {
  const n = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 10_000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000
})()
const pgHealthProbeTimeoutMs = (() => {
  const n = Number(process.env.PG_HEALTH_PROBE_TIMEOUT_MS ?? 1500)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1500
})()
// Bound how long pool.connect() waits for a backend before giving up. Without
// this, a wedged Postgres or bad SSL config can hang every request handler
// indefinitely instead of failing fast and surfacing a 5xx.
const pgConnectionTimeoutMs = (() => {
  const n = Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000
})()

function withTierOptions(config: PoolConfig): PoolConfig {
  return {
    ...config,
    options: postgresOptionsForTier(appConfig.tier, config.options || process.env.PGOPTIONS),
    application_name: 'sitelayer-api',
    max: pgPoolMax,
    statement_timeout: pgStatementTimeoutMs,
    query_timeout: pgQueryTimeoutMs,
    connectionTimeoutMillis: pgConnectionTimeoutMs,
  }
}

function getPoolConfig(connectionString: string): PoolConfig {
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!databaseSslRejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return withTierOptions({
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
      })
    }
  } catch {
    return withTierOptions({ connectionString })
  }

  return withTierOptions({ connectionString })
}

const pool = new Pool(getPoolConfig(databaseUrl))
attachPool(pool)
attachMutationTx({ pool, logger })

const rateLimitConfig = loadRateLimitConfig(process.env)
const rateLimiter = createRateLimiter(rateLimitConfig)
logger.info(
  {
    perUserPerMin: rateLimitConfig.perUserPerMin,
    perIpPerMin: rateLimitConfig.perIpPerMin,
    windowMs: rateLimitConfig.windowMs,
  },
  '[rate-limit] configured',
)
logger.info(
  {
    pgPoolMax,
    pgStatementTimeoutMs,
    pgQueryTimeoutMs,
    pgHealthProbeTimeoutMs,
  },
  '[pool] configured',
)

function getCorsOrigin(req: http.IncomingMessage): string {
  return getCorsOriginImpl(req, allowedOrigins)
}

// Blueprint file helpers moved to routes/blueprints.ts.

type CompanyRow = {
  id: string
  slug: string
  name: string
  created_at: string
}

async function getCompany(req?: http.IncomingMessage): Promise<ActiveCompany | null> {
  const headerSlug = req?.headers['x-sitelayer-company-slug']
  const headerId = req?.headers['x-sitelayer-company-id']
  const requestedSlug = Array.isArray(headerSlug) ? headerSlug[0] : headerSlug
  const requestedId = Array.isArray(headerId) ? headerId[0] : headerId

  let companyRow: CompanyRow | null = null
  if (requestedId) {
    const byId = await pool.query<CompanyRow>(
      'select id, slug, name, created_at from companies where id = $1 limit 1',
      [requestedId],
    )
    if (byId.rows[0]) companyRow = byId.rows[0]
  }

  if (!companyRow) {
    const companySlug = requestedSlug?.trim() || getCurrentCompanySlug(req)
    const result = await pool.query<CompanyRow>(
      'select id, slug, name, created_at from companies where slug = $1 limit 1',
      [companySlug],
    )
    companyRow = result.rows[0] ?? null
  }

  if (!companyRow) return null

  // Verify membership and surface the role so handlers can enforce RBAC
  // without re-querying. See `requireRole()`.
  const userId = getCurrentUserId(req)
  const membership = await pool.query<{ role: string }>(
    'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
    [companyRow.id, userId],
  )
  if (!membership.rows.length) return null

  return {
    id: companyRow.id,
    slug: companyRow.slug,
    name: companyRow.name,
    created_at: companyRow.created_at,
    role: normalizeCompanyRole(membership.rows[0]?.role),
  }
}

/**
 * Enforce role-based access on a mutation handler. Returns `true` when the
 * active role is in `allowed` and the caller should proceed; returns `false`
 * after sending a 403 response, in which case the caller should `return`.
 *
 * Usage:
 *   if (!requireRole(res, company, ['admin', 'office'])) return
 */
function requireRole(
  res: http.ServerResponse,
  company: Pick<ActiveCompany, 'role'>,
  allowed: readonly CompanyRole[],
  req?: http.IncomingMessage,
): boolean {
  if (allowed.includes(company.role)) return true
  sendJson(res, 403, { error: 'forbidden: role not permitted', role: company.role, allowed }, req)
  return false
}

function getHeaderValue(req: http.IncomingMessage | undefined, key: string): string | null {
  const value = req?.headers[key]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getCurrentUserId(req?: http.IncomingMessage): string {
  const ctxUser = getRequestContext()?.actorUserId
  if (ctxUser) return ctxUser
  return getHeaderValue(req, 'x-sitelayer-user-id') ?? activeUserId
}

function getCurrentCompanySlug(req?: http.IncomingMessage): string {
  return getHeaderValue(req, 'x-sitelayer-company-slug') ?? activeCompanySlug
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, req?: http.IncomingMessage) {
  sendJsonImpl(res, status, body, req ? { req, allowedOrigins } : { allowedOrigins })
}

/**
 * Local wrapper around `assertVersion` that re-uses `sendJson` so the 409
 * response keeps CORS headers attached.
 */
async function checkVersion(
  table: string,
  where: string,
  params: unknown[],
  expectedVersion: number | null,
  res: http.ServerResponse,
  req: http.IncomingMessage,
): Promise<boolean> {
  return assertVersion(pool, table, where, params, expectedVersion, res, {
    sendJson: (r, status, body) => sendJson(r as http.ServerResponse, status, body, req),
  })
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return readBodyImpl(req, maxJsonBodyBytes) as Promise<Record<string, any>>
}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      const buffer = Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > maxJsonBodyBytes) {
        rejected = true
        reject(new HttpError(413, `request body exceeds ${maxJsonBodyBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (rejected) return
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (!rejected) reject(error)
    })
  })
}

async function loadBootstrap(companyId: string) {
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

// countQueueRows / processQueue / getSyncStatus moved to routes/sync.ts.

// summarizeProject moved to routes/projects.ts.

// listBlueprintDocuments moved to routes/blueprints.ts.

// listTakeoffMeasurements moved to routes/takeoff-measurements.ts.

// listSchedules moved to routes/schedules.ts.

// createEstimateFromMeasurements moved to routes/estimate.ts.
// getScopeVsBid moved to routes/estimate.ts.
// listServiceItemDivisions moved to routes/estimate.ts.

/**
 * Validate the division_code against the service item's allowed divisions.
 * When `divisionCode` is null/empty we treat it as "not supplied" and the
 * caller is expected to fall back to the project's `division_code`.
 * Returns `true` when the code is accepted (either because none was supplied
 * or because it is in the allowed set, or because no membership rows exist
 * yet and the table is empty for that service item — i.e. legacy behavior).
 *
 * NOTE: this is the lenient version retained for labor_entries and other
 * non-takeoff callers that historically allowed an unrestricted catalog. The
 * stricter `assertServiceItemCatalogStatus` is used by takeoff measurement
 * endpoints and refuses both the "no rows at all" and "wrong division" cases
 * per the curated-catalog spec.
 */
async function assertDivisionAllowedForServiceItem(
  companyId: string,
  serviceItemCode: string,
  divisionCode: string | null,
): Promise<boolean> {
  if (!divisionCode) return true
  const existing = await pool.query<{ exists: boolean }>(
    `select exists(
       select 1 from service_item_divisions
        where company_id = $1 and service_item_code = $2
     ) as exists`,
    [companyId, serviceItemCode],
  )
  // If no xref rows exist yet for this service item, treat every division as
  // allowed (backfill-friendly). Once an admin/office user has configured the
  // set, enforce it strictly.
  if (!existing.rows[0]?.exists) return true
  const match = await pool.query<{ exists: boolean }>(
    `select exists(
       select 1 from service_item_divisions
        where company_id = $1 and service_item_code = $2 and division_code = $3
     ) as exists`,
    [companyId, serviceItemCode, divisionCode],
  )
  return Boolean(match.rows[0]?.exists)
}

/**
 * Strict catalog enforcement for takeoff measurements. Implements the spec:
 *   - If service_item_divisions has zero rows for a service_item_code,
 *     the service item is rejected (catalog must be curated).
 *   - If rows exist and `divisionCode` (resolved by the caller, with
 *     project-level fallback) is missing from the allowed set, reject.
 *   - If `divisionCode` is null we still require a curated catalog row;
 *     a curated item with at least one division is the minimum bar even
 *     when the caller didn't specify a per-takeoff division.
 *
 * The lenient `assertDivisionAllowedForServiceItem` is intentionally NOT
 * folded into this — labor entries still write through the legacy permissive
 * path because their xref usage is opt-in.
 */
// assertServiceItemCatalogStatus moved to routes/takeoff-write.ts.
// assertBlueprintDocumentsBelongToProject moved to routes/takeoff-write.ts.
// prepareTakeoffMeasurementInput / PreparedTakeoffMeasurementInput moved to routes/takeoff-write.ts.

// listCustomers moved to routes/customers.ts.

// listWorkers moved to routes/workers.ts.

async function listDivisions(companyId: string) {
  const result = await pool.query(
    'select code, name, sort_order from divisions where company_id = $1 order by sort_order asc',
    [companyId],
  )
  return result.rows
}

// listPricingProfiles moved to routes/pricing-profiles.ts.

// listAuditEvents moved to routes/audit-events.ts.

// listBonusRules moved to routes/bonus-rules.ts.

// parseConfigPayload moved to http-utils.ts.

// forecastProjectHours / ForecastMeasurementInput / round2 moved to routes/estimate.ts.

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now()
  const headerRequestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : ''
  const requestId = headerRequestId || randomUUID()
  res.setHeader('x-request-id', requestId)
  const method = req.method ?? 'UNKNOWN'
  let initialRoute = '/'
  try {
    initialRoute = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
  } catch {
    initialRoute = '/'
  }
  const companySlugHeader =
    typeof req.headers['x-sitelayer-company-slug'] === 'string' ? req.headers['x-sitelayer-company-slug'] : undefined
  const userIdHeader =
    typeof req.headers['x-sitelayer-user-id'] === 'string' ? req.headers['x-sitelayer-user-id'] : undefined
  const requestContext: RequestContext = {
    requestId,
    route: initialRoute,
    method,
    ...(companySlugHeader ? { companySlug: companySlugHeader } : {}),
    ...(userIdHeader ? { userId: userIdHeader } : {}),
  }
  res.on('finish', () => {
    observeRequest(method, requestContext.route ?? initialRoute, res.statusCode || 0, Date.now() - requestStartedAt)
  })

  await runWithRequestContext(requestContext, () =>
    Sentry.withIsolationScope((scope) => {
      scope.setTag('request_id', requestId)
      scope.setTag('route', initialRoute)
      scope.setTag('method', method)
      if (companySlugHeader) scope.setTag('company_slug', companySlugHeader)
      if (userIdHeader) scope.setUser({ id: userIdHeader })
      return Sentry.startSpan(
        {
          name: `${method} ${initialRoute}`,
          op: 'http.server',
          attributes: {
            'http.method': method,
            'http.route': initialRoute,
            request_id: requestId,
            ...(companySlugHeader ? { company_slug: companySlugHeader } : {}),
          },
        },
        async (rootSpan) => {
          try {
            if (!req.url || !req.method) {
              sendJson(res, 400, { error: 'bad request' })
              return
            }

            const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
            rootSpan?.setAttribute('http.route', url.pathname)

            if (req.method === 'OPTIONS') {
              res.writeHead(204, {
                'access-control-allow-origin': getCorsOrigin(req),
                'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                'access-control-allow-headers': CORS_ALLOW_HEADERS,
              })
              res.end()
              return
            }

            if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
              // Race the pg probe against PG_HEALTH_PROBE_TIMEOUT_MS so a wedged
              // pool can't pin /health open for the default 30s socket timeout.
              const probe = await Promise.race([
                pool
                  .query('select 1 as ok')
                  .then(() => ({ db: 'healthy' as const, error: null as string | null }))
                  .catch((err) => ({
                    db: 'down' as const,
                    error: err instanceof Error ? err.message : String(err),
                  })),
                new Promise<{ db: 'timeout'; error: string }>((resolve) =>
                  setTimeout(
                    () =>
                      resolve({
                        db: 'timeout',
                        error: `db probe exceeded ${pgHealthProbeTimeoutMs}ms`,
                      }),
                    pgHealthProbeTimeoutMs,
                  ),
                ),
              ])
              const ok = probe.db === 'healthy'
              const status = ok ? 200 : 503
              if (req.method === 'HEAD') {
                res.writeHead(status, {
                  'content-type': 'application/json; charset=utf-8',
                  'access-control-allow-origin': getCorsOrigin(req),
                  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                  'access-control-allow-headers': CORS_ALLOW_HEADERS,
                })
                res.end()
                return
              }
              sendJson(res, status, {
                ok,
                service: 'api',
                tier: appConfig.tier,
                build_sha: buildSha,
                started_at: startedAt,
                db: probe,
                money: formatMoney(1234.56),
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/version') {
              sendJson(res, 200, {
                service: 'api',
                tier: appConfig.tier,
                build_sha: buildSha,
                started_at: startedAt,
                node_version: process.version,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/metrics') {
              if (metricsToken) {
                const header = req.headers['authorization']
                const value = Array.isArray(header) ? header[0] : header
                const presented = value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null
                if (!presented || presented !== metricsToken) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer-metrics"')
                  sendJson(res, 401, { error: 'metrics token required' })
                  return
                }
              }
              const { contentType, body } = await renderMetrics()
              res.writeHead(200, {
                'content-type': contentType,
                'access-control-allow-origin': getCorsOrigin(req),
              })
              res.end(body)
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/features') {
              // Static config response — let the SPA cache for a few minutes
              // so a refresh doesn't refetch the same flags. private because
              // the body is per-tier (and could differ per company once flags
              // become company-scoped).
              res.setHeader('Cache-Control', 'private, max-age=300')
              sendJson(res, 200, {
                tier: appConfig.tier,
                flags: Array.from(appConfig.flags).sort(),
                ribbon: appConfig.ribbon,
              })
              return
            }

            // Clerk webhook: verified via svix signature, no Bearer/JWT.
            // Must run before identity resolution and stay in PUBLIC_PATHS.
            if (req.method === 'POST' && url.pathname === '/api/webhooks/clerk') {
              if (!clerkWebhookSecret) {
                sendJson(res, 503, { error: 'CLERK_WEBHOOK_SECRET not configured' })
                return
              }
              const raw = await readRawBody(req)
              const result = verifyClerkWebhook(raw, extractSvixHeaders(req.headers), clerkWebhookSecret)
              if (!result.ok) {
                logger.warn({ err: result.error }, '[clerk-webhook] verification failed')
                sendJson(res, result.status, { error: result.error })
                return
              }
              const { type, data } = result.event
              const subjectId = typeof data.id === 'string' ? data.id : null
              logger.info({ event: type, subjectId }, '[clerk-webhook] received')
              switch (type) {
                case 'user.created':
                case 'user.updated':
                  // Mirror table TBD; intentionally a no-op until the schema lands.
                  break
                case 'user.deleted':
                  // Don't cascade-delete memberships; preserve audit trail by leaving
                  // company_memberships intact. Future: nullify actor on audit_events.
                  logger.info({ subjectId }, '[clerk-webhook] user.deleted — no-op (audit trail preserved)')
                  break
                case 'session.created':
                  break
                default:
                  logger.debug({ event: type }, '[clerk-webhook] ignored event type')
              }
              // 204 keeps the webhook fast and signals "received, nothing to send".
              res.writeHead(204, { 'access-control-allow-origin': getCorsOrigin(req) })
              res.end()
              return
            }

            // QBO webhook: verified via intuit-signature HMAC, no Bearer/JWT.
            // Public path — runs before identity resolution so Intuit's
            // unauthenticated POSTs aren't rejected as 401.
            if (req.method === 'POST' && url.pathname === '/api/webhooks/qbo') {
              if (!qboWebhookVerifier) {
                sendJson(res, 503, { error: 'QBO_WEBHOOK_VERIFIER not configured' })
                return
              }
              const raw = await readRawBody(req)
              const signature = extractIntuitSignature(req.headers as Record<string, unknown>)
              const verify = verifyQboWebhook(raw, signature, qboWebhookVerifier)
              if (!verify.ok) {
                logger.warn({ err: verify.error, status: verify.status }, '[qbo-webhook] verification failed')
                sendJson(res, verify.status, { error: verify.error })
                return
              }
              const parsed = parseQboWebhookPayload(raw)
              if (!parsed.ok) {
                logger.warn({ err: parsed.error }, '[qbo-webhook] payload parse failed')
                sendJson(res, parsed.status, { error: parsed.error })
                return
              }
              const events = flattenQboWebhookPayload(parsed.payload)
              // We resolve each realm → integration_connection → company_id.
              // If a realm we've never connected sends us a webhook, we log and
              // drop those events rather than fabricating a company.
              const realmIds = Array.from(new Set(events.map((e) => e.realmId)))
              const connectionMap = new Map<string, { companyId: string; connectionId: string }>()
              for (const realmId of realmIds) {
                const result = await pool.query<{ company_id: string; id: string }>(
                  `select company_id, id from integration_connections
                   where provider = 'qbo' and provider_account_id = $1
                   order by created_at desc limit 1`,
                  [realmId],
                )
                const row = result.rows[0]
                if (row) connectionMap.set(realmId, { companyId: row.company_id, connectionId: row.id })
              }
              let persisted = 0
              let skipped = 0
              for (const event of events) {
                const conn = connectionMap.get(event.realmId)
                if (!conn) {
                  skipped += 1
                  continue
                }
                await pool.query(
                  `insert into sync_events (
                     company_id, integration_connection_id, direction, entity_type, entity_id, payload, status
                   ) values ($1, $2, 'inbound', $3, $4, $5::jsonb, 'pending')`,
                  [
                    conn.companyId,
                    conn.connectionId,
                    event.entityType,
                    event.entityId,
                    JSON.stringify({
                      source: 'qbo_webhook',
                      realmId: event.realmId,
                      operation: event.operation,
                      lastUpdated: event.lastUpdated,
                      raw: event.raw,
                    }),
                  ],
                )
                persisted += 1
              }
              logger.info({ persisted, skipped, realms: realmIds.length }, '[qbo-webhook] received')
              // 200 quickly; the worker will pull entity details asynchronously.
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'access-control-allow-origin': getCorsOrigin(req),
              })
              res.end(JSON.stringify({ ok: true, persisted, skipped }))
              return
            }

            const PUBLIC_PATHS = new Set(['/api/integrations/qbo/callback', '/api/webhooks/clerk', '/api/webhooks/qbo'])
            const isPublicPath = PUBLIC_PATHS.has(url.pathname)
            let identity: Identity
            try {
              identity = isPublicPath
                ? { userId: 'qbo-oauth-redirect', source: 'default' }
                : resolveIdentity(req, authConfig)
            } catch (err) {
              if (err instanceof AuthError) {
                if (err.status === 401) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer"')
                }
                sendJson(res, err.status, { error: err.message, request_id: requestId })
                return
              }
              throw err
            }
            requestContext.actorUserId = identity.userId
            scope.setUser({ id: identity.userId })
            scope.setTag('auth_source', identity.source)

            // Rate limit /api/* (except /health and /api/webhooks/*). We resolve
            // the bucket key after identity so authenticated calls share a
            // per-user bucket regardless of source IP, and unauthenticated
            // public-path callers get a per-IP bucket.
            if (!isRateLimitExempt(url.pathname)) {
              const rateLimitUserId = identity.source === 'default' ? null : identity.userId
              if (applyRateLimit(rateLimiter, req, res, url.pathname, rateLimitUserId)) {
                return
              }
            }

            // Company routes (GET/POST /api/companies,
            // POST /api/companies/:id/memberships) handled by the extracted
            // route module. See routes/companies.ts.
            if (
              await handleCompanyRoutes(req, url, {
                pool,
                userId: identity.userId,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
              })
            ) {
              return
            }

            const company = await getCompany(req)
            if (!company) {
              sendJson(res, 404, { error: `company slug ${activeCompanySlug} not found` })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
              // ETag short-circuit using the company-bootstrap-state token
              // bumped by per-statement triggers on every bootstrap-source
              // table (migration 014). Saves the 11-query fan-out on a
              // session restore where nothing has changed.
              const tokenResult = await pool.query<{ token: string | null }>(
                'select token from company_bootstrap_state where company_id = $1',
                [company.id],
              )
              const token = tokenResult.rows[0]?.token
              const etag = token ? `"${token}"` : null
              if (etag) {
                res.setHeader('ETag', etag)
                res.setHeader('Cache-Control', 'private, no-cache')
                const ifNoneMatch = req.headers['if-none-match']
                const candidate = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch
                if (candidate && candidate === etag) {
                  res.writeHead(304, {
                    ETag: etag,
                    'access-control-allow-origin': getCorsOrigin(req),
                  })
                  res.end()
                  return
                }
              }
              const bootstrap = await loadBootstrap(company.id)
              sendJson(res, 200, { company, ...bootstrap })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/spec') {
              // Per-tenant static config; same caching policy as /api/features.
              res.setHeader('Cache-Control', 'private, max-age=300')
              sendJson(res, 200, {
                product: 'Sitelayer',
                company,
                workflow: WORKFLOW_STAGES,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/session') {
              const userId = getCurrentUserId(req)
              const membershipRows = await getMemberships(pool, userId)
              sendJson(res, 200, {
                user: { id: userId, role: membershipRows[0]?.role ?? 'admin' },
                activeCompany: company,
                memberships: membershipRows,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/projects') {
              const query = parseProjectsQuery(url.searchParams)
              const built = buildListProjectsQuery(company.id, query)
              const result = await pool.query(built.sql, built.values)
              const projects = result.rows
              const nextCursor =
                projects.length === built.limit ? (projects[projects.length - 1]?.updated_at ?? null) : null
              sendJson(res, 200, { projects, nextCursor })
              return
            }

            // Customer routes (GET /api/customers, POST/PATCH/DELETE
            // /api/customers[/<id>]) are handled by the extracted route
            // module. Same SQL, role gates, and ledger writes — just
            // relocated. See routes/customers.ts.
            if (
              await handleCustomerRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
                backfillCustomerMapping: (companyId, customer, executor) =>
                  backfillCustomerMapping(pool, companyId, customer, executor),
              })
            ) {
              return
            }

            // Worker routes (GET /api/workers, POST/PATCH/DELETE
            // /api/workers[/<id>]) are handled by the extracted route
            // module. Same SQL, role gates, and ledger writes — just
            // relocated. See routes/workers.ts.
            if (
              await handleWorkerRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/divisions') {
              sendJson(res, 200, { divisions: await listDivisions(company.id) })
              return
            }

            // Pricing-profile routes (GET/POST /api/pricing-profiles,
            // PATCH/DELETE /api/pricing-profiles/<id>) are handled by the
            // extracted route module. See routes/pricing-profiles.ts.
            if (
              await handlePricingProfileRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Bonus-rule routes (GET/POST /api/bonus-rules,
            // PATCH/DELETE /api/bonus-rules/<id>) are handled by the
            // extracted route module. See routes/bonus-rules.ts.
            if (
              await handleBonusRuleRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Audit event route (admin-only GET /api/audit-events). See
            // routes/audit-events.ts.
            if (
              await handleAuditEventRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // Support/debug packets let users submit a bounded, redacted
            // client timeline that the API enriches with audit/queue context.
            if (
              await handleSupportPacketRoutes(req, url, {
                pool,
                company,
                identity,
                tier: appConfig.tier,
                buildSha,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // QBO mapping routes (GET/POST /api/integrations/qbo/mappings,
            // PATCH/DELETE /api/integrations/qbo/mappings/<id>) are handled
            // by the extracted route module. See routes/qbo-mappings.ts.
            if (
              await handleQboMappingRoutes(req, url, {
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
                listMappings: (companyId, provider, entityType) =>
                  listIntegrationMappings(pool, companyId, provider, entityType),
                upsertMapping: (companyId, provider, values, executor) =>
                  upsertIntegrationMapping(pool, companyId, provider, values, executor),
              })
            ) {
              return
            }

            // Sync routes (status/process at this position; events/outbox
            // are matched here too because handleSyncRoutes covers all four).
            if (
              await handleSyncRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // QBO auth, connection, and sync routes. See routes/qbo.ts.
            if (
              await handleQboRoutes(req, url, {
                pool,
                company,
                currentUserId: getCurrentUserId(req),
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                sendRedirect: (location) => sendRedirect(res, location),
                qboConfig: {
                  clientId: qboClientId,
                  clientSecret: qboClientSecret,
                  redirectUri: qboRedirectUri,
                  successRedirectUri: qboSuccessRedirectUri,
                  stateSecret: qboStateSecret,
                  baseUrl: qboBaseUrl,
                },
              })
            ) {
              return
            }
            // Service-item mutation routes (POST /api/service-items,
            // PATCH/DELETE /api/service-items/<code>) handled by the
            // extracted route module. Code-keyed (not uuid). See
            // routes/service-items.ts.
            if (
              await handleServiceItemRoutes(req, url, {
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Project mutation routes (POST /api/projects, PATCH /api/projects/<id>,
            // POST /api/projects/<id>/closeout, GET /api/projects/<id>/summary)
            // handled by the extracted route module. See routes/projects.ts.
            if (
              await handleProjectRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Material-bill routes (GET/POST /api/projects/<id>/material-bills,
            // PATCH/DELETE /api/material-bills/<id>) handled by the extracted
            // route module. See routes/material-bills.ts.
            if (
              await handleMaterialBillRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Takeoff measurement read + LWW-gated PATCH/DELETE handled by
            // the extracted route module. POST handlers stay here because
            // they share catalog-enforcement helpers with measurement
            // create. See routes/takeoff-measurements.ts.
            if (
              await handleTakeoffMeasurementRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
                assertBlueprintDocumentsBelongToProject: (companyId, projectId, blueprintDocumentIds) =>
                  assertBlueprintDocumentsBelongToProject(pool, companyId, projectId, blueprintDocumentIds),
              })
            ) {
              return
            }

            // ---------------------------------------------------------------
            // Rental inventory replacement — inventory catalog, job rental
            // contracts, movement ledger, and generated billing runs.
            // ---------------------------------------------------------------
            if (
              await handleRentalInventoryRoutes(req, url, {
                pool,
                company,
                currentUserId: getCurrentUserId(req),
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // ---------------------------------------------------------------
            // Rentals — Avontus-style equipment rental tracking.
            //
            // All mutations are gated to admin/office because rental invoices
            // feed billing, not field data capture.
            // ---------------------------------------------------------------

            // Rental routes (GET/POST /api/rentals, PATCH/DELETE/invoice
            // /api/rentals/<id>) handled by the extracted route module. See
            // routes/rentals.ts.
            if (
              await handleRentalRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Crew-schedule routes (POST /api/schedules,
            // GET /api/projects/<id>/schedules,
            // POST /api/schedules/<id>/confirm) handled by the extracted
            // route module. See routes/schedules.ts.
            if (
              await handleScheduleRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
              })
            ) {
              return
            }

            // Labor-entry routes (POST/GET /api/labor-entries,
            // PATCH/DELETE /api/labor-entries/<id>) handled by the
            // extracted route module. See routes/labor-entries.ts.
            if (
              await handleLaborEntryRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                assertDivisionAllowedForServiceItem: (companyId, serviceItemCode, divisionCode) =>
                  assertDivisionAllowedForServiceItem(companyId, serviceItemCode, divisionCode),
              })
            ) {
              return
            }

            // ----------------------------------------------------------------
            // Clock events: geofenced passive clock-in/out for crew members.
            // Every membership role can clock themselves in/out. Foreman/admin
            // see the team timeline via GET /api/clock/timeline.
            // Routes handled by routes/clock.ts.
            // ----------------------------------------------------------------
            if (
              await handleClockRoutes(req, url, {
                pool,
                company,
                currentUserId: identity.userId,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // Takeoff write routes (POST /api/projects/<id>/takeoff/measurement,
            // POST /api/projects/<id>/takeoff/measurements) handled by the
            // extracted route module. See routes/takeoff-write.ts.
            if (
              await handleTakeoffWriteRoutes(req, url, {
                pool,
                company,
                currentUserId: getCurrentUserId(req),
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // Estimate routes (POST estimate/recompute, GET estimate/scope-vs-bid,
            // GET estimate.pdf, POST estimate/forecast-hours, GET/PUT service-items/<code>/divisions)
            // handled by the extracted route module. See routes/estimate.ts.
            if (
              await handleEstimateRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                sendPdf: async (contentDisposition, input) => {
                  res.writeHead(200, {
                    'content-type': 'application/pdf',
                    'content-disposition': contentDisposition,
                    'cache-control': 'no-store',
                    'access-control-allow-origin': getCorsOrigin(req),
                    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                    'access-control-allow-headers': CORS_ALLOW_HEADERS,
                    'access-control-allow-credentials': 'true',
                    'x-request-id': getRequestContext()?.requestId ?? '',
                  })
                  await renderEstimatePdf(input, res)
                },
              })
            ) {
              return
            }

            // Analytics routes (GET /api/analytics, /history, /divisions,
            // /service-item-productivity, /labor/by-{item,worker,week})
            // handled by the extracted route module. See routes/analytics.ts.
            if (
              await handleAnalyticsRoutes(req, url, {
                pool,
                company,
                currentUserId: identity.userId,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
            ) {
              return
            }

            // Blueprint document routes (GET/POST /api/projects/<id>/blueprints,
            // PATCH /api/blueprints/<id>, POST /api/blueprints/<id>/versions,
            // GET /api/blueprints/<id>/file, DELETE /api/blueprints/<id>)
            // handled by the extracted route module. See routes/blueprints.ts.
            if (
              await handleBlueprintRoutes(req, url, {
                pool,
                company,
                requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                checkVersion: (table, where, params, expectedVersion) =>
                  checkVersion(table, where, params, expectedVersion, res, req),
                storage,
                maxBlueprintUploadBytes,
                blueprintDownloadPresigned,
                sendFileContent: (mimeType, fileName, content) => {
                  res.writeHead(200, {
                    'content-type': mimeType,
                    'content-disposition': `inline; filename="${fileName}"`,
                    'access-control-allow-origin': getCorsOrigin(req),
                    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                    'access-control-allow-headers': CORS_ALLOW_HEADERS,
                  })
                  res.end(content)
                },
                sendFileRedirect: (location) => {
                  res.writeHead(302, {
                    location,
                    'cache-control': 'no-store',
                    'access-control-allow-origin': getCorsOrigin(req),
                    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                    'access-control-allow-headers': CORS_ALLOW_HEADERS,
                  })
                  res.end()
                },
              })
            ) {
              return
            }

            if (req.method === 'GET' && url.pathname.startsWith('/api/debug/traces/')) {
              const authResult = authorizeDebugTraceRequest({
                debugToken: process.env.DEBUG_TRACE_TOKEN,
                tier: appConfig.tier,
                allowProd: process.env.DEBUG_ALLOW_PROD,
                authorizationHeader: req.headers['authorization'],
                requestId,
              })
              if (!authResult.ok) {
                if (authResult.authenticate) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer-debug"')
                }
                sendJson(res, authResult.status, authResult.body)
                return
              }
              const presented = authResult.presentedToken
              const rlKey = (req.socket.remoteAddress ?? 'unknown') + ':' + presented.slice(0, 8)
              if (!debugRateLimit(rlKey)) {
                res.setHeader('retry-after', '6')
                sendJson(res, 429, { error: 'rate limit exceeded', request_id: requestId })
                return
              }
              const lookupId = url.pathname.slice('/api/debug/traces/'.length).trim()
              const byRequest = url.searchParams.get('by') === 'request_id'
              if (!lookupId || lookupId.includes('/')) {
                sendJson(res, 400, { error: 'invalid trace id', request_id: requestId })
                return
              }
              logger.info({ scope: 'debug_trace', target: lookupId, by_request: byRequest }, 'debug trace lookup')
              Sentry.setTag('debug_trace_lookup', '1')
              try {
                let traceId = byRequest ? null : lookupId
                const queueRows = await fetchQueueRowsForTraceOrRequest(
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
                  company.id,
                  byRequest ? { requestId: lookupId } : { traceId: traceId ?? lookupId },
                )
                sendJson(res, 200, {
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
                sendJson(res, status, {
                  error: err instanceof Error ? err.message : 'debug trace lookup failed',
                  request_id: requestId,
                })
              }
              return
            }

            sendJson(res, 404, { error: 'not found' })
          } catch (error) {
            logger.error({ err: error }, 'unhandled request error')
            Sentry.captureException(error)
            const status =
              error instanceof HttpError ? error.status : error instanceof BlueprintUploadError ? error.status : 500
            if (rootSpan) {
              rootSpan.setStatus({ code: 2, message: error instanceof Error ? error.message : 'internal_error' })
            }
            sendJson(res, status, {
              error: error instanceof Error ? error.message : 'internal server error',
              request_id: requestId,
            })
          }
        },
      )
    }),
  )
})

server.listen(port, () => {
  logger.info({ port }, '[api] listening')
})

let shutdownStarted = false

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return
  shutdownStarted = true
  logger.info({ signal }, '[api] shutting down')

  const forceExit = setTimeout(
    () => {
      logger.error({ signal }, '[api] shutdown timed out')
      process.exit(1)
    },
    Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000),
  )
  forceExit.unref()

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    await pool.end()
    await Sentry.flush(2_000)
    clearTimeout(forceExit)
    logger.info({ signal }, '[api] shutdown complete')
    process.exit(0)
  } catch (err) {
    clearTimeout(forceExit)
    logger.error({ err, signal }, '[api] shutdown failed')
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

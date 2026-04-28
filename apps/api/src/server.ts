import { Sentry } from './instrument.js'
import http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Pool, type PoolConfig } from 'pg'
import { processRentalInvoice, RENTAL_SELECT_COLUMNS, type RentalRow } from '@sitelayer/queue'
import { createLogger, getRequestContext, runWithRequestContext, type RequestContext } from '@sitelayer/logger'
import {
  authorizeDebugTraceRequest,
  DebugTraceError,
  fetchSentryTrace,
  parseTraceIdFromSentryTraceHeader,
} from './debug-trace.js'
import {
  DEFAULT_BONUS_RULE,
  LA_TEMPLATE,
  WORKFLOW_STAGES,
  calculateBonusPayout,
  calculateGeometryQuantity,
  calculateMargin,
  calculateTakeoffQuantity,
  calculateProjectCost,
  compareBidVsScope,
  computeProductivity,
  formatMoney,
  haversineDistanceMeters,
  initialRentalNextInvoiceAt,
  isInsideGeofence,
  normalizeGeometry,
  normalizePolygonGeometry,
} from '@sitelayer/domain'
import { loadAppConfig, logAppConfigBanner, postgresOptionsForTier, TierConfigError } from './tier.js'
import { validateQboStateSecret } from './qbo-config.js'
import { normalizeCompanyRole, type ActiveCompany, type CompanyRole } from './auth-types.js'
import { handleAuditEventRoutes } from './routes/audit-events.js'
import { handleBonusRuleRoutes } from './routes/bonus-rules.js'
import { handleCustomerRoutes } from './routes/customers.js'
import { handlePricingProfileRoutes } from './routes/pricing-profiles.js'
import { handleQboMappingRoutes } from './routes/qbo-mappings.js'
import { handleServiceItemRoutes } from './routes/service-items.js'
import { getSyncStatus, handleSyncRoutes } from './routes/sync.js'
import { handleWorkerRoutes } from './routes/workers.js'
import {
  CORS_ALLOW_HEADERS,
  HttpError,
  getCorsOrigin as getCorsOriginImpl,
  isValidDateInput,
  isValidUuid,
  parseExpectedVersion,
  parseOptionalNumber,
  readBody as readBodyImpl,
  sendJson as sendJsonImpl,
  sendRedirect,
} from './http-utils.js'
import {
  attachMutationTx,
  enqueueAdminAlert,
  enqueueNotification,
  recordMutationLedger,
  recordSyncEvent,
  withMutationTx,
  type LedgerExecutor,
} from './mutation-tx.js'
import {
  assertKeyInCompany,
  buildBlueprintStorageKey,
  createBlueprintStorage,
  getBlueprintMimeType,
  readStorageEnv,
  StorageError,
  type BlueprintStorage,
} from './storage.js'
import {
  BlueprintUploadError,
  isMultipartRequest,
  parseBlueprintMultipart,
  type BlueprintMultipartResult,
} from './blueprint-upload.js'
import { recordAudit } from './audit.js'
import { buildEstimatePdfInputFromSummary, renderEstimatePdf } from './pdf.js'
import { buildListProjectsQuery, parseProjectsQuery } from './projects-query.js'
import { listLaborByItem, listLaborByWeek, listLaborByWorker, parseLaborReportFilters } from './labor-reports.js'
import {
  assertServiceItemCatalogStatus as assertServiceItemCatalogStatusImpl,
  loadServiceItemCatalogIndex,
  rejectionMessageForCatalog,
} from './catalog.js'
import { evaluateLww } from './lww.js'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from './onboarding.js'
import { AuthConfigError, AuthError, loadAuthConfig, resolveIdentity, type Identity } from './auth.js'
import { extractSvixHeaders, verifyClerkWebhook } from './clerk-webhook.js'
import {
  extractIntuitSignature,
  flattenQboWebhookPayload,
  parseQboWebhookPayload,
  verifyQboWebhook,
} from './qbo-webhook.js'
import { attachPool, observeAudit, observeRequest, renderMetrics } from './metrics.js'
import { loadEmailConfig } from './email.js'
import { QboParseError, parseQboClass, parseQboEstimateCreateResponse, parseQboItem } from './qbo-parse.js'
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

type IntegrationMappingRow = {
  id: string
  provider: string
  entity_type: string
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type BlueprintDocumentRow = {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  preview_type: string
  calibration_length: string | null
  calibration_unit: string | null
  sheet_scale: string | null
  version: number
  deleted_at: string | null
  replaces_blueprint_document_id: string | null
  file_url: string
  created_at: string
}

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

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return cleaned || 'blueprint.pdf'
}

function getBlueprintFilePath(companyId: string, blueprintId: string, fileName: string): string {
  return buildBlueprintStorageKey(companyId, blueprintId, fileName)
}

function assertBlueprintFilePath(companyId: string, filePath: string): string {
  try {
    return assertKeyInCompany(companyId, filePath)
  } catch (err) {
    if (err instanceof StorageError) throw new HttpError(err.status, err.message)
    throw err
  }
}

function resolveBlueprintStoragePath(
  companyId: string,
  blueprintId: string,
  fileName: string,
  requestedPath?: string | null,
): string {
  const cleanRequested = requestedPath?.trim()
  if (!cleanRequested) return buildBlueprintStorageKey(companyId, blueprintId, fileName)
  return assertBlueprintFilePath(companyId, cleanRequested)
}

async function persistBlueprintFile(
  companyId: string,
  blueprintId: string,
  fileName: string,
  contentsBase64: string,
): Promise<string> {
  const key = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  const source = contentsBase64.includes(',') ? (contentsBase64.split(',', 2)[1] ?? '') : contentsBase64
  await storage.put(key, Buffer.from(source, 'base64'), getBlueprintMimeType(fileName))
  return key
}

async function copyBlueprintFile(
  companyId: string,
  blueprintId: string,
  sourcePath: string,
  fileName: string,
): Promise<string> {
  const sourceKey = assertBlueprintFilePath(companyId, sourcePath)
  const destKey = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  await storage.copy(sourceKey, destKey)
  return destKey
}

// Bounded exponential backoff for transient QBO failures: 429 (rate limit)
// and 5xx are retried up to 3 times with 200ms / 1s / 5s delays. 4xx other
// than 429 fail fast — those are auth/validation errors that won't recover.
// We deliberately don't retry forever (would hold HTTP request handlers
// open during a long QBO outage); the request fails after ~6s of attempts
// and the caller surfaces 5xx to the user.
const QBO_RETRY_DELAYS_MS = [200, 1000, 5000] as const

function qboShouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

async function qboFetch<T>(url: string, init: RequestInit): Promise<T> {
  let lastStatus = 0
  let lastStatusText = ''
  for (let attempt = 0; attempt <= QBO_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(url, init)
    if (response.ok) return (await response.json()) as T
    lastStatus = response.status
    lastStatusText = response.statusText
    if (!qboShouldRetry(response.status) || attempt === QBO_RETRY_DELAYS_MS.length) {
      throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
    }
    const delay = QBO_RETRY_DELAYS_MS[attempt] ?? 0
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  // Unreachable, but satisfies the type checker.
  throw new Error(`QBO API error: ${lastStatus} ${lastStatusText}`)
}

async function qboGet<T>(endpoint: string, realmId: string, accessToken: string): Promise<T> {
  return qboFetch<T>(`${qboBaseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
}

async function qboPost<T>(endpoint: string, realmId: string, accessToken: string, body: unknown): Promise<T> {
  return qboFetch<T>(`${qboBaseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
}

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

async function getMemberships(userId: string) {
  const result = await pool.query(
    `
    select cm.id, cm.company_id, cm.clerk_user_id, cm.role, cm.created_at, c.slug, c.name
    from company_memberships cm
    join companies c on c.id = cm.company_id
    where cm.clerk_user_id = $1
    order by c.created_at asc
    `,
    [userId],
  )
  return result.rows
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

type QboOAuthState = {
  companyId: string
  userId: string
  exp: number
  nonce: string
}

function signQboStatePayload(payload: string) {
  return createHmac('sha256', qboStateSecret).update(payload).digest('base64url')
}

function isSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function encodeQboState(state: QboOAuthState) {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = signQboStatePayload(payload)
  return `${payload}.${signature}`
}

function decodeQboState(rawState: string): QboOAuthState {
  const [payload, signature] = rawState.split('.', 2)
  if (!payload || !signature || !isSafeEqual(signQboStatePayload(payload), signature)) {
    throw new HttpError(400, 'invalid state')
  }

  let parsed: QboOAuthState
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as QboOAuthState
  } catch {
    throw new HttpError(400, 'invalid state')
  }

  if (!parsed.companyId || !parsed.userId || !parsed.exp || parsed.exp < Date.now()) {
    throw new HttpError(400, 'expired state')
  }
  return parsed
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

async function getIntegrationConnection(companyId: string, provider: string, executor: LedgerExecutor = pool) {
  const result = await executor.query(
    `
    select id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

async function getIntegrationConnectionWithSecrets(companyId: string, provider: string) {
  const result = await pool.query(
    `
    select id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

async function listIntegrationMappings(companyId: string, provider: string, entityType?: string | null) {
  const filters: string[] = ['company_id = $1', 'provider = $2', 'deleted_at is null']
  const values: unknown[] = [companyId, provider]
  if (entityType) {
    values.push(entityType)
    filters.push(`entity_type = $${values.length}`)
  }
  const result = await pool.query(
    `
    select id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    from integration_mappings
    where ${filters.join(' and ')}
    order by entity_type asc, created_at asc
    `,
    values,
  )
  return result.rows as IntegrationMappingRow[]
}

async function upsertIntegrationMapping(
  companyId: string,
  provider: string,
  values: {
    entity_type: string
    local_ref: string
    external_id: string
    label?: string | null
    status?: string | null
    notes?: string | null
  },
  executor: LedgerExecutor = pool,
) {
  const result = await executor.query(
    `
    insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
    values ($1, $2, $3, $4, $5, $6, coalesce($7, 'active'), $8)
    on conflict (company_id, provider, entity_type, local_ref)
    do update set
      external_id = excluded.external_id,
      label = coalesce(excluded.label, integration_mappings.label),
      status = coalesce(excluded.status, integration_mappings.status),
      notes = coalesce(excluded.notes, integration_mappings.notes),
      version = integration_mappings.version + 1,
      updated_at = now(),
      deleted_at = null
    returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    `,
    [
      companyId,
      provider,
      values.entity_type,
      values.local_ref,
      values.external_id,
      values.label ?? null,
      values.status ?? 'active',
      values.notes ?? null,
    ],
  )
  return result.rows[0] as IntegrationMappingRow
}

async function backfillCustomerMapping(
  companyId: string,
  customer: { id: string; external_id: string | null; name: string },
  executor: LedgerExecutor = pool,
) {
  if (!customer.external_id) return null
  const mapping = await upsertIntegrationMapping(
    companyId,
    'qbo',
    {
      entity_type: 'customer',
      local_ref: customer.id,
      external_id: customer.external_id,
      label: customer.name,
      status: 'active',
      notes: 'backfilled from customer external_id',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

async function backfillServiceItemMapping(
  companyId: string,
  serviceItem: { code: string; name: string; source?: string | null },
  externalId?: string | null,
  executor: LedgerExecutor = pool,
) {
  const resolvedExternalId = externalId ?? (serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null)
  if (!resolvedExternalId) return null
  const mapping = await upsertIntegrationMapping(
    companyId,
    'qbo',
    {
      entity_type: 'service_item',
      local_ref: serviceItem.code,
      external_id: resolvedExternalId,
      label: serviceItem.name,
      status: 'active',
      notes:
        serviceItem.source === 'qbo'
          ? 'backfilled from qbo service_item import'
          : 'backfilled from qbo-prefixed service_item',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

async function backfillDivisionMapping(
  companyId: string,
  division: { code: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  const mapping = await upsertIntegrationMapping(
    companyId,
    'qbo',
    {
      entity_type: 'division',
      local_ref: division.code,
      external_id: externalId,
      label: division.name,
      status: 'active',
      notes: 'backfilled from qbo class sync',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

async function backfillProjectMapping(
  companyId: string,
  project: { id: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  const mapping = await upsertIntegrationMapping(
    companyId,
    'qbo',
    {
      entity_type: 'project',
      local_ref: project.id,
      external_id: externalId,
      label: project.name,
      status: 'active',
      notes: 'backfilled from qbo estimate push',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

async function upsertIntegrationConnection(
  companyId: string,
  provider: string,
  values: {
    provider_account_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
    webhook_secret?: string | null
    sync_cursor?: string | null
    status?: string | null
  },
  executor: LedgerExecutor = pool,
) {
  const existing = await getIntegrationConnection(companyId, provider, executor)
  if (!existing) {
    const inserted = await executor.query(
      `
      insert into integration_connections (
        company_id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, status
      )
      values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'connected'))
      returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
      `,
      [
        companyId,
        provider,
        values.provider_account_id ?? null,
        values.access_token ?? null,
        values.refresh_token ?? null,
        values.webhook_secret ?? null,
        values.sync_cursor ?? null,
        values.status ?? 'connected',
      ],
    )
    return inserted.rows[0]
  }

  const updated = await executor.query(
    `
    update integration_connections
    set
      provider_account_id = coalesce($3, provider_account_id),
      access_token = coalesce($4, access_token),
      refresh_token = coalesce($5, refresh_token),
      webhook_secret = coalesce($6, webhook_secret),
      sync_cursor = coalesce($7, sync_cursor),
      status = coalesce($8, status),
      last_synced_at = coalesce(last_synced_at, now()),
      version = version + 1
    where company_id = $1 and provider = $2 and id = $9
    returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    `,
    [
      companyId,
      provider,
      values.provider_account_id ?? null,
      values.access_token ?? null,
      values.refresh_token ?? null,
      values.webhook_secret ?? null,
      values.sync_cursor ?? null,
      values.status ?? null,
      existing.id,
    ],
  )
  return updated.rows[0] ?? existing
}

// countQueueRows / processQueue / getSyncStatus moved to routes/sync.ts.

async function summarizeProject(companyId: string, projectId: string) {
  const projectResult = await pool.query(
    'select id, company_id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, version from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, estimateLinesResult, laborEntriesResult, materialBillsResult, bonusRuleResult] =
    await Promise.all([
      pool.query(
        'select service_item_code, quantity, unit, notes, created_at from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, quantity, unit, rate, amount, created_at from estimate_lines where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, hours, sqft_done, status, occurred_on from labor_entries where company_id = $1 and project_id = $2 order by occurred_on desc, created_at desc',
        [companyId, projectId],
      ),
      pool.query(
        'select amount, bill_type from material_bills where company_id = $1 and project_id = $2 and deleted_at is null',
        [companyId, projectId],
      ),
      pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
    ])

  const laborCost = laborEntriesResult.rows.reduce(
    (total, entry) => total + Number(entry.hours) * Number(project.labor_rate ?? 0),
    0,
  )
  const materialCost = materialBillsResult.rows
    .filter((b) => b.bill_type !== 'sub')
    .reduce((total, b) => total + Number(b.amount ?? 0), 0)
  const subCost = materialBillsResult.rows
    .filter((b) => b.bill_type === 'sub')
    .reduce((total, b) => total + Number(b.amount ?? 0), 0)
  const totalCost = calculateProjectCost({ laborCost, materialCost, subCost })
  const margin = calculateMargin({ revenue: Number(project.bid_total ?? 0), cost: totalCost })
  const bonusTiers = bonusRuleResult.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const bonus = calculateBonusPayout(margin.margin, Number(project.bonus_pool ?? 0), bonusTiers)
  const totalMeasurementQuantity = measurementsResult.rows.reduce(
    (total, measurement) => total + Number(measurement.quantity),
    0,
  )
  const estimateTotal = estimateLinesResult.rows.reduce((total, line) => total + Number(line.amount), 0)

  return {
    project,
    metrics: {
      totalMeasurementQuantity,
      estimateTotal,
      laborCost,
      materialCost,
      subCost,
      totalCost,
      margin,
      bonus,
    },
    measurements: measurementsResult.rows,
    estimateLines: estimateLinesResult.rows,
    laborEntries: laborEntriesResult.rows,
  }
}

async function listBlueprintDocuments(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select
      id,
      project_id,
      file_name,
      storage_path,
      preview_type,
      calibration_length,
      calibration_unit,
      sheet_scale,
      version,
      deleted_at,
      replaces_blueprint_document_id,
      concat('/api/blueprints/', id, '/file') as file_url,
      created_at
    from blueprint_documents
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by version desc, created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows as BlueprintDocumentRow[]
}

async function listTakeoffMeasurements(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
    from takeoff_measurements
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows
}

async function listSchedules(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
    from crew_schedules
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by scheduled_for desc, created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows
}

async function createEstimateFromMeasurements(companyId: string, projectId: string, executor: LedgerExecutor = pool) {
  const projectResult = await executor.query<{
    id: string
    bid_total: string | number | null
    labor_rate: string | number | null
    bonus_pool: string | number | null
    division_code: string | null
  }>(
    'select id, bid_total, labor_rate, bonus_pool, division_code from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, serviceItemsResult] = await Promise.all([
    executor.query<{
      service_item_code: string
      quantity: string | number
      unit: string
      notes: string | null
      division_code: string | null
    }>(
      'select service_item_code, quantity, unit, notes, division_code from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
      [companyId, projectId],
    ),
    executor.query<{ code: string; default_rate: string | null; unit: string }>(
      'select code, default_rate, unit from service_items where company_id = $1',
      [companyId],
    ),
  ])

  const itemIndex = new Map<string, { default_rate: string | null; unit: string }>()
  for (const item of serviceItemsResult.rows) {
    itemIndex.set(item.code, { default_rate: item.default_rate, unit: item.unit })
  }

  await executor.query('delete from estimate_lines where company_id = $1 and project_id = $2', [companyId, projectId])

  const projectDivisionCode = project.division_code ?? null
  type EstimateLineRow = {
    service_item_code: string
    quantity: string | number
    unit: string
    rate: number
    amount: number
    division_code: string | null
    created_at: string
  }
  let createdLines: EstimateLineRow[] = []
  if (measurementsResult.rows.length > 0) {
    // Single multi-row INSERT replaces the previous N round-trips. unnest()
    // turns the parallel arrays back into one row per measurement so we keep
    // the per-measurement rate/amount semantics.
    const codes: string[] = []
    const quantities: string[] = []
    const units: string[] = []
    const rates: string[] = []
    const amounts: string[] = []
    const divisions: (string | null)[] = []
    for (const measurement of measurementsResult.rows) {
      const item = itemIndex.get(measurement.service_item_code)
      const rate = Number(item?.default_rate ?? 0)
      const amount = Number(measurement.quantity) * rate
      // Per WhatsApp:227-229: an estimate line inherits the measurement's
      // division_code when the takeoff captured one, otherwise falls back to
      // the project's division_code so existing flows keep working.
      const effectiveDivisionCode = measurement.division_code ?? projectDivisionCode
      codes.push(measurement.service_item_code)
      quantities.push(String(measurement.quantity))
      units.push(item?.unit ?? measurement.unit)
      rates.push(String(rate))
      amounts.push(String(amount))
      divisions.push(effectiveDivisionCode)
    }
    const insertResult = await executor.query<EstimateLineRow>(
      `
      insert into estimate_lines (company_id, project_id, service_item_code, quantity, unit, rate, amount, division_code)
      select
        $1::uuid,
        $2::uuid,
        code,
        quantity::numeric,
        unit,
        rate::numeric,
        amount::numeric,
        division_code
      from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
        as t(code, quantity, unit, rate, amount, division_code)
      returning service_item_code, quantity, unit, rate, amount, division_code, created_at
      `,
      [companyId, projectId, codes, quantities, units, rates, amounts, divisions],
    )
    createdLines = insertResult.rows
  }

  const scopeTotal = createdLines.reduce((total, line) => total + Number(line.amount), 0)
  // Preserve the human-entered bid_total once set. Only overwrite it on the
  // first estimate computation for a brand-new project (bid_total === 0),
  // which keeps the seed/demo flow working. Afterwards, bid_total is the
  // source of truth for the contract price and drift is surfaced through
  // `scope_vs_bid`.
  const existingBidTotal = Number(project.bid_total ?? 0)
  const bidTotal = existingBidTotal > 0 ? existingBidTotal : scopeTotal
  if (existingBidTotal <= 0 && scopeTotal > 0) {
    await executor.query(
      'update projects set bid_total = $1, updated_at = now(), version = version + 1 where company_id = $2 and id = $3',
      [scopeTotal, companyId, projectId],
    )
  } else {
    await executor.query(
      'update projects set updated_at = now(), version = version + 1 where company_id = $1 and id = $2',
      [companyId, projectId],
    )
  }

  return {
    projectId,
    bidTotal,
    scopeTotal,
    lines: createdLines,
  }
}

/**
 * Fetch the project's stored `bid_total` and the current sum of
 * estimate_lines.amount, then return the scope-vs-bid summary. Returns null
 * if the project does not exist for the given company.
 *
 * The estimate_lines payload mirrors what clients already receive from the
 * estimate endpoints (service_item_code + quantity + unit + rate + amount +
 * division_code when present) so the UI can render a side-by-side list next
 * to the comparison header.
 */
async function getScopeVsBid(companyId: string, projectId: string) {
  const projectResult = await pool.query<{ bid_total: string | number | null }>(
    'select bid_total from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const linesResult = await pool.query(
    `select service_item_code, quantity, unit, rate, amount, division_code, created_at
     from estimate_lines
     where company_id = $1 and project_id = $2
     order by created_at asc, service_item_code asc`,
    [companyId, projectId],
  )

  const bidTotal = Number(project.bid_total ?? 0)
  const scopeTotal = linesResult.rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const comparison = compareBidVsScope({ bidTotal, scopeTotal })

  return {
    ...comparison,
    lines: linesResult.rows,
  }
}

async function listServiceItemDivisions(companyId: string, serviceItemCode: string) {
  const result = await pool.query<{ division_code: string; created_at: string }>(
    `select division_code, created_at
     from service_item_divisions
     where company_id = $1 and service_item_code = $2
     order by division_code asc`,
    [companyId, serviceItemCode],
  )
  return result.rows
}

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
function assertServiceItemCatalogStatus(companyId: string, serviceItemCode: string, divisionCode: string | null) {
  return assertServiceItemCatalogStatusImpl(pool, companyId, serviceItemCode, divisionCode)
}

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

type PreparedTakeoffMeasurementInput = {
  serviceItemCode: string
  quantity: number
  unit: string
  notes: string | null
  geometryJson: string | null
  blueprintDocumentId: string | null
  divisionCode: string | null
}

function prepareTakeoffMeasurementInput(rawInput: unknown, label = 'measurement'): PreparedTakeoffMeasurementInput {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new HttpError(400, `${label} must be an object`)
  }

  const input = rawInput as Record<string, unknown>
  const serviceItemCode = String(input.service_item_code ?? '').trim()
  const unit = String(input.unit ?? '').trim()
  const notes =
    input.notes === undefined || input.notes === null || String(input.notes).trim() === '' ? null : String(input.notes)
  const blueprintDocumentId =
    input.blueprint_document_id === undefined ||
    input.blueprint_document_id === null ||
    input.blueprint_document_id === ''
      ? null
      : String(input.blueprint_document_id)
  const divisionCode =
    input.division_code === undefined || input.division_code === null || String(input.division_code).trim() === ''
      ? null
      : String(input.division_code).trim()

  if (!serviceItemCode) {
    throw new HttpError(400, `${label}.service_item_code is required`)
  }
  if (!unit) {
    throw new HttpError(400, `${label}.unit is required`)
  }
  if (blueprintDocumentId && !isValidUuid(blueprintDocumentId)) {
    throw new HttpError(400, `${label}.blueprint_document_id must be a valid uuid`)
  }

  const rawGeometry = input.geometry
  let quantity = Number(input.quantity ?? 0)
  let geometryJson: string | null = null
  if (rawGeometry !== undefined && rawGeometry !== null && rawGeometry !== '') {
    const geometry = normalizeGeometry(rawGeometry)
    if (!geometry) {
      throw new HttpError(
        400,
        `${label}.geometry must be a polygon (>=3 points), a lineal path (>=2 points), or a volume box with positive L/W/H`,
      )
    }
    quantity = calculateGeometryQuantity(geometry)
    // Reject NaN/Infinity explicitly: a self-intersecting polygon or a
    // pathological volume box can produce NaN, and `n <= 0` is false for NaN
    // so the trailing check would emit a less specific error.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `${label}.geometry must produce a positive, finite quantity`)
    }
    geometryJson = JSON.stringify(geometry)
  }

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new HttpError(400, `${label}.quantity must be a non-negative number`)
  }

  return {
    serviceItemCode,
    quantity,
    unit,
    notes,
    geometryJson,
    blueprintDocumentId,
    divisionCode,
  }
}

async function assertBlueprintDocumentsBelongToProject(
  companyId: string,
  projectId: string,
  blueprintDocumentIds: Array<string | null>,
) {
  const uniqueIds = Array.from(new Set(blueprintDocumentIds.filter((id): id is string => Boolean(id))))
  if (!uniqueIds.length) return

  const result = await pool.query<{ id: string }>(
    `
    select id
    from blueprint_documents
    where company_id = $1
      and project_id = $2
      and id = any($3::uuid[])
      and deleted_at is null
    `,
    [companyId, projectId, uniqueIds],
  )
  const validIds = new Set(result.rows.map((row) => row.id))
  const invalidIds = uniqueIds.filter((id) => !validIds.has(id))
  if (invalidIds.length) {
    throw new HttpError(400, 'blueprint_document_id must belong to the project')
  }
}

async function listAnalytics(companyId: string) {
  const [projectRows, laborRows, materialRows, bonusRules] = await Promise.all([
    pool.query(
      'select id, name, customer_name, division_code, status, bid_total, labor_rate, bonus_pool from projects where company_id = $1 order by updated_at desc',
      [companyId],
    ),
    pool.query(
      'select project_id, service_item_code, hours, sqft_done, occurred_on from labor_entries where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query(
      'select project_id, amount, bill_type from material_bills where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
  ])

  const bonusTiers = bonusRules.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const laborByProject = new Map<string, typeof laborRows.rows>()
  const materialByProject = new Map<string, typeof materialRows.rows>()

  for (const labor of laborRows.rows) {
    const list = laborByProject.get(labor.project_id) ?? []
    list.push(labor)
    laborByProject.set(labor.project_id, list)
  }

  for (const material of materialRows.rows) {
    const list = materialByProject.get(material.project_id) ?? []
    list.push(material)
    materialByProject.set(material.project_id, list)
  }

  const analytics = projectRows.rows.map((project) => {
    const projectLabor = laborByProject.get(project.id) ?? []
    const projectMaterial = materialByProject.get(project.id) ?? []

    const totalHours = projectLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
    const totalSqft = projectLabor.reduce((sum, l) => sum + Number(l.sqft_done ?? 0), 0)
    const laborCost = totalHours * Number(project.labor_rate ?? 0)
    const materialCost = projectMaterial
      .filter((m) => m.bill_type !== 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const subCost = projectMaterial
      .filter((m) => m.bill_type === 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const totalCost = laborCost + materialCost + subCost
    const revenue = Number(project.bid_total ?? 0)
    const profit = revenue - totalCost
    const margin = revenue > 0 ? profit / revenue : 0
    const bonus = calculateBonusPayout(margin, Number(project.bonus_pool ?? 0), bonusTiers)
    const sqftPerHr = totalHours > 0 ? totalSqft / totalHours : 0

    return {
      project,
      metrics: {
        totalHours,
        totalSqft,
        laborCost,
        materialCost,
        subCost,
        totalCost,
        revenue,
        profit,
        margin,
        bonus,
        sqftPerHr,
      },
    }
  })

  const byDivision = new Map<string, { revenue: number; cost: number; count: number }>()
  for (const row of analytics) {
    const current = byDivision.get(row.project.division_code) ?? { revenue: 0, cost: 0, count: 0 }
    current.revenue += row.metrics.revenue
    current.cost += row.metrics.totalCost
    current.count += 1
    byDivision.set(row.project.division_code, current)
  }

  return {
    projects: analytics,
    divisions: Array.from(byDivision.entries()).map(([divisionCode, totals]) => ({
      divisionCode,
      revenue: totals.revenue,
      cost: totals.cost,
      profit: totals.revenue - totals.cost,
      margin: totals.revenue > 0 ? ((totals.revenue - totals.cost) / totals.revenue) * 100 : 0,
      count: totals.count,
    })),
  }
}

async function listDivisionAnalytics(companyId: string, options: { since?: string | null } = {}) {
  const since = options.since && options.since.trim() ? options.since.trim() : null

  // TODO: once `workers` carries a `clerk_user_id` link (or a join table
  // between `workers` and `company_memberships` exists), scope results for
  // foreman/member roles to the divisions they have labor on. Today workers
  // are crew-only rows with no auth identity, so this helper is admin/office
  // only; the route returns 403 before reaching here for other roles.

  const projectQueryParams: Array<string> = [companyId]
  let projectWhere = 'where p.company_id = $1'
  if (since) {
    projectQueryParams.push(since)
    projectWhere += ' and (p.updated_at >= $2::date or p.closed_at >= $2::date)'
  }

  const [projectRows, laborRows, materialRows, divisionRows] = await Promise.all([
    pool.query(
      `select p.id, p.name, p.division_code, p.status, p.bid_total, p.labor_rate
       from projects p
       ${projectWhere}
       order by p.updated_at desc`,
      projectQueryParams,
    ),
    pool.query('select project_id, hours, sqft_done from labor_entries where company_id = $1 and deleted_at is null', [
      companyId,
    ]),
    pool.query(
      'select project_id, amount, bill_type from material_bills where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query('select code, name from divisions where company_id = $1 order by sort_order asc', [companyId]),
  ])

  const divisionNameByCode = new Map<string, string>()
  for (const row of divisionRows.rows) {
    divisionNameByCode.set(String(row.code), String(row.name))
  }

  type DivisionTotals = {
    total_revenue: number
    total_labor_cost: number
    total_material_cost: number
    total_sub_cost: number
    total_hours: number
    total_sqft: number
    project_count: number
    active_project_count: number
    completed_project_count: number
  }

  const totalsByDivision = new Map<string, DivisionTotals>()
  const ensureBucket = (code: string): DivisionTotals => {
    let bucket = totalsByDivision.get(code)
    if (!bucket) {
      bucket = {
        total_revenue: 0,
        total_labor_cost: 0,
        total_material_cost: 0,
        total_sub_cost: 0,
        total_hours: 0,
        total_sqft: 0,
        project_count: 0,
        active_project_count: 0,
        completed_project_count: 0,
      }
      totalsByDivision.set(code, bucket)
    }
    return bucket
  }

  const projectById = new Map<
    string,
    { id: string; division_code: string; status: string; labor_rate: number; bid_total: number }
  >()
  for (const project of projectRows.rows) {
    const code = String(project.division_code ?? '')
    if (!code) continue
    const bucket = ensureBucket(code)
    const revenue = Number(project.bid_total ?? 0)
    const laborRate = Number(project.labor_rate ?? 0)
    bucket.total_revenue += revenue
    bucket.project_count += 1
    const status = String(project.status ?? '')
    if (status === 'closed' || status === 'completed') {
      bucket.completed_project_count += 1
    } else {
      bucket.active_project_count += 1
    }
    projectById.set(String(project.id), {
      id: String(project.id),
      division_code: code,
      status,
      labor_rate: laborRate,
      bid_total: revenue,
    })
  }

  for (const labor of laborRows.rows) {
    const project = projectById.get(String(labor.project_id))
    if (!project) continue
    const bucket = totalsByDivision.get(project.division_code)
    if (!bucket) continue
    const hours = Number(labor.hours ?? 0)
    const sqft = Number(labor.sqft_done ?? 0)
    bucket.total_hours += hours
    bucket.total_sqft += sqft
    bucket.total_labor_cost += hours * project.labor_rate
  }

  for (const material of materialRows.rows) {
    const project = projectById.get(String(material.project_id))
    if (!project) continue
    const bucket = totalsByDivision.get(project.division_code)
    if (!bucket) continue
    const amount = Number(material.amount ?? 0)
    if (material.bill_type === 'sub') {
      bucket.total_sub_cost += amount
    } else {
      bucket.total_material_cost += amount
    }
  }

  const divisions = Array.from(totalsByDivision.entries())
    .map(([divisionCode, totals]) => {
      const totalCost = totals.total_labor_cost + totals.total_material_cost + totals.total_sub_cost
      const profit = totals.total_revenue - totalCost
      const margin = totals.total_revenue > 0 ? profit / totals.total_revenue : 0
      const sqftPerHour = totals.total_hours > 0 ? totals.total_sqft / totals.total_hours : 0

      return {
        division_code: divisionCode,
        division_name: divisionNameByCode.get(divisionCode) ?? divisionCode,
        project_count: totals.project_count,
        active_project_count: totals.active_project_count,
        completed_project_count: totals.completed_project_count,
        total_revenue: round2(totals.total_revenue),
        total_labor_cost: round2(totals.total_labor_cost),
        total_material_cost: round2(totals.total_material_cost),
        total_sub_cost: round2(totals.total_sub_cost),
        total_cost: round2(totalCost),
        profit: round2(profit),
        margin: round4(margin),
        total_hours: round2(totals.total_hours),
        total_sqft: round2(totals.total_sqft),
        sqft_per_hour: round2(sqftPerHour),
      }
    })
    .sort((a, b) => a.division_code.localeCompare(b.division_code))

  return { divisions, as_of: new Date().toISOString() }
}

async function listServiceItemProductivity(companyId: string) {
  const [laborRows, itemRows] = await Promise.all([
    pool.query(
      `select service_item_code, hours, sqft_done, occurred_on
       from labor_entries
       where company_id = $1
         and deleted_at is null
         and service_item_code is not null`,
      [companyId],
    ),
    pool.query('select code, name, unit from service_items where company_id = $1 and deleted_at is null', [companyId]),
  ])

  const itemsByCode = new Map<string, { code: string; name: string; unit: string }>()
  for (const row of itemRows.rows) {
    itemsByCode.set(String(row.code), { code: String(row.code), name: String(row.name), unit: String(row.unit) })
  }

  type EntryBucket = {
    entries: Array<{ quantity: number; hours: number }>
    firstSeen: string | null
    lastSeen: string | null
  }
  const byCode = new Map<string, EntryBucket>()
  for (const row of laborRows.rows) {
    const code = String(row.service_item_code ?? '').trim()
    if (!code) continue
    const quantity = Number(row.sqft_done ?? 0)
    const hours = Number(row.hours ?? 0)
    const occurredOn = row.occurred_on ? new Date(row.occurred_on).toISOString().slice(0, 10) : null

    let bucket = byCode.get(code)
    if (!bucket) {
      bucket = { entries: [], firstSeen: occurredOn, lastSeen: occurredOn }
      byCode.set(code, bucket)
    }
    bucket.entries.push({ quantity, hours })
    if (occurredOn) {
      if (!bucket.firstSeen || occurredOn < bucket.firstSeen) bucket.firstSeen = occurredOn
      if (!bucket.lastSeen || occurredOn > bucket.lastSeen) bucket.lastSeen = occurredOn
    }
  }

  const service_items = Array.from(byCode.entries())
    .map(([code, bucket]) => {
      const stats = computeProductivity({ entries: bucket.entries })
      const item = itemsByCode.get(code)
      return {
        code,
        name: item?.name ?? code,
        unit: item?.unit ?? 'sqft',
        samples: stats.samples,
        total_quantity: stats.total_quantity,
        total_hours: stats.total_hours,
        avg_quantity_per_hour: stats.avg,
        p50_quantity_per_hour: stats.p50,
        p90_quantity_per_hour: stats.p90,
        first_seen: bucket.firstSeen,
        last_seen: bucket.lastSeen,
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code))

  return { service_items }
}

type ForecastMeasurementInput = {
  service_item_code: string
  quantity: number
  unit?: string
}

async function forecastProjectHours(companyId: string, projectId: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be an object')
  }
  const measurements = (body as { measurements?: unknown }).measurements
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw new HttpError(400, 'measurements[] is required')
  }

  const normalized: ForecastMeasurementInput[] = measurements.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, `measurements[${index}] must be an object`)
    }
    const m = entry as Record<string, unknown>
    const code = String(m.service_item_code ?? '').trim()
    const quantity = Number(m.quantity ?? 0)
    const unit = m.unit === undefined || m.unit === null ? '' : String(m.unit).trim()
    if (!code) throw new HttpError(400, `measurements[${index}].service_item_code is required`)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `measurements[${index}].quantity must be positive`)
    }
    return { service_item_code: code, quantity, unit }
  })

  const [projectRows, serviceItemRows, bonusRuleRows, productivity] = await Promise.all([
    pool.query('select id, target_sqft_per_hr, labor_rate from projects where company_id = $1 and id = $2 limit 1', [
      companyId,
      projectId,
    ]),
    pool.query('select code, default_rate from service_items where company_id = $1 and deleted_at is null', [
      companyId,
    ]),
    pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
    listServiceItemProductivity(companyId),
  ])

  const project = projectRows.rows[0]
  if (!project) throw new HttpError(404, 'project not found')

  const laborRate = Number(project.labor_rate ?? 0)
  const projectTarget =
    project.target_sqft_per_hr != null && Number(project.target_sqft_per_hr) > 0
      ? Number(project.target_sqft_per_hr)
      : null

  const bonusConfig = bonusRuleRows.rows[0]?.config as { target_sqft_per_hr?: number } | undefined
  const bonusTarget =
    bonusConfig?.target_sqft_per_hr != null && Number(bonusConfig.target_sqft_per_hr) > 0
      ? Number(bonusConfig.target_sqft_per_hr)
      : null

  const productivityByCode = new Map<string, (typeof productivity.service_items)[number]>()
  for (const item of productivity.service_items) {
    productivityByCode.set(item.code, item)
  }

  const defaultRateByCode = new Map<string, number | null>()
  for (const row of serviceItemRows.rows) {
    const code = String(row.code)
    const rate = row.default_rate == null ? null : Number(row.default_rate)
    defaultRateByCode.set(code, Number.isFinite(rate ?? NaN) ? (rate as number) : null)
  }

  const forecast = normalized.map((m) => {
    const stats = productivityByCode.get(m.service_item_code)
    let rate: number | null = null
    let basis: 'p50' | 'p90' | 'project_target' | 'bonus_rule_target' | 'default_rate' | 'no_data' = 'no_data'

    if (stats && stats.samples >= 3 && stats.p50_quantity_per_hour && stats.p50_quantity_per_hour > 0) {
      rate = stats.p50_quantity_per_hour
      basis = 'p50'
    } else if (projectTarget) {
      rate = projectTarget
      basis = 'project_target'
    } else if (bonusTarget) {
      rate = bonusTarget
      basis = 'bonus_rule_target'
    } else {
      const defaultRate = defaultRateByCode.get(m.service_item_code) ?? null
      if (defaultRate && defaultRate > 0) {
        rate = defaultRate
        basis = 'default_rate'
      }
    }

    const projectedHours = rate && rate > 0 ? m.quantity / rate : null
    const projectedCost = projectedHours != null ? projectedHours * laborRate : null

    return {
      service_item_code: m.service_item_code,
      quantity: m.quantity,
      projected_hours: projectedHours == null ? null : round2(projectedHours),
      projected_cost: projectedCost == null ? null : round2(projectedCost),
      basis,
    }
  })

  return { forecast }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

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

            if (req.method === 'GET' && url.pathname === '/api/companies') {
              const memberships = await getMemberships(identity.userId)
              const companies = memberships.map((m) => ({
                id: m.company_id,
                slug: m.slug,
                name: m.name,
                created_at: m.created_at,
                role: m.role,
              }))
              sendJson(res, 200, { companies })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/companies') {
              const body = await readBody(req)
              const slug = String(body.slug ?? '')
                .trim()
                .toLowerCase()
              const name = String(body.name ?? '').trim()
              if (!slug || !COMPANY_SLUG_PATTERN.test(slug)) {
                sendJson(res, 400, { error: 'slug must be 2-64 chars, lowercase letters/digits/dashes' })
                return
              }
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              const seedDefaults = body.seed_defaults !== false
              const client = await pool.connect()
              try {
                await client.query('begin')
                const existing = await client.query('select id from companies where slug = $1 limit 1', [slug])
                if (existing.rows[0]) {
                  await client.query('rollback')
                  sendJson(res, 409, { error: 'slug already in use' })
                  return
                }
                const created = await client.query<{ id: string; slug: string; name: string; created_at: string }>(
                  `insert into companies (slug, name) values ($1, $2)
                   returning id, slug, name, created_at`,
                  [slug, name],
                )
                const newCompany = created.rows[0]!
                await client.query(
                  `insert into company_memberships (company_id, clerk_user_id, role)
                   values ($1, $2, 'admin')`,
                  [newCompany.id, identity.userId],
                )
                if (seedDefaults) {
                  await seedCompanyDefaults(client, newCompany.id)
                }
                await client.query('commit')
                await recordAudit(pool, {
                  companyId: newCompany.id,
                  actorUserId: identity.userId,
                  entityType: 'company',
                  entityId: newCompany.id,
                  action: 'create',
                  after: newCompany,
                })
                observeAudit('company', 'create')
                sendJson(res, 201, { company: newCompany, role: 'admin' })
              } catch (err) {
                await client.query('rollback').catch(() => {})
                throw err
              } finally {
                client.release()
              }
              return
            }

            const companyMembershipMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/memberships$/)
            if (req.method === 'POST' && companyMembershipMatch) {
              const targetCompanyId = companyMembershipMatch[1]!
              const adminCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [targetCompanyId, identity.userId],
              )
              if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
                sendJson(res, 403, { error: 'admin role required' })
                return
              }
              const body = await readBody(req)
              const inviteUserId = String(body.clerk_user_id ?? body.user_id ?? '').trim()
              const role = String(body.role ?? 'member').trim() || 'member'
              if (!inviteUserId) {
                sendJson(res, 400, { error: 'clerk_user_id is required' })
                return
              }
              if (!['admin', 'member', 'foreman', 'office'].includes(role)) {
                sendJson(res, 400, { error: 'role must be admin, member, foreman, or office' })
                return
              }
              const inserted = await pool.query<{
                id: string
                company_id: string
                clerk_user_id: string
                role: string
                created_at: string
              }>(
                `insert into company_memberships (company_id, clerk_user_id, role)
                 values ($1, $2, $3)
                 on conflict (company_id, clerk_user_id) do update set role = excluded.role
                 returning id, company_id, clerk_user_id, role, created_at`,
                [targetCompanyId, inviteUserId, role],
              )
              const membership = inserted.rows[0]!
              await recordAudit(pool, {
                companyId: targetCompanyId,
                actorUserId: identity.userId,
                entityType: 'company_membership',
                entityId: membership.id,
                action: 'upsert',
                after: membership,
              })
              observeAudit('company_membership', 'upsert')
              await enqueueNotification({
                companyId: targetCompanyId,
                recipientUserId: membership.clerk_user_id,
                kind: 'membership_welcome',
                subject: `You've been added to Sitelayer as ${membership.role}`,
                text: [
                  `You've been added to a Sitelayer company as ${membership.role}.`,
                  `Sign in to get started: https://sitelayer.sandolab.xyz/sign-in`,
                ].join('\n\n'),
                html: [
                  `<p>You've been added to a Sitelayer company as <strong>${membership.role}</strong>.</p>`,
                  `<p><a href="https://sitelayer.sandolab.xyz/sign-in">Sign in</a> to get started.</p>`,
                ].join('\n'),
                payload: {
                  membership_id: membership.id,
                  role: membership.role,
                  invited_by: identity.userId,
                },
              })
              sendJson(res, 201, { membership })
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
              const membershipRows = await getMemberships(userId)
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
                  backfillCustomerMapping(companyId, customer, executor),
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
                  listIntegrationMappings(companyId, provider, entityType),
                upsertMapping: (companyId, provider, values, executor) =>
                  upsertIntegrationMapping(companyId, provider, values, executor),
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

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/auth') {
              const state = encodeQboState({
                companyId: company.id,
                userId: getCurrentUserId(req),
                exp: Date.now() + 10 * 60 * 1000,
                nonce: randomUUID(),
              })
              const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(qboClientId)}&redirect_uri=${encodeURIComponent(qboRedirectUri)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`
              sendJson(res, 200, { authUrl })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/callback') {
              const code = url.searchParams.get('code')
              const realmId = url.searchParams.get('realmId')
              const state = url.searchParams.get('state')
              if (!code || !realmId || !state) {
                sendJson(res, 400, { error: 'missing code, realmId, or state' })
                return
              }
              let stateData: QboOAuthState
              try {
                stateData = decodeQboState(state)
              } catch (error) {
                const status = error instanceof HttpError ? error.status : 400
                sendJson(res, status, { error: error instanceof Error ? error.message : 'invalid state' })
                return
              }
              const stateMembership = await pool.query(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [stateData.companyId, stateData.userId],
              )
              if (!stateMembership.rows.length) {
                sendJson(res, 403, { error: 'state user is not a member of this company' })
                return
              }
              const auth = Buffer.from(`${qboClientId}:${qboClientSecret}`).toString('base64')
              const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: `Basic ${auth}`,
                },
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: qboRedirectUri,
                }).toString(),
              })
              if (!tokenResponse.ok) {
                sendJson(res, 400, { error: 'token exchange failed' })
                return
              }
              const tokenData = (await tokenResponse.json()) as {
                access_token: string
                refresh_token: string
                expires_in: number
              }
              const connection = await withMutationTx(async (client) => {
                const row = await upsertIntegrationConnection(
                  stateData.companyId,
                  'qbo',
                  {
                    provider_account_id: realmId,
                    access_token: tokenData.access_token,
                    refresh_token: tokenData.refresh_token,
                    status: 'connected',
                  },
                  client,
                )
                await recordSyncEvent(
                  stateData.companyId,
                  'integration_connection',
                  row.id,
                  { action: 'oauth_connect', provider: 'qbo' },
                  null,
                  { executor: client },
                )
                return row
              })
              if (qboSuccessRedirectUri) {
                sendRedirect(res, qboSuccessRedirectUri)
                return
              }
              sendJson(res, 200, { connection, success: true })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo') {
              const connection = await getIntegrationConnection(company.id, 'qbo')
              sendJson(res, 200, {
                connection,
                status: await getSyncStatus(pool, company.id),
              })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const currentConnection = await getIntegrationConnection(company.id, 'qbo')
              if (
                currentConnection &&
                expectedVersion !== null &&
                Number(currentConnection.version) !== expectedVersion
              ) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentConnection.version) })
                return
              }
              const connection = await withMutationTx(async (client) => {
                const row = await upsertIntegrationConnection(
                  company.id,
                  'qbo',
                  {
                    provider_account_id: body.provider_account_id ?? null,
                    access_token: body.access_token ?? null,
                    refresh_token: body.refresh_token ?? null,
                    webhook_secret: body.webhook_secret ?? null,
                    sync_cursor: body.sync_cursor ?? null,
                    status: body.status ?? 'connected',
                  },
                  client,
                )
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'integration_connection',
                  entityId: row.id,
                  action: 'upsert',
                  row,
                  syncPayload: {
                    action: currentConnection ? 'upsert' : 'create',
                    provider: 'qbo',
                    connection: row,
                  },
                  idempotencyKey: `integration_connection:qbo:${row.id}`,
                })
                return row
              })
              sendJson(res, 200, { connection })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const connection = await getIntegrationConnectionWithSecrets(company.id, 'qbo')
              await upsertIntegrationConnection(company.id, 'qbo', { status: 'syncing' })
              try {
                if (!connection?.access_token) {
                  const customersResult = await pool.query(
                    'select id, external_id, name from customers where company_id = $1 and deleted_at is null and external_id is not null',
                    [company.id],
                  )
                  const serviceItemsResult = await pool.query(
                    "select code, name, source from service_items where company_id = $1 and deleted_at is null and (source = 'qbo' or code like 'qbo-%')",
                    [company.id],
                  )
                  const divisionsResult = await pool.query(
                    'select code, name from divisions where company_id = $1 order by sort_order asc',
                    [company.id],
                  )
                  const qboSnapshot = {
                    syncedCustomers: customersResult.rowCount,
                    syncedItems: serviceItemsResult.rowCount,
                    syncedDivisions: divisionsResult.rowCount,
                    simulated: true,
                  }
                  // Refresh integration_mappings for the company's existing
                  // QBO-tagged rows. The simulated sync just rebuilds the
                  // mapping table from local data; one tx per entity type
                  // keeps the mapping refresh atomic per kind.
                  await withMutationTx(async (client) => {
                    for (const row of customersResult.rows) {
                      const customer = row as { id: string; external_id: string; name: string }
                      await backfillCustomerMapping(company.id, customer, client)
                    }
                    for (const row of serviceItemsResult.rows) {
                      const serviceItem = row as { code: string; name: string; source?: string | null }
                      await backfillServiceItemMapping(
                        company.id,
                        serviceItem,
                        serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null,
                        client,
                      )
                    }
                    for (const row of divisionsResult.rows) {
                      const division = row as { code: string; name: string }
                      await backfillDivisionMapping(company.id, division, division.code, client)
                    }
                  })
                  const refreshed = await withMutationTx(async (client) => {
                    const result = await client.query(
                      `
            update integration_connections
            set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
            where company_id = $1 and provider = 'qbo'
            returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
            `,
                      [company.id, new Date().toISOString()],
                    )
                    const row = result.rows[0]
                    const connectionId = connection?.id ?? row.id
                    await recordMutationLedger(client, {
                      companyId: company.id,
                      entityType: 'integration_connection',
                      entityId: connectionId,
                      action: 'sync',
                      syncPayload: {
                        action: 'sync',
                        provider: 'qbo',
                        snapshot: qboSnapshot,
                        simulated: true,
                      },
                      outboxPayload: qboSnapshot,
                      idempotencyKey: `integration_connection:qbo:sync:${connectionId}`,
                    })
                    return row
                  })
                  sendJson(res, 200, {
                    connection: refreshed,
                    snapshot: qboSnapshot,
                  })
                  return
                }
                const realmId = connection.provider_account_id ?? ''
                const accessToken = connection.access_token ?? ''

                // QBO returns PascalCase field names; some legacy responses use camelCase
                // so we accept both shapes when reading.
                type QboCustomer = { Id?: string; DisplayName?: string; id?: string; displayName?: string }
                let qboCustomers: QboCustomer[] = []
                try {
                  const customerResponse = await qboGet<{ QueryResponse?: { Customer?: QboCustomer[] } }>(
                    `/query?query=${encodeURIComponent('SELECT * FROM Customer')}`,
                    realmId,
                    accessToken,
                  )
                  qboCustomers = customerResponse.QueryResponse?.Customer ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_customers' }, 'Failed to sync customers from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_customers' } })
                }

                // Upsert QBO customers in one batch instead of N round-trips.
                // External-id and name arrays are zipped via unnest; the mapping
                // upsert reuses the resulting customer ids so we don't have to
                // re-query.
                const customerExternalIds: string[] = []
                const customerNames: string[] = []
                for (const qboCustomer of qboCustomers) {
                  const externalId = String(qboCustomer.Id ?? qboCustomer.id ?? '')
                  if (!externalId) continue
                  const name = qboCustomer.DisplayName ?? qboCustomer.displayName ?? externalId
                  customerExternalIds.push(externalId)
                  customerNames.push(name)
                }
                const syncedCustomers: string[] = []
                if (customerExternalIds.length > 0) {
                  await withMutationTx(async (client) => {
                    const upserted = await client.query<{
                      id: string
                      external_id: string
                      name: string
                    }>(
                      `
            insert into customers (company_id, external_id, name, source)
            select $1::uuid, t.external_id, t.name, 'qbo'
            from unnest($2::text[], $3::text[]) as t(external_id, name)
            on conflict (company_id, external_id) do update set name = excluded.name, updated_at = now()
            returning id, external_id, name
            `,
                      [company.id, customerExternalIds, customerNames],
                    )
                    const localRefs: string[] = []
                    const externalIds: string[] = []
                    const labels: string[] = []
                    for (const row of upserted.rows) {
                      localRefs.push(row.id)
                      externalIds.push(row.external_id)
                      labels.push(row.name)
                      syncedCustomers.push(row.external_id)
                    }
                    await client.query(
                      `
            insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
            select $1::uuid, 'qbo', 'customer', local_ref, external_id, label, 'active', 'synced from qbo customer import'
            from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
            on conflict (company_id, provider, entity_type, local_ref)
            do update set
              external_id = excluded.external_id,
              label = excluded.label,
              status = excluded.status,
              notes = excluded.notes,
              version = integration_mappings.version + 1,
              updated_at = now(),
              deleted_at = null
            `,
                      [company.id, localRefs, externalIds, labels],
                    )
                  })
                }

                // Fetch items from QBO. Parse each row through `parseQboItem`
                // so we get a stable shape regardless of PascalCase vs
                // camelCase variance from Intuit. A QboParseError on any row
                // is recorded as a sync_event so the failure isn't silently
                // dropped.
                let qboItemsRaw: unknown[] = []
                try {
                  const itemResponse = await qboGet<{ QueryResponse?: { Item?: unknown[] } }>(
                    `/query?query=${encodeURIComponent("SELECT * FROM Item WHERE Type IN ('Service', 'Inventory')")}`,
                    realmId,
                    accessToken,
                  )
                  qboItemsRaw = itemResponse.QueryResponse?.Item ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_items' }, 'Failed to sync items from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_items' } })
                }

                // Parse first, write second: parse failures emit per-row
                // sync_event markers, then the survivors are upserted in one
                // batch. Same idea as the customers path above.
                const itemCodes: string[] = []
                const itemNames: string[] = []
                const itemPrices: string[] = []
                const itemExternalIds: string[] = []
                for (const rawItem of qboItemsRaw) {
                  let qboItem
                  try {
                    qboItem = parseQboItem(rawItem)
                  } catch (e) {
                    if (e instanceof QboParseError) {
                      logger.error({ err: e, scope: 'qbo_items_parse' }, 'QBO item parse failed')
                      Sentry.captureException(e, { tags: { scope: 'qbo_items_parse' } })
                      await recordSyncEvent(
                        company.id,
                        'service_item',
                        'unknown',
                        { action: 'parse_failed', provider: 'qbo', raw: e.raw },
                        connection.id,
                        { status: 'failed', error: e.message },
                      )
                      continue
                    }
                    throw e
                  }
                  itemCodes.push(`qbo-${qboItem.id}`)
                  itemNames.push(qboItem.name)
                  itemPrices.push(String(qboItem.unitPrice ?? 0))
                  itemExternalIds.push(qboItem.id)
                }
                const syncedItems: string[] = []
                if (itemCodes.length > 0) {
                  await withMutationTx(async (client) => {
                    const upserted = await client.query<{ code: string; name: string }>(
                      `
            insert into service_items (company_id, code, name, default_rate, category, unit, source)
            select $1::uuid, t.code, t.name, t.price::numeric, 'accounting', 'ea', 'qbo'
            from unnest($2::text[], $3::text[], $4::text[]) as t(code, name, price)
            on conflict (company_id, code) do update set
              name = excluded.name,
              default_rate = excluded.default_rate,
              source = 'qbo',
              updated_at = now()
            returning code, name
            `,
                      [company.id, itemCodes, itemNames, itemPrices],
                    )
                    for (const row of upserted.rows) {
                      syncedItems.push(row.code)
                    }
                    await client.query(
                      `
            insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
            select $1::uuid, 'qbo', 'service_item', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo service_item import'
            from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
            on conflict (company_id, provider, entity_type, local_ref)
            do update set
              external_id = excluded.external_id,
              label = excluded.label,
              status = excluded.status,
              notes = excluded.notes,
              version = integration_mappings.version + 1,
              updated_at = now(),
              deleted_at = null
            `,
                      [company.id, itemCodes, itemExternalIds, itemNames],
                    )
                  })
                }

                // Fetch classes from QBO and backfill division mappings by
                // name match. Per-row parse failures are recorded as
                // sync_events; the overall sync continues.
                let qboClassesRaw: unknown[] = []
                try {
                  const classResponse = await qboGet<{ QueryResponse?: { Class?: unknown[] } }>(
                    `/query?query=${encodeURIComponent('SELECT * FROM Class')}`,
                    realmId,
                    accessToken,
                  )
                  qboClassesRaw = classResponse.QueryResponse?.Class ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_classes' }, 'Failed to sync classes from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_classes' } })
                }

                const divisionsResult = await pool.query(
                  'select code, name from divisions where company_id = $1 order by sort_order asc',
                  [company.id],
                )
                // Match QBO classes against local divisions in memory, then
                // batch the resulting integration_mapping upserts.
                const divisionLocalRefs: string[] = []
                const divisionExternalIds: string[] = []
                const divisionLabels: string[] = []
                const syncedDivisions: string[] = []
                for (const rawClass of qboClassesRaw) {
                  let qboClass
                  try {
                    qboClass = parseQboClass(rawClass)
                  } catch (e) {
                    if (e instanceof QboParseError) {
                      logger.error({ err: e, scope: 'qbo_classes_parse' }, 'QBO class parse failed')
                      Sentry.captureException(e, { tags: { scope: 'qbo_classes_parse' } })
                      await recordSyncEvent(
                        company.id,
                        'division',
                        'unknown',
                        { action: 'parse_failed', provider: 'qbo', raw: e.raw },
                        connection.id,
                        { status: 'failed', error: e.message },
                      )
                      continue
                    }
                    throw e
                  }
                  const division = divisionsResult.rows.find(
                    (row) =>
                      row.name.toLowerCase() === qboClass.name.toLowerCase() ||
                      row.code.toLowerCase() === qboClass.name.toLowerCase(),
                  )
                  if (!division) continue
                  divisionLocalRefs.push(division.code)
                  divisionExternalIds.push(qboClass.id)
                  divisionLabels.push(division.name)
                  syncedDivisions.push(division.code)
                }
                if (divisionLocalRefs.length > 0) {
                  await withMutationTx(async (client) => {
                    await client.query(
                      `
            insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
            select $1::uuid, 'qbo', 'division', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo class sync'
            from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
            on conflict (company_id, provider, entity_type, local_ref)
            do update set
              external_id = excluded.external_id,
              label = excluded.label,
              status = excluded.status,
              notes = excluded.notes,
              version = integration_mappings.version + 1,
              updated_at = now(),
              deleted_at = null
            `,
                      [company.id, divisionLocalRefs, divisionExternalIds, divisionLabels],
                    )
                  })
                }

                const qboSnapshot = {
                  syncedCustomers: syncedCustomers.length,
                  syncedItems: syncedItems.length,
                  syncedDivisions: syncedDivisions.length,
                }

                const refreshed = await withMutationTx(async (client) => {
                  const result = await client.query(
                    `
          update integration_connections
          set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
          where company_id = $1 and provider = 'qbo'
          returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
          `,
                    [company.id, new Date().toISOString()],
                  )
                  await recordMutationLedger(client, {
                    companyId: company.id,
                    entityType: 'integration_connection',
                    entityId: connection.id,
                    action: 'sync',
                    syncPayload: { action: 'sync', provider: 'qbo', snapshot: qboSnapshot },
                    outboxPayload: qboSnapshot,
                    idempotencyKey: `integration_connection:qbo:sync:${connection.id}`,
                  })
                  return result.rows[0] ?? connection
                })

                sendJson(res, 200, {
                  connection: refreshed,
                  snapshot: qboSnapshot,
                })
              } catch (error) {
                logger.error({ err: error, scope: 'qbo_sync' }, 'QBO sync error')
                Sentry.captureException(error, { tags: { scope: 'qbo_sync' } })
                await upsertIntegrationConnection(company.id, 'qbo', { status: 'error' })
                sendJson(res, 500, { error: 'sync failed' })
              }
              return
            }

            // Push unsynced material_bills rows to QBO as Bills.
            //
            // Contract with the frontend/accounting ops:
            //   - A mapping of entity_type='qbo_account' and local_ref='materials'
            //     is required. The `external_id` is the QBO AccountRef.value for
            //     the Materials expense account. Without it we error per-bill
            //     rather than fabricating a default account.
            //   - Vendors are resolved by DisplayName — we search QBO for one
            //     matching `material_bills.vendor_name`, and create it if not
            //     found. The resolved vendor is mirrored into
            //     integration_mappings(entity_type='qbo_vendor', local_ref=vendor_name).
            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync/material-bills') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const connection = await getIntegrationConnectionWithSecrets(company.id, 'qbo')
              if (!connection?.access_token || !connection.provider_account_id) {
                sendJson(res, 400, { error: 'QBO connection missing or not authorized' })
                return
              }
              const realmId = connection.provider_account_id as string
              const accessToken = connection.access_token as string

              const accountMappingResult = await pool.query<{ external_id: string }>(
                `select external_id from integration_mappings
                 where company_id = $1 and provider = 'qbo'
                   and entity_type = 'qbo_account' and local_ref = 'materials'
                   and deleted_at is null
                 limit 1`,
                [company.id],
              )
              const materialsAccountId = accountMappingResult.rows[0]?.external_id ?? null

              const unsynced = await pool.query<{
                id: string
                vendor_name: string
                amount: string | number
                description: string | null
                occurred_on: string | null
              }>(
                `select mb.id, mb.vendor_name, mb.amount, mb.description, mb.occurred_on
                 from material_bills mb
                 where mb.company_id = $1 and mb.deleted_at is null
                   and not exists (
                     select 1 from integration_mappings im
                     where im.company_id = mb.company_id and im.provider = 'qbo'
                       and im.entity_type = 'material_bill' and im.local_ref = mb.id::text
                       and im.deleted_at is null
                   )`,
                [company.id],
              )

              const errors: Array<{ bill_id: string; error: string }> = []
              let synced = 0
              // Cache vendor lookups within this request so N bills from one
              // vendor only hit QBO once.
              const vendorCache = new Map<string, string>()

              for (const bill of unsynced.rows) {
                if (!materialsAccountId) {
                  errors.push({
                    bill_id: bill.id,
                    error: 'no Materials account mapped — set via /api/integrations/qbo/mappings',
                  })
                  continue
                }
                try {
                  const displayName = bill.vendor_name.trim()
                  if (!displayName) {
                    errors.push({ bill_id: bill.id, error: 'vendor_name is empty' })
                    continue
                  }
                  let vendorId = vendorCache.get(displayName) ?? null
                  if (!vendorId) {
                    // Try a cached mapping first — if we pushed a bill for
                    // this vendor in a previous run we don't need to hit QBO.
                    const mappedVendor = await pool.query<{ external_id: string }>(
                      `select external_id from integration_mappings
                       where company_id = $1 and provider = 'qbo'
                         and entity_type = 'qbo_vendor' and local_ref = $2
                         and deleted_at is null
                       limit 1`,
                      [company.id, displayName],
                    )
                    vendorId = mappedVendor.rows[0]?.external_id ?? null
                  }
                  if (!vendorId) {
                    // QBO vendor query is quoted via single-quotes; escape any
                    // embedded quotes to avoid breaking the V2 query grammar.
                    const escaped = displayName.replace(/'/g, "\\'")
                    const vendorSearch = await qboGet<{ QueryResponse?: { Vendor?: Array<{ Id?: string }> } }>(
                      `/query?query=${encodeURIComponent(`select * from Vendor where DisplayName = '${escaped}'`)}`,
                      realmId,
                      accessToken,
                    )
                    vendorId = vendorSearch.QueryResponse?.Vendor?.[0]?.Id ?? null
                    if (!vendorId) {
                      const created = await qboPost<{ Vendor?: { Id?: string } }>(`/vendor`, realmId, accessToken, {
                        DisplayName: displayName,
                      })
                      vendorId = created.Vendor?.Id ?? null
                    }
                    if (!vendorId) {
                      errors.push({ bill_id: bill.id, error: 'failed to resolve or create QBO vendor' })
                      continue
                    }
                    vendorCache.set(displayName, vendorId)
                    await upsertIntegrationMapping(company.id, 'qbo', {
                      entity_type: 'qbo_vendor',
                      local_ref: displayName,
                      external_id: vendorId,
                      label: displayName,
                      status: 'active',
                      notes: 'resolved via material-bill push',
                    })
                  }

                  const amount = Number(bill.amount) || 0
                  const billPayload = {
                    VendorRef: { value: vendorId },
                    TxnDate: bill.occurred_on ?? undefined,
                    Line: [
                      {
                        Amount: amount,
                        DetailType: 'AccountBasedExpenseLineDetail',
                        Description: bill.description ?? undefined,
                        AccountBasedExpenseLineDetail: {
                          AccountRef: { value: materialsAccountId },
                        },
                      },
                    ],
                  }
                  const response = await qboPost<{ Bill?: { Id?: string } }>(`/bill`, realmId, accessToken, billPayload)
                  const qboBillId = response.Bill?.Id ?? null
                  if (!qboBillId) {
                    errors.push({ bill_id: bill.id, error: 'QBO did not return a Bill.Id' })
                    continue
                  }
                  // Pair the mapping upsert with the success ledger row so we
                  // never end up with a `material_bill:push` sync_event for a
                  // bill that has no integration_mapping (or vice versa).
                  await withMutationTx(async (client) => {
                    await upsertIntegrationMapping(
                      company.id,
                      'qbo',
                      {
                        entity_type: 'material_bill',
                        local_ref: bill.id,
                        external_id: qboBillId,
                        label: `${displayName} ${amount}`,
                        status: 'active',
                        notes: 'pushed via /sync/material-bills',
                      },
                      client,
                    )
                    await recordSyncEvent(
                      company.id,
                      'material_bill',
                      bill.id,
                      { action: 'push', provider: 'qbo', external_id: qboBillId },
                      null,
                      { executor: client },
                    )
                  })
                  synced += 1
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'unknown error'
                  logger.error({ err, scope: 'qbo_material_bill_push', bill_id: bill.id }, 'material bill push failed')
                  Sentry.captureException(err, { tags: { scope: 'qbo_material_bill_push' } })
                  errors.push({ bill_id: bill.id, error: message })
                }
              }
              sendJson(res, 200, { synced, errors, total_candidates: unsynced.rowCount ?? 0 })
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

            if (req.method === 'POST' && url.pathname === '/api/projects') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              const customerName = String(body.customer_name ?? '').trim()
              const divisionCode = String(body.division_code ?? 'D4')
              if (!name || !customerName) {
                sendJson(res, 400, { error: 'name and customer_name are required' })
                return
              }
              const customerId =
                body.customer_id === undefined || body.customer_id === null || body.customer_id === ''
                  ? null
                  : String(body.customer_id).trim()
              if (customerId && !isValidUuid(customerId)) {
                sendJson(res, 400, { error: 'customer_id must be a valid uuid' })
                return
              }

              const siteLat = parseOptionalNumber(body.site_lat)
              const siteLng = parseOptionalNumber(body.site_lng)
              const siteRadiusMeters = parseOptionalNumber(body.site_radius_m)

              const created = await withMutationTx(async (client) => {
                const inserted = await client.query(
                  `
        insert into projects (
          company_id, customer_id, name, customer_name, division_code, status,
          bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
          site_lat, site_lng, site_radius_m, version
        )
        values (
          $1,
          nullif($2, '')::uuid,
          $3,
          $4,
          $5,
          coalesce($6, 'lead'),
          coalesce($7, 0),
          coalesce($8, 0),
          $9,
          coalesce($10, 0),
          $11,
          $12,
          coalesce($13, 100),
          1
        )
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, site_lat, site_lng, site_radius_m, version, created_at, updated_at
        `,
                  [
                    company.id,
                    customerId,
                    name,
                    customerName,
                    divisionCode,
                    body.status ?? 'lead',
                    body.bid_total ?? 0,
                    body.labor_rate ?? 0,
                    body.target_sqft_per_hr ?? null,
                    body.bonus_pool ?? 0,
                    siteLat,
                    siteLng,
                    siteRadiusMeters,
                  ],
                )
                const row = inserted.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'project',
                  entityId: row.id,
                  action: 'create',
                  row,
                })
                return row
              })
              sendJson(res, 201, created)
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/projects\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const patchSiteLat = body.site_lat === undefined ? null : parseOptionalNumber(body.site_lat)
              const patchSiteLng = body.site_lng === undefined ? null : parseOptionalNumber(body.site_lng)
              const patchSiteRadius = body.site_radius_m === undefined ? null : parseOptionalNumber(body.site_radius_m)
              const updated = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update projects
        set
          name = coalesce($3, name),
          customer_name = coalesce($4, customer_name),
          division_code = coalesce($5, division_code),
          status = coalesce($6, status),
          bid_total = coalesce($7, bid_total),
          labor_rate = coalesce($8, labor_rate),
          target_sqft_per_hr = coalesce($9, target_sqft_per_hr),
          bonus_pool = coalesce($10, bonus_pool),
          site_lat = case when $12::boolean then $13::numeric else site_lat end,
          site_lng = case when $14::boolean then $15::numeric else site_lng end,
          site_radius_m = case when $16::boolean then $17::int else site_radius_m end,
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($11::int is null or version = $11)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, site_lat, site_lng, site_radius_m, version, created_at, updated_at
        `,
                  [
                    company.id,
                    projectId,
                    body.name ?? null,
                    body.customer_name ?? null,
                    body.division_code ?? null,
                    body.status ?? null,
                    body.bid_total ?? null,
                    body.labor_rate ?? null,
                    body.target_sqft_per_hr ?? null,
                    body.bonus_pool ?? null,
                    expectedVersion,
                    body.site_lat !== undefined,
                    patchSiteLat,
                    body.site_lng !== undefined,
                    patchSiteLng,
                    body.site_radius_m !== undefined,
                    patchSiteRadius,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'project',
                  entityId: projectId,
                  action: 'update',
                  row,
                })
                return row
              })
              if (!updated) {
                if (
                  !(await checkVersion(
                    'projects',
                    'company_id = $1 and id = $2',
                    [company.id, projectId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/closeout$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body?.expected_version ?? body?.version)
              const closed = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update projects
        set
          status = 'completed',
          closed_at = coalesce(closed_at, now()),
          summary_locked_at = coalesce(summary_locked_at, now()),
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($3::int is null or version = $3)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
        `,
                  [company.id, projectId, expectedVersion],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'project',
                  entityId: projectId,
                  action: 'closeout',
                  row,
                })
                return row
              })
              if (!closed) {
                if (
                  !(await checkVersion(
                    'projects',
                    'company_id = $1 and id = $2',
                    [company.id, projectId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              // Margin shortfall alert: when the closing margin is below 10%,
              // notify company admins so they can review before invoicing.
              // Best-effort, post-commit — alert delivery must not roll back
              // the closeout.
              try {
                const summary = await summarizeProject(company.id, projectId)
                const marginPct = summary?.metrics?.margin?.margin
                if (typeof marginPct === 'number' && marginPct < 10) {
                  const project = closed as { name?: string; customer_name?: string }
                  const subject = `[Sitelayer] Margin shortfall on closeout: ${project.name ?? projectId}`
                  const text = [
                    `Project "${project.name ?? projectId}" (${project.customer_name ?? 'unknown customer'}) closed with a margin of ${marginPct.toFixed(2)}%.`,
                    `Target is 10%. Review cost entries and invoicing before finalizing.`,
                    `https://sitelayer.sandolab.xyz/projects/${projectId}`,
                  ].join('\n\n')
                  await enqueueAdminAlert(company.id, 'margin_shortfall', subject, text, {
                    project_id: projectId,
                    margin_pct: marginPct,
                    revenue: summary?.metrics?.margin?.revenue ?? null,
                    cost: summary?.metrics?.margin?.cost ?? null,
                  })
                }
              } catch (err) {
                logger.warn({ err, projectId }, '[notifications] margin_shortfall alert failed')
              }
              sendJson(res, 200, closed)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const result = await pool.query(
                `
        select id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        from material_bills
        where company_id = $1 and project_id = $2 and deleted_at is null
        order by occurred_on desc, created_at desc
        `,
                [company.id, projectId],
              )
              sendJson(res, 200, { materialBills: result.rows })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              if (!body.vendor || body.amount === undefined || !body.bill_type) {
                sendJson(res, 400, { error: 'vendor, amount, and bill_type are required' })
                return
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              if (expectedVersion !== null) {
                const projectVersionResult = await pool.query(
                  'select version from projects where company_id = $1 and id = $2',
                  [company.id, projectId],
                )
                const currentProject = projectVersionResult.rows[0]
                if (!currentProject) {
                  sendJson(res, 404, { error: 'project not found' })
                  return
                }
                if (Number(currentProject.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                  return
                }
              }
              const bill = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        insert into material_bills (company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, now()::date))
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                  [
                    company.id,
                    projectId,
                    body.vendor,
                    body.amount,
                    body.bill_type,
                    body.description ?? null,
                    body.occurred_on ?? null,
                  ],
                )
                const row = result.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'material_bill',
                  entityId: row.id,
                  action: 'create',
                  row,
                  syncPayload: { action: 'create', bill: row },
                })
                await client.query(
                  'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                  [company.id, projectId],
                )
                return row
              })
              sendJson(res, 201, bill)
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const billId = url.pathname.split('/')[3] ?? ''
              if (!billId) {
                sendJson(res, 400, { error: 'bill id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const updated = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update material_bills
        set
          vendor_name = coalesce($3, vendor_name),
          amount = coalesce($4, amount),
          bill_type = coalesce($5, bill_type),
          description = coalesce($6, description),
          occurred_on = coalesce($7, occurred_on),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($8::int is null or version = $8)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                  [
                    company.id,
                    billId,
                    body.vendor ?? null,
                    body.amount ?? null,
                    body.bill_type ?? null,
                    body.description ?? null,
                    body.occurred_on ?? null,
                    expectedVersion,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'material_bill',
                  entityId: billId,
                  action: 'update',
                  row,
                  syncPayload: { action: 'update', bill: row },
                })
                await client.query(
                  'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                  [company.id, row.project_id],
                )
                return row
              })
              if (!updated) {
                if (
                  !(await checkVersion(
                    'material_bills',
                    'company_id = $1 and id = $2',
                    [company.id, billId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'bill not found' })
                return
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const billId = url.pathname.split('/')[3] ?? ''
              if (!billId) {
                sendJson(res, 400, { error: 'bill id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const deleted = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update material_bills
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                  [company.id, billId, expectedVersion],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'material_bill',
                  entityId: billId,
                  action: 'delete',
                  row,
                  syncPayload: { action: 'delete', bill: row },
                })
                await client.query(
                  'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                  [company.id, row.project_id],
                )
                return row
              })
              if (!deleted) {
                if (
                  !(await checkVersion(
                    'material_bills',
                    'company_id = $1 and id = $2',
                    [company.id, billId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'bill not found' })
                return
              }
              sendJson(res, 200, deleted)
              return
            }

            // ---------------------------------------------------------------
            // Rentals — Avontus-style equipment rental tracking.
            //
            // All mutations are gated to admin/office because rental invoices
            // feed billing, not field data capture.
            // ---------------------------------------------------------------

            if (req.method === 'GET' && url.pathname === '/api/rentals') {
              const statusFilter = (url.searchParams.get('status') ?? 'active').toLowerCase()
              const values: unknown[] = [company.id]
              let statusClause = ''
              if (statusFilter === 'active') {
                statusClause = " and status = 'active'"
              } else if (statusFilter === 'returned') {
                statusClause = " and status in ('returned', 'invoiced_pending')"
              } else if (statusFilter === 'closed') {
                statusClause = " and status = 'closed'"
              } else if (statusFilter !== 'all') {
                sendJson(res, 400, { error: 'status must be one of active, returned, closed, all' })
                return
              }
              const result = await pool.query<RentalRow>(
                `
                select ${RENTAL_SELECT_COLUMNS}
                from rentals
                where company_id = $1 and deleted_at is null${statusClause}
                order by delivered_on desc, created_at desc
                `,
                values,
              )
              sendJson(res, 200, { rentals: result.rows })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/rentals') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const body = await readBody(req)
              const itemDescription = String(body.item_description ?? '').trim()
              if (!itemDescription) {
                sendJson(res, 400, { error: 'item_description is required' })
                return
              }
              if (!body.delivered_on || !isValidDateInput(body.delivered_on)) {
                sendJson(res, 400, { error: 'delivered_on must be YYYY-MM-DD' })
                return
              }
              if (body.returned_on && !isValidDateInput(body.returned_on)) {
                sendJson(res, 400, { error: 'returned_on must be YYYY-MM-DD when provided' })
                return
              }
              const dailyRate = Number(body.daily_rate ?? 0)
              if (!Number.isFinite(dailyRate) || dailyRate < 0) {
                sendJson(res, 400, { error: 'daily_rate must be a non-negative number' })
                return
              }
              const cadence = Math.max(1, Math.floor(Number(body.invoice_cadence_days ?? 7)))
              const nextInvoiceAt = initialRentalNextInvoiceAt(String(body.delivered_on), cadence)
              const projectId = body.project_id ? String(body.project_id) : null
              const customerId = body.customer_id ? String(body.customer_id) : null
              // Cross-check project tenancy up front so the composite FK doesn't
              // bubble up as a generic 500.
              if (projectId) {
                const existing = await pool.query('select 1 from projects where company_id = $1 and id = $2', [
                  company.id,
                  projectId,
                ])
                if (!existing.rows[0]) {
                  sendJson(res, 400, { error: 'project_id not found for company' })
                  return
                }
              }
              if (customerId) {
                const existing = await pool.query('select 1 from customers where company_id = $1 and id = $2', [
                  company.id,
                  customerId,
                ])
                if (!existing.rows[0]) {
                  sendJson(res, 400, { error: 'customer_id not found for company' })
                  return
                }
              }
              const rental = await withMutationTx(async (client) => {
                const inserted = await client.query<RentalRow>(
                  `
                insert into rentals (
                  company_id, project_id, customer_id, item_description, daily_rate,
                  delivered_on, returned_on, invoice_cadence_days, next_invoice_at, status, notes
                )
                values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, 'active', $10)
                returning ${RENTAL_SELECT_COLUMNS}
                `,
                  [
                    company.id,
                    projectId,
                    customerId,
                    itemDescription,
                    dailyRate,
                    body.delivered_on,
                    body.returned_on ?? null,
                    cadence,
                    nextInvoiceAt,
                    body.notes ? String(body.notes) : null,
                  ],
                )
                const row = inserted.rows[0]!
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'rental',
                  entityId: row.id,
                  action: 'create',
                  row,
                })
                return row
              })
              sendJson(res, 201, rental)
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/rentals\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const rentalId = url.pathname.split('/')[3] ?? ''
              if (!rentalId) {
                sendJson(res, 400, { error: 'rental id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              if (
                body.delivered_on !== undefined &&
                body.delivered_on !== null &&
                !isValidDateInput(body.delivered_on)
              ) {
                sendJson(res, 400, { error: 'delivered_on must be YYYY-MM-DD' })
                return
              }
              if (body.returned_on !== undefined && body.returned_on !== null && !isValidDateInput(body.returned_on)) {
                sendJson(res, 400, { error: 'returned_on must be YYYY-MM-DD' })
                return
              }
              // Clients can set status=returned either by passing status='returned'
              // explicitly or by setting returned_on. We honour whichever the
              // client sent; the worker will transition returned -> closed once
              // the final invoice fires.
              const updated = await withMutationTx(async (client) => {
                const result = await client.query<RentalRow>(
                  `
                update rentals
                set
                  item_description = coalesce($3, item_description),
                  daily_rate = coalesce($4, daily_rate),
                  delivered_on = coalesce($5::date, delivered_on),
                  returned_on = case when $6::text = '__clear__' then null
                                     when $6::text is null then returned_on
                                     else $6::date end,
                  invoice_cadence_days = coalesce($7, invoice_cadence_days),
                  status = coalesce($8, status),
                  notes = coalesce($9, notes),
                  project_id = case when $10::text = '__clear__' then null
                                    when $10::text is null then project_id
                                    else $10::uuid end,
                  customer_id = case when $11::text = '__clear__' then null
                                     when $11::text is null then customer_id
                                     else $11::uuid end,
                  version = version + 1,
                  updated_at = now()
                where company_id = $1 and id = $2 and deleted_at is null
                  and ($12::int is null or version = $12)
                returning ${RENTAL_SELECT_COLUMNS}
                `,
                  [
                    company.id,
                    rentalId,
                    body.item_description ?? null,
                    body.daily_rate ?? null,
                    body.delivered_on ?? null,
                    body.returned_on === null ? '__clear__' : (body.returned_on ?? null),
                    body.invoice_cadence_days ?? null,
                    body.status ?? (body.returned_on ? 'returned' : null),
                    body.notes ?? null,
                    body.project_id === null ? '__clear__' : (body.project_id ?? null),
                    body.customer_id === null ? '__clear__' : (body.customer_id ?? null),
                    expectedVersion,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'rental',
                  entityId: rentalId,
                  action: 'update',
                  row,
                  // Versioned key so consecutive updates produce distinct
                  // outbox rows instead of upserting the latest payload only.
                  idempotencyKey: `rental:update:${rentalId}:${row.version}`,
                })
                return row
              })
              if (!updated) {
                if (
                  !(await checkVersion(
                    'rentals',
                    'company_id = $1 and id = $2',
                    [company.id, rentalId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'rental not found' })
                return
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/rentals\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const rentalId = url.pathname.split('/')[3] ?? ''
              if (!rentalId) {
                sendJson(res, 400, { error: 'rental id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const deleted = await withMutationTx(async (client) => {
                const result = await client.query<RentalRow>(
                  `
                update rentals
                set deleted_at = now(), version = version + 1, updated_at = now()
                where company_id = $1 and id = $2 and deleted_at is null
                  and ($3::int is null or version = $3)
                returning ${RENTAL_SELECT_COLUMNS}
                `,
                  [company.id, rentalId, expectedVersion],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'rental',
                  entityId: rentalId,
                  action: 'delete',
                  row,
                })
                return row
              })
              if (!deleted) {
                if (
                  !(await checkVersion(
                    'rentals',
                    'company_id = $1 and id = $2',
                    [company.id, rentalId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'rental not found' })
                return
              }
              sendJson(res, 200, deleted)
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/rentals\/[^/]+\/invoice$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const rentalId = url.pathname.split('/')[3] ?? ''
              if (!rentalId) {
                sendJson(res, 400, { error: 'rental id is required' })
                return
              }
              const existing = await pool.query<RentalRow>(
                `select ${RENTAL_SELECT_COLUMNS} from rentals where company_id = $1 and id = $2 and deleted_at is null`,
                [company.id, rentalId],
              )
              const rental = existing.rows[0]
              if (!rental) {
                sendJson(res, 404, { error: 'rental not found' })
                return
              }
              if (!rental.project_id) {
                sendJson(res, 400, { error: 'rental must be linked to a project to invoice' })
                return
              }
              const processed = await withMutationTx(async (client) => {
                const result = await processRentalInvoice(client, rental)
                if (result.bill) {
                  await recordMutationLedger(client, {
                    companyId: company.id,
                    entityType: 'material_bill',
                    entityId: result.bill.id,
                    action: 'create',
                    row: result.bill,
                    syncPayload: {
                      action: 'create',
                      bill: result.bill,
                      source: 'rental_invoice',
                      rental_id: rentalId,
                    },
                    outboxPayload: { ...result.bill, source: 'rental_invoice', rental_id: rentalId },
                  })
                }
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'rental',
                  entityId: rentalId,
                  action: 'invoice',
                  row: result.rental,
                  syncPayload: {
                    action: 'invoice',
                    rental: result.rental,
                    days: result.days,
                    amount: result.amount,
                    invoiced_through: result.invoiced_through,
                  },
                  outboxPayload: {
                    rental: result.rental,
                    bill_id: result.bill?.id ?? null,
                    days: result.days,
                    amount: result.amount,
                  },
                  // Versioned key so consecutive invoices for the same rental
                  // produce distinct outbox rows instead of upserting.
                  idempotencyKey: `rental:invoice:${rentalId}:${result.rental.version}`,
                })
                return result
              })
              sendJson(res, 200, {
                rental: processed.rental,
                bill: processed.bill,
                days: processed.days,
                amount: processed.amount,
                invoiced_through: processed.invoiced_through,
              })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/push-qbo$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const connection = await getIntegrationConnectionWithSecrets(company.id, 'qbo')

              const projectResult = await pool.query(
                'select id, name, customer_name, bid_total from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              if (!projectResult.rows[0]) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }

              const project = projectResult.rows[0]
              try {
                if (!connection?.access_token) {
                  const simulatedExternalId = `SIM-EST-${project.id.slice(0, 8)}`
                  const payload = {
                    simulated: true,
                    estimateId: simulatedExternalId,
                    projectId: project.id,
                    projectName: project.name,
                    amount: project.bid_total,
                  }
                  await withMutationTx(async (client) => {
                    await backfillProjectMapping(company.id, project, simulatedExternalId, client)
                    await recordMutationLedger(client, {
                      companyId: company.id,
                      entityType: 'project',
                      entityId: project.id,
                      action: 'push-qbo',
                      syncPayload: { action: 'push_qbo', payload, simulated: true },
                      outboxPayload: payload,
                    })
                  })
                  sendJson(res, 200, payload)
                  return
                }
                const estimatePayload = {
                  DocNumber: `EST-${project.id.slice(0, 8)}`,
                  CustomerRef: { value: connection.provider_account_id },
                  Line: [
                    {
                      Amount: Number(project.bid_total),
                      Description: project.name,
                      DetailType: 'SalesItemLineDetail',
                      SalesItemLineDetail: {
                        Qty: 1,
                        UnitPrice: Number(project.bid_total),
                      },
                    },
                  ],
                }

                const result = await qboPost(
                  '/estimate',
                  connection.provider_account_id ?? '',
                  connection.access_token ?? '',
                  estimatePayload,
                )

                let qboEstimateId = ''
                try {
                  qboEstimateId = parseQboEstimateCreateResponse(result).id
                } catch (e) {
                  if (e instanceof QboParseError) {
                    logger.error({ err: e, scope: 'qbo_push_estimate_parse' }, 'QBO estimate response parse failed')
                    Sentry.captureException(e, { tags: { scope: 'qbo_push_estimate_parse' } })
                    await recordSyncEvent(
                      company.id,
                      'project',
                      projectId,
                      { action: 'push_qbo', provider: 'qbo', raw: e.raw },
                      connection.id ?? null,
                      { status: 'failed', error: e.message },
                    )
                    sendJson(res, 502, { error: 'qbo returned malformed estimate response' })
                    return
                  }
                  throw e
                }
                await withMutationTx(async (client) => {
                  if (qboEstimateId) {
                    await backfillProjectMapping(company.id, project, qboEstimateId, client)
                  }
                  await recordSyncEvent(company.id, 'project', projectId, { action: 'push_qbo', result }, null, {
                    executor: client,
                  })
                })
                sendJson(res, 200, { success: true, result })
              } catch (error) {
                logger.error({ err: error, scope: 'qbo_push_estimate' }, 'Failed to push estimate to QBO')
                Sentry.captureException(error, { tags: { scope: 'qbo_push_estimate' } })
                sendJson(res, 500, { error: 'failed to push estimate to qbo' })
              }
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/schedules') {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const body = await readBody(req)
              if (!body.project_id || !body.scheduled_for) {
                sendJson(res, 400, { error: 'project_id and scheduled_for are required' })
                return
              }
              if (!isValidDateInput(body.scheduled_for)) {
                sendJson(res, 400, { error: 'scheduled_for must be YYYY-MM-DD' })
                return
              }
              const schedule = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version)
        values ($1, $2, $3, $4::jsonb, coalesce($5, 'draft'), 1)
        returning id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
        `,
                  [
                    company.id,
                    body.project_id,
                    body.scheduled_for,
                    JSON.stringify(body.crew ?? []),
                    body.status ?? 'draft',
                  ],
                )
                const row = result.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'crew_schedule',
                  entityId: row.id,
                  action: 'create',
                  row,
                  syncPayload: { action: 'create', schedule: row },
                })
                return row
              })
              sendJson(res, 201, schedule)
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/labor-entries') {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const body = await readBody(req)
              const required = ['project_id', 'service_item_code', 'hours', 'occurred_on']
              for (const key of required) {
                if (body[key] === undefined || body[key] === null || body[key] === '') {
                  sendJson(res, 400, { error: `${key} is required` })
                  return
                }
              }
              if (!isValidDateInput(body.occurred_on)) {
                sendJson(res, 400, { error: 'occurred_on must be YYYY-MM-DD' })
                return
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              if (expectedVersion !== null) {
                const projectVersionResult = await pool.query(
                  'select version from projects where company_id = $1 and id = $2',
                  [company.id, body.project_id],
                )
                const currentProject = projectVersionResult.rows[0]
                if (!currentProject) {
                  sendJson(res, 404, { error: 'project not found' })
                  return
                }
                if (Number(currentProject.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                  return
                }
              }
              const serviceItemCode = String(body.service_item_code)
              const divisionCodeInput =
                body.division_code === undefined ||
                body.division_code === null ||
                String(body.division_code).trim() === ''
                  ? null
                  : String(body.division_code).trim()
              if (divisionCodeInput) {
                const allowed = await assertDivisionAllowedForServiceItem(
                  company.id,
                  serviceItemCode,
                  divisionCodeInput,
                )
                if (!allowed) {
                  sendJson(res, 400, {
                    error: 'division_code not allowed for this service item',
                    service_item_code: serviceItemCode,
                    division_code: divisionCodeInput,
                  })
                  return
                }
              }
              const entry = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code)
        values ($1, $2, $3, $4, $5, coalesce($6, 0), coalesce($7, 'draft'), $8, $9)
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, created_at
        `,
                  [
                    company.id,
                    body.project_id,
                    body.worker_id ?? null,
                    serviceItemCode,
                    body.hours,
                    body.sqft_done ?? 0,
                    body.status ?? 'draft',
                    body.occurred_on,
                    divisionCodeInput,
                  ],
                )
                const row = result.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'labor_entry',
                  entityId: row.id,
                  action: 'create',
                  row,
                  syncPayload: { action: 'create', laborEntry: row },
                })
                await client.query(
                  'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                  [company.id, body.project_id],
                )
                return row
              })
              sendJson(res, 201, entry)
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/labor-entries') {
              const projectId = String(url.searchParams.get('project_id') ?? '').trim()
              const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
              const result = await pool.query(
                `
        select id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, version, deleted_at, created_at
        from labor_entries
        where company_id = $1 and ($2 = '' or project_id = $2)
        order by occurred_on desc, created_at desc
        limit $3
        `,
                [company.id, projectId, limit],
              )
              sendJson(res, 200, { laborEntries: result.rows })
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const laborEntryId = url.pathname.split('/')[3] ?? ''
              if (!laborEntryId) {
                sendJson(res, 400, { error: 'labor entry id is required' })
                return
              }
              const body = await readBody(req)
              const patchServiceItemCode =
                body.service_item_code === undefined || body.service_item_code === null
                  ? null
                  : String(body.service_item_code)
              const patchDivisionCode =
                body.division_code === undefined
                  ? null
                  : body.division_code === null || String(body.division_code).trim() === ''
                    ? null
                    : String(body.division_code).trim()
              // If the caller is changing either the service item or the division,
              // re-validate against the xref so we don't accept labor for a
              // combination that is no longer allowed.
              if (patchDivisionCode && (patchServiceItemCode || body.service_item_code !== undefined)) {
                const effectiveServiceItemCode =
                  patchServiceItemCode ??
                  (
                    await pool.query<{ service_item_code: string }>(
                      'select service_item_code from labor_entries where company_id = $1 and id = $2',
                      [company.id, laborEntryId],
                    )
                  ).rows[0]?.service_item_code
                if (effectiveServiceItemCode) {
                  const allowed = await assertDivisionAllowedForServiceItem(
                    company.id,
                    effectiveServiceItemCode,
                    patchDivisionCode,
                  )
                  if (!allowed) {
                    sendJson(res, 400, {
                      error: 'division_code not allowed for this service item',
                      service_item_code: effectiveServiceItemCode,
                      division_code: patchDivisionCode,
                    })
                    return
                  }
                }
              }
              const updated = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update labor_entries
        set
          worker_id = coalesce($3, worker_id),
          service_item_code = coalesce($4, service_item_code),
          hours = coalesce($5, hours),
          sqft_done = coalesce($6, sqft_done),
          status = coalesce($7, status),
          occurred_on = coalesce($8, occurred_on),
          division_code = case when $10::boolean then $9 else division_code end,
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, division_code, version, deleted_at, created_at
        `,
                  [
                    company.id,
                    laborEntryId,
                    body.worker_id ?? null,
                    patchServiceItemCode,
                    body.hours ?? null,
                    body.sqft_done ?? null,
                    body.status ?? null,
                    body.occurred_on ?? null,
                    patchDivisionCode,
                    body.division_code !== undefined,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'labor_entry',
                  entityId: laborEntryId,
                  action: 'update',
                  row,
                  syncPayload: { action: 'update', laborEntry: row },
                })
                return row
              })
              if (!updated) {
                sendJson(res, 404, { error: 'labor entry not found' })
                return
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const laborEntryId = url.pathname.split('/')[3] ?? ''
              if (!laborEntryId) {
                sendJson(res, 400, { error: 'labor entry id is required' })
                return
              }
              const deleted = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update labor_entries
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at, created_at
        `,
                  [company.id, laborEntryId],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'labor_entry',
                  entityId: laborEntryId,
                  action: 'delete',
                  row,
                  syncPayload: { action: 'delete', laborEntry: row },
                })
                return row
              })
              if (!deleted) {
                sendJson(res, 404, { error: 'labor entry not found' })
                return
              }
              sendJson(res, 200, deleted)
              return
            }

            // ----------------------------------------------------------------
            // Clock events: geofenced passive clock-in/out for crew members.
            // Every membership role can clock themselves in/out. Foreman/admin
            // see the team timeline via GET /api/clock/timeline.
            // ----------------------------------------------------------------

            if (req.method === 'POST' && url.pathname === '/api/clock/in') {
              const body = await readBody(req)
              const lat = parseOptionalNumber(body.lat)
              const lng = parseOptionalNumber(body.lng)
              if (lat === null || lng === null) {
                sendJson(res, 400, { error: 'lat and lng are required' })
                return
              }
              const accuracy = parseOptionalNumber(body.accuracy_m)
              const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null
              const currentUserId = identity.userId

              // Resolve the worker for this user. Workers are seeded without a
              // clerk_user_id link, so we fall back to the first worker in the
              // company when we can't identify one. This matches how the rest
              // of the app treats "demo-user" -> "Crew Lead" today.
              const workerLookup = await pool.query<{ id: string }>(
                `
                select w.id
                from workers w
                where w.company_id = $1 and w.deleted_at is null
                order by w.created_at asc
                limit 1
                `,
                [company.id],
              )
              const workerId = workerLookup.rows[0]?.id ?? null

              // Project resolution precedence:
              //   1. explicit project_id from the body (foreman override).
              //   2. project whose geofence contains (lat, lng).
              //   3. null (accepts the punch but marks inside_geofence=false).
              let projectId: string | null = null
              let insideGeofence = false
              const explicitProjectId =
                body.project_id === undefined || body.project_id === null || body.project_id === ''
                  ? null
                  : String(body.project_id).trim()
              if (explicitProjectId) {
                if (!isValidUuid(explicitProjectId)) {
                  sendJson(res, 400, { error: 'project_id must be a valid uuid' })
                  return
                }
                const explicitProject = await pool.query<{
                  id: string
                  site_lat: string | null
                  site_lng: string | null
                  site_radius_m: number | null
                }>(
                  `
                  select id, site_lat, site_lng, site_radius_m
                  from projects
                  where company_id = $1 and id = $2 and deleted_at is null
                  limit 1
                  `,
                  [company.id, explicitProjectId],
                )
                if (!explicitProject.rows[0]) {
                  sendJson(res, 404, { error: 'project not found' })
                  return
                }
                projectId = explicitProject.rows[0].id
                const pLat = Number(explicitProject.rows[0].site_lat)
                const pLng = Number(explicitProject.rows[0].site_lng)
                const pRad = Number(explicitProject.rows[0].site_radius_m ?? 0)
                if (Number.isFinite(pLat) && Number.isFinite(pLng) && pRad > 0) {
                  insideGeofence = isInsideGeofence({
                    lat: pLat,
                    lng: pLng,
                    radius_m: pRad,
                    point: { lat, lng },
                  })
                }
              } else {
                const candidateProjects = await pool.query<{
                  id: string
                  site_lat: string | null
                  site_lng: string | null
                  site_radius_m: number | null
                }>(
                  `
                  select id, site_lat, site_lng, site_radius_m
                  from projects
                  where company_id = $1
                    and deleted_at is null
                    and site_lat is not null
                    and site_lng is not null
                    and site_radius_m is not null
                    and site_radius_m > 0
                  `,
                  [company.id],
                )
                let bestDistance = Number.POSITIVE_INFINITY
                for (const row of candidateProjects.rows) {
                  const pLat = Number(row.site_lat)
                  const pLng = Number(row.site_lng)
                  const pRad = Number(row.site_radius_m ?? 0)
                  if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || pRad <= 0) continue
                  if (!isInsideGeofence({ lat: pLat, lng: pLng, radius_m: pRad, point: { lat, lng } })) continue
                  const distance = haversineDistanceMeters({ lat: pLat, lng: pLng }, { lat, lng })
                  if (distance < bestDistance) {
                    bestDistance = distance
                    projectId = row.id
                    insideGeofence = true
                  }
                }
              }

              const inserted = await pool.query(
                `
                insert into clock_events (
                  company_id, worker_id, project_id, clerk_user_id, event_type,
                  lat, lng, accuracy_m, inside_geofence, notes
                )
                values ($1, $2, $3, $4, 'in', $5, $6, $7, $8, $9)
                returning id, company_id, worker_id, project_id, clerk_user_id,
                          event_type, occurred_at, lat, lng, accuracy_m,
                          inside_geofence, notes, created_at
                `,
                [company.id, workerId, projectId, currentUserId, lat, lng, accuracy, insideGeofence, notes],
              )
              sendJson(res, 201, { clockEvent: inserted.rows[0] })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/clock/out') {
              const body = await readBody(req)
              const lat = parseOptionalNumber(body.lat)
              const lng = parseOptionalNumber(body.lng)
              const accuracy = parseOptionalNumber(body.accuracy_m)
              const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null
              const currentUserId = identity.userId

              const workerLookup = await pool.query<{ id: string }>(
                `
                select w.id
                from workers w
                where w.company_id = $1 and w.deleted_at is null
                order by w.created_at asc
                limit 1
                `,
                [company.id],
              )
              const workerId = workerLookup.rows[0]?.id ?? null

              // Find the most-recent open 'in' for this worker to pair with.
              // "Open" means: latest clock event for the worker is an 'in'.
              const openInLookup = await pool.query<{
                id: string
                project_id: string | null
                occurred_at: string
                event_type: string
              }>(
                `
                select id, project_id, occurred_at, event_type
                from clock_events
                where company_id = $1
                  and (
                    ($2::uuid is not null and worker_id = $2::uuid)
                    or ($2::uuid is null and clerk_user_id = $3)
                  )
                order by occurred_at desc
                limit 1
                `,
                [company.id, workerId, currentUserId],
              )
              const openIn = openInLookup.rows[0]
              if (!openIn || openIn.event_type !== 'in') {
                sendJson(res, 409, { error: 'no open clock-in found for this worker' })
                return
              }

              const projectId = openIn.project_id
              let insideGeofence: boolean | null = null
              if (projectId && lat !== null && lng !== null) {
                const projectRow = await pool.query<{
                  site_lat: string | null
                  site_lng: string | null
                  site_radius_m: number | null
                }>('select site_lat, site_lng, site_radius_m from projects where company_id = $1 and id = $2', [
                  company.id,
                  projectId,
                ])
                const row = projectRow.rows[0]
                if (row) {
                  const pLat = Number(row.site_lat)
                  const pLng = Number(row.site_lng)
                  const pRad = Number(row.site_radius_m ?? 0)
                  if (Number.isFinite(pLat) && Number.isFinite(pLng) && pRad > 0) {
                    insideGeofence = isInsideGeofence({
                      lat: pLat,
                      lng: pLng,
                      radius_m: pRad,
                      point: { lat, lng },
                    })
                  }
                }
              }

              const inserted = await pool.query<{
                id: string
                worker_id: string | null
                project_id: string | null
                occurred_at: string
              }>(
                `
                insert into clock_events (
                  company_id, worker_id, project_id, clerk_user_id, event_type,
                  lat, lng, accuracy_m, inside_geofence, notes
                )
                values ($1, $2, $3, $4, 'out', $5, $6, $7, $8, $9)
                returning id, company_id, worker_id, project_id, clerk_user_id,
                          event_type, occurred_at, lat, lng, accuracy_m,
                          inside_geofence, notes, created_at
                `,
                [company.id, workerId, projectId, currentUserId, lat, lng, accuracy, insideGeofence, notes],
              )
              const outRow = inserted.rows[0]!

              // Derive a draft labor entry when we have all the inputs:
              // a project, a worker, and a sensible duration (<24h) between
              // the paired in/out. Foreman still confirms during /confirm.
              let laborEntry: Record<string, unknown> | null = null
              if (projectId && workerId) {
                const startMs = Date.parse(openIn.occurred_at)
                const endMs = Date.parse(outRow.occurred_at)
                if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
                  const rawHours = (endMs - startMs) / (1000 * 60 * 60)
                  if (rawHours > 0 && rawHours < 24) {
                    const hours = Math.round(rawHours * 100) / 100
                    const occurredOn = new Date(startMs).toISOString().slice(0, 10)
                    laborEntry = await withMutationTx(async (client) => {
                      const laborInsert = await client.query(
                        `
                      insert into labor_entries (
                        company_id, project_id, worker_id, service_item_code,
                        hours, sqft_done, status, occurred_on
                      )
                      values ($1, $2, $3, '', $4, 0, 'draft', $5)
                      returning id, project_id, worker_id, service_item_code, hours,
                                sqft_done, status, occurred_on, version, deleted_at, created_at
                      `,
                        [company.id, projectId, workerId, hours, occurredOn],
                      )
                      const row = laborInsert.rows[0] as Record<string, unknown>
                      await recordMutationLedger(client, {
                        companyId: company.id,
                        entityType: 'labor_entry',
                        entityId: String(row.id),
                        action: 'create',
                        row,
                        syncPayload: { action: 'create', source: 'clock_out', laborEntry: row },
                      })
                      return row
                    })
                  }
                }
              }

              sendJson(res, 201, { clockEvent: outRow, laborEntry })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/clock/timeline') {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const workerIdParam = String(url.searchParams.get('worker_id') ?? '').trim()
              const dateParam = String(url.searchParams.get('date') ?? '').trim()
              const result = await pool.query(
                `
                select id, company_id, worker_id, project_id, clerk_user_id,
                       event_type, occurred_at, lat, lng, accuracy_m,
                       inside_geofence, notes, created_at
                from clock_events
                where company_id = $1
                  and ($2 = '' or worker_id = $2::uuid)
                  and (
                    $3 = ''
                    or (occurred_at >= ($3::date) and occurred_at < ($3::date + interval '1 day'))
                  )
                order by occurred_at asc
                limit 500
                `,
                [company.id, workerIdParam, dateParam],
              )
              sendJson(res, 200, { events: result.rows })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurement$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const measurementInput = prepareTakeoffMeasurementInput(body)

              const projectVersionResult = await pool.query(
                'select version from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const currentProject = projectVersionResult.rows[0]
              if (!currentProject) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                return
              }

              await assertBlueprintDocumentsBelongToProject(company.id, projectId, [
                measurementInput.blueprintDocumentId,
              ])

              // Curated-catalog enforcement (per spec): a takeoff cannot reference
              // a service item without at least one curated division mapping, and
              // if a division was supplied it must be in the allowed set.
              const projectDivisionResult = await pool.query<{ division_code: string | null }>(
                'select division_code from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const fallbackDivision =
                measurementInput.divisionCode ?? projectDivisionResult.rows[0]?.division_code ?? null
              const catalogStatus = await assertServiceItemCatalogStatus(
                company.id,
                measurementInput.serviceItemCode,
                fallbackDivision,
              )
              if (!catalogStatus.ok) {
                sendJson(res, 422, {
                  error: rejectionMessageForCatalog(catalogStatus.reason),
                  service_item_code: measurementInput.serviceItemCode,
                  division_code: fallbackDivision,
                })
                return
              }

              const measurement = await withMutationTx(async (client) => {
                const insertResult = await client.query(
                  `
        insert into takeoff_measurements (
          company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code
        )
        values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1, $9)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, division_code, version, deleted_at, created_at
        `,
                  [
                    company.id,
                    projectId,
                    measurementInput.blueprintDocumentId,
                    measurementInput.serviceItemCode,
                    measurementInput.quantity,
                    measurementInput.unit,
                    measurementInput.notes,
                    measurementInput.geometryJson,
                    measurementInput.divisionCode,
                  ],
                )
                const row = insertResult.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'takeoff_measurement',
                  entityId: row.id,
                  action: 'create',
                  row,
                  syncPayload: { action: 'create', measurement: row },
                  outboxPayload: { measurement: row },
                  actorUserId: getCurrentUserId(req),
                })
                return row
              })
              // Estimate recompute is a separate side-effect that fans out to
              // estimate_lines; not inside the mutation tx because a recompute
              // failure must not roll back a successfully-recorded measurement.
              const estimate = await createEstimateFromMeasurements(company.id, projectId)
              const scopeVsBid = await getScopeVsBid(company.id, projectId)
              sendJson(res, 201, { measurement, estimate, scope_vs_bid: scopeVsBid })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              const body = await readBody(req)
              const measurements = Array.isArray(body.measurements) ? body.measurements : []
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)

              if (!measurements.length) {
                sendJson(res, 400, { error: 'measurements array is required' })
                return
              }

              const preparedMeasurements = measurements.map((measurement, index) =>
                prepareTakeoffMeasurementInput(measurement, `measurements[${index}]`),
              )
              const projectVersionResult = await pool.query(
                'select version from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const currentProject = projectVersionResult.rows[0]
              if (!currentProject) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                return
              }
              await assertBlueprintDocumentsBelongToProject(
                company.id,
                projectId,
                preparedMeasurements.map((measurement) => measurement.blueprintDocumentId),
              )

              // Curated-catalog enforcement applied per measurement BEFORE the
              // destructive soft-delete of the existing set, so a single bad
              // row doesn't wipe the project's takeoff history. Pre-load the
              // (service_item_code, division_code) tuples in one query so a
              // 50-measurement replay doesn't fan out to 100 round-trips.
              const projectDivisionResult = await pool.query<{ division_code: string | null }>(
                'select division_code from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const projectDivisionCode = projectDivisionResult.rows[0]?.division_code ?? null
              const catalogIndex = await loadServiceItemCatalogIndex(
                pool,
                company.id,
                preparedMeasurements.map((m) => m.serviceItemCode),
              )
              for (const measurement of preparedMeasurements) {
                const fallbackDivision = measurement.divisionCode ?? projectDivisionCode
                const catalogStatus = catalogIndex.check(measurement.serviceItemCode, fallbackDivision)
                if (!catalogStatus.ok) {
                  sendJson(res, 422, {
                    error: rejectionMessageForCatalog(catalogStatus.reason),
                    service_item_code: measurement.serviceItemCode,
                    division_code: fallbackDivision,
                  })
                  return
                }
              }

              const replaced = await withMutationTx(async (client) => {
                await client.query(
                  `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and project_id = $2 and deleted_at is null
        `,
                  [company.id, projectId],
                )

                const createdRows: Record<string, unknown>[] = []
                for (const measurement of preparedMeasurements) {
                  const insertResult = await client.query(
                    `
          insert into takeoff_measurements (
            company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code
          )
          values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1, $9)
          returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, division_code, version, deleted_at, created_at
          `,
                    [
                      company.id,
                      projectId,
                      measurement.blueprintDocumentId,
                      measurement.serviceItemCode,
                      measurement.quantity,
                      measurement.unit,
                      measurement.notes,
                      measurement.geometryJson,
                      measurement.divisionCode,
                    ],
                  )
                  createdRows.push(insertResult.rows[0])
                }

                const estimate = await createEstimateFromMeasurements(company.id, projectId, client)
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'takeoff_measurement',
                  entityId: projectId,
                  action: 'replace',
                  syncPayload: {
                    action: 'replace',
                    measurementCount: createdRows.length,
                    measurements: createdRows,
                    estimate,
                  },
                  outboxPayload: {
                    measurementCount: createdRows.length,
                    measurements: createdRows,
                    estimate,
                  },
                })
                return { createdRows, estimate }
              })
              const scopeVsBid = await getScopeVsBid(company.id, projectId)
              sendJson(res, 201, {
                measurements: replaced.createdRows,
                estimate: replaced.estimate,
                scope_vs_bid: scopeVsBid,
              })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/recompute$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const estimate = await withMutationTx(async (client) => {
                const computed = await createEstimateFromMeasurements(company.id, projectId, client)
                if (!computed) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'estimate',
                  entityId: projectId,
                  action: 'recompute',
                  syncPayload: { action: 'recompute', estimate: computed },
                  outboxPayload: computed as Record<string, unknown>,
                })
                return computed
              })
              if (!estimate) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              const scopeVsBid = await getScopeVsBid(company.id, projectId)
              ;(estimate as { scope_vs_bid?: unknown }).scope_vs_bid = scopeVsBid
              sendJson(res, 200, estimate)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/summary$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const summary = await summarizeProject(company.id, projectId)
              if (!summary) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              sendJson(res, 200, summary)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\.pdf$/)) {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const summary = await summarizeProject(company.id, projectId)
              if (!summary) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              const pdfInput = buildEstimatePdfInputFromSummary({
                company: { name: company.name, slug: company.slug },
                summary,
                appUrl: process.env.APP_PUBLIC_URL ?? 'https://sitelayer.sandolab.xyz',
              })
              const filename = `estimate-${summary.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.pdf`
              res.writeHead(200, {
                'content-type': 'application/pdf',
                'content-disposition': `attachment; filename="${filename}"`,
                'cache-control': 'no-store',
                'access-control-allow-origin': getCorsOrigin(req),
                'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                'access-control-allow-headers': CORS_ALLOW_HEADERS,
                'access-control-allow-credentials': 'true',
                'x-request-id': getRequestContext()?.requestId ?? '',
              })
              await renderEstimatePdf(pdfInput, res)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/scope-vs-bid$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const result = await getScopeVsBid(company.id, projectId)
              if (!result) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              sendJson(res, 200, result)
              return
            }

            {
              const match = url.pathname.match(/^\/api\/service-items\/([^/]+)\/divisions$/)
              if (match) {
                const code = decodeURIComponent(match[1] ?? '')
                if (req.method === 'GET') {
                  const divisions = await listServiceItemDivisions(company.id, code)
                  sendJson(res, 200, { service_item_code: code, divisions })
                  return
                }
                if (req.method === 'PUT') {
                  if (!requireRole(res, company, ['admin', 'office'], req)) return
                  const body = await readBody(req)
                  const rawCodes = Array.isArray(body.division_codes) ? body.division_codes : null
                  if (!rawCodes) {
                    sendJson(res, 400, { error: 'division_codes must be an array' })
                    return
                  }
                  const divisionCodes = Array.from(
                    new Set(
                      rawCodes
                        .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
                        .filter((value: string) => value.length > 0),
                    ),
                  )
                  // Verify the service item exists for this company so we can
                  // return a clean 404 rather than a FK error.
                  const serviceItemExists = await pool.query<{ exists: boolean }>(
                    `select exists(
                       select 1 from service_items
                        where company_id = $1 and code = $2 and deleted_at is null
                     ) as exists`,
                    [company.id, code],
                  )
                  if (!serviceItemExists.rows[0]?.exists) {
                    sendJson(res, 404, { error: 'service item not found' })
                    return
                  }
                  if (divisionCodes.length > 0) {
                    const validDivisions = await pool.query<{ code: string }>(
                      `select code from divisions where company_id = $1 and code = any($2::text[])`,
                      [company.id, divisionCodes],
                    )
                    const validSet = new Set(validDivisions.rows.map((row) => row.code))
                    const unknown = divisionCodes.filter((value) => !validSet.has(value))
                    if (unknown.length > 0) {
                      sendJson(res, 400, {
                        error: 'one or more division_codes do not exist for this company',
                        unknown,
                      })
                      return
                    }
                  }
                  await withMutationTx(async (client) => {
                    await client.query(
                      `delete from service_item_divisions where company_id = $1 and service_item_code = $2`,
                      [company.id, code],
                    )
                    if (divisionCodes.length > 0) {
                      // Single multi-row INSERT replaces the previous
                      // per-division round-trip. on conflict do nothing keeps
                      // the migration idempotent if a division pair is
                      // re-asserted between the delete and insert.
                      await client.query(
                        `insert into service_item_divisions (company_id, service_item_code, division_code)
                         select $1::uuid, $2::text, division_code
                         from unnest($3::text[]) as t(division_code)
                         on conflict do nothing`,
                        [company.id, code, divisionCodes],
                      )
                    }
                    await recordSyncEvent(
                      company.id,
                      'service_item_divisions',
                      code,
                      { action: 'replace', divisions: divisionCodes },
                      null,
                      { executor: client },
                    )
                  })
                  const divisions = await listServiceItemDivisions(company.id, code)
                  sendJson(res, 200, { service_item_code: code, divisions })
                  return
                }
              }
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics') {
              sendJson(res, 200, await listAnalytics(company.id))
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/history') {
              const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
              const to = url.searchParams.get('to') ?? new Date().toISOString()

              const result = await pool.query(
                `
        select
          date_trunc('day', le.occurred_on)::date as day,
          p.division_code,
          sum(le.hours) as total_hours,
          sum(le.sqft_done) as total_sqft,
          count(distinct p.id) as project_count
        from labor_entries le
        join projects p on le.project_id = p.id
        where le.company_id = $1 and le.occurred_on >= $2::timestamp and le.occurred_on < $3::timestamp and le.deleted_at is null
        group by date_trunc('day', le.occurred_on), p.division_code
        order by day desc
        `,
                [company.id, from, to],
              )

              const history = result.rows.map((row) => ({
                date: row.day,
                division: row.division_code,
                hours: Number(row.total_hours ?? 0),
                sqft: Number(row.total_sqft ?? 0),
                projects: Number(row.project_count ?? 0),
                productivity:
                  Number(row.total_hours ?? 0) > 0 ? Number(row.total_sqft ?? 0) / Number(row.total_hours ?? 0) : 0,
              }))

              sendJson(res, 200, { history, from, to })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/divisions') {
              const roleCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [company.id, identity.userId],
              )
              const role = roleCheck.rows[0]?.role ?? null
              // TODO: once workers carry a clerk_user_id link (or a join table
              // between workers and company_memberships exists), scope results
              // to foreman/member by the divisions they have labor on. Today
              // workers have no auth identity, so this endpoint is admin/office
              // only.
              if (role !== 'admin' && role !== 'office') {
                sendJson(res, 403, { error: 'admin or office role required' })
                return
              }
              const since = url.searchParams.get('since')
              sendJson(res, 200, await listDivisionAnalytics(company.id, { since }))
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/service-item-productivity') {
              const roleCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [company.id, identity.userId],
              )
              const role = roleCheck.rows[0]?.role ?? null
              if (role !== 'admin' && role !== 'office') {
                sendJson(res, 403, { error: 'admin or office role required' })
                return
              }
              sendJson(res, 200, await listServiceItemProductivity(company.id))
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/labor/by-item') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const filters = parseLaborReportFilters(url.searchParams)
              sendJson(res, 200, { rows: await listLaborByItem(pool, company.id, filters), filters })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/labor/by-worker') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const filters = parseLaborReportFilters(url.searchParams)
              sendJson(res, 200, { rows: await listLaborByWorker(pool, company.id, filters), filters })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/labor/by-week') {
              if (!requireRole(res, company, ['admin', 'office'], req)) return
              const filters = parseLaborReportFilters(url.searchParams)
              sendJson(res, 200, { rows: await listLaborByWeek(pool, company.id, filters), filters })
              return
            }

            const forecastHoursMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate\/forecast-hours$/)
            if (req.method === 'POST' && forecastHoursMatch) {
              const roleCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [company.id, identity.userId],
              )
              const role = roleCheck.rows[0]?.role ?? null
              if (role !== 'admin' && role !== 'office') {
                sendJson(res, 403, { error: 'admin or office role required' })
                return
              }
              const projectId = forecastHoursMatch[1] ?? ''
              if (!projectId || !isValidUuid(projectId)) {
                sendJson(res, 400, { error: 'project id must be a valid uuid' })
                return
              }
              const body = await readBody(req)
              try {
                const result = await forecastProjectHours(company.id, projectId, body)
                sendJson(res, 200, result)
              } catch (err) {
                if (err instanceof HttpError) {
                  sendJson(res, err.status, { error: err.message })
                  return
                }
                throw err
              }
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { blueprints: await listBlueprintDocuments(company.id, projectId) })
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { measurements: await listTakeoffMeasurements(company.id, projectId) })
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/schedules$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { schedules: await listSchedules(company.id, projectId) })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              let body: Record<string, any>
              let multipartResult: BlueprintMultipartResult | null = null
              let blueprintId: string
              if (isMultipartRequest(req)) {
                blueprintId = randomUUID()
                multipartResult = await parseBlueprintMultipart(
                  req,
                  storage,
                  company.id,
                  blueprintId,
                  'blueprint.pdf',
                  { maxFileBytes: maxBlueprintUploadBytes },
                )
                body = multipartResult.fields
              } else {
                body = await readBody(req)
                blueprintId = String(body.id ?? randomUUID())
              }
              const fileName = String(
                body.file_name ?? body.original_file_name ?? multipartResult?.fileName ?? '',
              ).trim()
              const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              if (!fileName && !fileContentsBase64 && !multipartResult) {
                sendJson(res, 400, { error: 'file_name, file_contents_base64, or multipart upload is required' })
                return
              }
              const versionResult = await pool.query<{ version: number }>(
                'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
                [company.id, projectId],
              )
              const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
              const resolvedFileName = fileName || multipartResult?.fileName || 'blueprint.pdf'
              let resolvedStoragePath = multipartResult
                ? multipartResult.storagePath
                : resolveBlueprintStoragePath(company.id, blueprintId, resolvedFileName, requestedStoragePath)
              if (!multipartResult && fileContentsBase64) {
                resolvedStoragePath = await persistBlueprintFile(
                  company.id,
                  blueprintId,
                  resolvedFileName,
                  fileContentsBase64,
                )
              }
              const blueprint = await withMutationTx(async (client) => {
                const inserted = await client.query(
                  `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                  [
                    blueprintId,
                    company.id,
                    projectId,
                    resolvedFileName,
                    resolvedStoragePath,
                    body.preview_type ?? null,
                    body.calibration_length ?? null,
                    body.calibration_unit ?? null,
                    body.sheet_scale ?? null,
                    version,
                    body.replaces_blueprint_document_id ?? null,
                  ],
                )
                const row = inserted.rows[0]
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'blueprint_document',
                  entityId: row.id,
                  action: 'create',
                  row,
                  syncPayload: { action: 'create', blueprint: row },
                })
                return row
              })
              sendJson(res, 201, blueprint)
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              let body: Record<string, any>
              let multipartResult: BlueprintMultipartResult | null = null
              if (isMultipartRequest(req)) {
                multipartResult = await parseBlueprintMultipart(
                  req,
                  storage,
                  company.id,
                  blueprintId,
                  'blueprint.pdf',
                  { maxFileBytes: maxBlueprintUploadBytes },
                )
                body = multipartResult.fields
              } else {
                body = await readBody(req)
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              const storagePath = multipartResult
                ? multipartResult.storagePath
                : body.storage_path === undefined || !String(body.storage_path).trim()
                  ? null
                  : resolveBlueprintStoragePath(
                      company.id,
                      blueprintId,
                      String(body.file_name ?? 'blueprint.pdf'),
                      String(body.storage_path),
                    )
              const updated = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update blueprint_documents
        set
          file_name = coalesce($3, file_name),
          storage_path = coalesce($4, storage_path),
          preview_type = coalesce($5, preview_type),
          calibration_length = coalesce($6, calibration_length),
          calibration_unit = coalesce($7, calibration_unit),
          sheet_scale = coalesce($8, sheet_scale),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                  [
                    company.id,
                    blueprintId,
                    body.file_name ?? multipartResult?.fileName ?? null,
                    storagePath,
                    body.preview_type ?? null,
                    body.calibration_length ?? null,
                    body.calibration_unit ?? null,
                    body.sheet_scale ?? null,
                    expectedVersion,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'blueprint_document',
                  entityId: blueprintId,
                  action: 'update',
                  row,
                  syncPayload: { action: 'update', blueprint: row },
                })
                return row
              })
              if (!updated) {
                if (
                  !(await checkVersion(
                    'blueprint_documents',
                    'company_id = $1 and id = $2',
                    [company.id, blueprintId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              // Persisting blob is post-commit: a storage write is not part of
              // the DB transaction, so blobs only land after the row is durable.
              if (fileContentsBase64) {
                await persistBlueprintFile(
                  company.id,
                  blueprintId,
                  String(updated.file_name ?? body.file_name ?? 'blueprint.pdf'),
                  fileContentsBase64,
                )
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/versions$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const sourceBlueprintId = url.pathname.split('/')[3] ?? ''
              if (!sourceBlueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const sourceResult = await pool.query(
                `
        select id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at
        from blueprint_documents
        where company_id = $1 and id = $2 and deleted_at is null
        limit 1
        `,
                [company.id, sourceBlueprintId],
              )
              const source = sourceResult.rows[0]
              if (!source) {
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              let body: Record<string, any>
              let multipartResult: BlueprintMultipartResult | null = null
              const blueprintId = randomUUID()
              if (isMultipartRequest(req)) {
                multipartResult = await parseBlueprintMultipart(
                  req,
                  storage,
                  company.id,
                  blueprintId,
                  String(source.file_name ?? 'blueprint.pdf'),
                  { maxFileBytes: maxBlueprintUploadBytes },
                )
                body = multipartResult.fields
              } else {
                body = await readBody(req)
              }
              const copyMeasurements = body.copy_measurements !== false
              const fileName = String(
                body.file_name ?? multipartResult?.fileName ?? source.file_name ?? 'blueprint.pdf',
              ).trim()
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              const versionResult = await pool.query<{ version: number }>(
                'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
                [company.id, source.project_id],
              )
              const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
              const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
              let storagePath = multipartResult
                ? multipartResult.storagePath
                : requestedStoragePath
                  ? resolveBlueprintStoragePath(company.id, blueprintId, fileName, requestedStoragePath)
                  : ''
              if (!multipartResult && fileContentsBase64) {
                storagePath = await persistBlueprintFile(company.id, blueprintId, fileName, fileContentsBase64)
              } else if (!multipartResult && source.storage_path) {
                try {
                  storagePath = await copyBlueprintFile(company.id, blueprintId, source.storage_path, fileName)
                } catch {
                  storagePath = getBlueprintFilePath(company.id, blueprintId, fileName)
                }
              } else if (!storagePath) {
                storagePath = getBlueprintFilePath(company.id, blueprintId, fileName)
              }
              const newBlueprint = await withMutationTx(async (client) => {
                const inserted = await client.query(
                  `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                  [
                    blueprintId,
                    company.id,
                    source.project_id,
                    fileName,
                    storagePath,
                    body.preview_type ?? source.preview_type ?? null,
                    body.calibration_length ?? source.calibration_length ?? null,
                    body.calibration_unit ?? source.calibration_unit ?? null,
                    body.sheet_scale ?? source.sheet_scale ?? null,
                    version,
                    source.id,
                  ],
                )
                const row = inserted.rows[0]
                if (copyMeasurements) {
                  const sourceMeasurements = await client.query(
                    `
          select project_id, service_item_code, quantity, unit, notes, geometry, division_code
          from takeoff_measurements
          where company_id = $1 and blueprint_document_id = $2 and deleted_at is null
          order by created_at asc
          `,
                    [company.id, source.id],
                  )
                  for (const measurement of sourceMeasurements.rows) {
                    await client.query(
                      `
            insert into takeoff_measurements (
              company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9)
            `,
                      [
                        company.id,
                        measurement.project_id,
                        row.id,
                        measurement.service_item_code,
                        measurement.quantity,
                        measurement.unit,
                        `${measurement.notes ?? ''}${measurement.notes ? ' · ' : ''}copied from blueprint v${source.version}`,
                        JSON.stringify(measurement.geometry ?? {}),
                        measurement.division_code ?? null,
                      ],
                    )
                  }
                }
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'blueprint_document',
                  entityId: row.id,
                  action: 'version',
                  row,
                  syncPayload: { action: 'version', source_blueprint_id: source.id, blueprint: row },
                })
                return row
              })
              sendJson(res, 201, newBlueprint)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/file$/)) {
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const result = await pool.query(
                'select file_name, storage_path from blueprint_documents where company_id = $1 and id = $2 and deleted_at is null limit 1',
                [company.id, blueprintId],
              )
              const blueprint = result.rows[0]
              if (!blueprint) {
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              try {
                const storageKey = assertBlueprintFilePath(company.id, String(blueprint.storage_path))
                const fileName = String(blueprint.file_name)
                if (blueprintDownloadPresigned) {
                  const signedUrl = await storage.getDownloadUrl(storageKey, { fileName })
                  if (signedUrl) {
                    res.writeHead(302, {
                      location: signedUrl,
                      'cache-control': 'no-store',
                      'access-control-allow-origin': getCorsOrigin(req),
                      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                      'access-control-allow-headers': CORS_ALLOW_HEADERS,
                    })
                    res.end()
                    return
                  }
                }
                const content = await storage.get(storageKey)
                const mimeType = getBlueprintMimeType(fileName)
                res.writeHead(200, {
                  'content-type': mimeType,
                  'content-disposition': `inline; filename="${sanitizeFileName(fileName)}"`,
                  'access-control-allow-origin': getCorsOrigin(req),
                  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                  'access-control-allow-headers': CORS_ALLOW_HEADERS,
                })
                res.end(content)
              } catch {
                sendJson(res, 404, { error: 'blueprint file not found' })
              }
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const measurementId = url.pathname.split('/')[4] ?? ''
              if (!measurementId) {
                sendJson(res, 400, { error: 'measurement id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              let geometryJson: string | null = null
              let quantity = body.quantity ?? null
              if (body.geometry !== undefined && body.geometry !== null && body.geometry !== '') {
                const geometry = normalizePolygonGeometry(body.geometry)
                if (!geometry) {
                  sendJson(res, 400, { error: 'geometry must be a polygon with at least 3 points inside the board' })
                  return
                }
                geometryJson = JSON.stringify(geometry)
                if (quantity === null || quantity === undefined || quantity === '') {
                  quantity = calculateTakeoffQuantity(geometry.points, geometry.sheet_scale ?? 1)
                }
                const numericQuantity = Number(quantity)
                // Reject NaN/Infinity explicitly: a self-intersecting polygon
                // can produce NaN, and `n <= 0` is false for NaN so the next
                // check would let it through with a less helpful message.
                if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
                  sendJson(res, 400, { error: 'geometry must produce a positive, finite area' })
                  return
                }
              }
              if (quantity !== null && quantity !== undefined && quantity !== '') {
                const parsedQuantity = Number(quantity)
                if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
                  sendJson(res, 400, { error: 'quantity must be a non-negative number' })
                  return
                }
                quantity = parsedQuantity
              }
              const patchBlueprintDocumentId =
                body.blueprint_document_id === undefined ||
                body.blueprint_document_id === null ||
                body.blueprint_document_id === ''
                  ? null
                  : String(body.blueprint_document_id)
              if (patchBlueprintDocumentId) {
                if (!isValidUuid(patchBlueprintDocumentId)) {
                  sendJson(res, 400, { error: 'blueprint_document_id must be a valid uuid' })
                  return
                }
                const measurementProjectResult = await pool.query<{ project_id: string }>(
                  'select project_id from takeoff_measurements where company_id = $1 and id = $2 and deleted_at is null limit 1',
                  [company.id, measurementId],
                )
                const measurementProjectId = measurementProjectResult.rows[0]?.project_id
                if (!measurementProjectId) {
                  sendJson(res, 404, { error: 'measurement not found' })
                  return
                }
                await assertBlueprintDocumentsBelongToProject(company.id, measurementProjectId, [
                  patchBlueprintDocumentId,
                ])
              }

              // LWW gate: if the client tells us the row hasn't changed since
              // a particular timestamp, but the server's `updated_at` is
              // newer, reject with 409 + the authoritative server row so the
              // offline replayer can show "your local edit was discarded".
              const ifUnmodifiedSince = req.headers['if-unmodified-since']
              if (ifUnmodifiedSince) {
                const currentRow = await pool.query<{
                  id: string
                  project_id: string
                  blueprint_document_id: string | null
                  service_item_code: string
                  quantity: string
                  unit: string
                  notes: string | null
                  geometry: unknown
                  version: number
                  deleted_at: string | null
                  created_at: string
                  updated_at: string
                }>(
                  `select id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes,
                          geometry, version, deleted_at, created_at, updated_at
                   from takeoff_measurements
                   where company_id = $1 and id = $2`,
                  [company.id, measurementId],
                )
                const current = currentRow.rows[0]
                if (current) {
                  const lww = evaluateLww(current.updated_at, ifUnmodifiedSince)
                  if (!lww.ok && lww.reason === 'server_newer') {
                    sendJson(res, 409, {
                      error: 'server has a newer change',
                      entity: 'takeoff_measurement',
                      server_value: current,
                      server_updated_at: lww.serverUpdatedAt.toISOString(),
                      client_reference: lww.clientReference.toISOString(),
                    })
                    return
                  }
                  if (!lww.ok && lww.reason === 'header_unparseable') {
                    sendJson(res, 400, {
                      error: 'If-Unmodified-Since header is not a valid timestamp',
                      raw: lww.rawHeader,
                    })
                    return
                  }
                }
              }

              const updated = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update takeoff_measurements
        set
          service_item_code = coalesce($3, service_item_code),
          quantity = coalesce($4, quantity),
          unit = coalesce($5, unit),
          notes = coalesce($6, notes),
          blueprint_document_id = coalesce($7, blueprint_document_id),
          geometry = coalesce($8::jsonb, geometry),
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at, updated_at
        `,
                  [
                    company.id,
                    measurementId,
                    body.service_item_code ?? null,
                    quantity,
                    body.unit ?? null,
                    body.notes ?? null,
                    patchBlueprintDocumentId,
                    geometryJson,
                    expectedVersion,
                  ],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'takeoff_measurement',
                  entityId: measurementId,
                  action: 'update',
                  row,
                  syncPayload: { action: 'update', measurement: row },
                })
                return row
              })
              if (!updated) {
                if (
                  !(await checkVersion(
                    'takeoff_measurements',
                    'company_id = $1 and id = $2',
                    [company.id, measurementId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'measurement not found' })
                return
              }
              sendJson(res, 200, updated)
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const measurementId = url.pathname.split('/')[4] ?? ''
              if (!measurementId) {
                sendJson(res, 400, { error: 'measurement id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const deleted = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
        `,
                  [company.id, measurementId, expectedVersion],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'takeoff_measurement',
                  entityId: measurementId,
                  action: 'delete',
                  row,
                  syncPayload: { action: 'delete', measurement: row },
                })
                return row
              })
              if (!deleted) {
                if (
                  !(await checkVersion(
                    'takeoff_measurements',
                    'company_id = $1 and id = $2',
                    [company.id, measurementId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'measurement not found' })
                return
              }
              sendJson(res, 200, deleted)
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/schedules\/[^/]+\/confirm$/)) {
              if (!requireRole(res, company, ['admin', 'foreman'], req)) return
              const scheduleId = url.pathname.split('/')[3] ?? ''
              if (!scheduleId) {
                sendJson(res, 400, { error: 'schedule id is required' })
                return
              }
              const body = await readBody(req)
              const entries = Array.isArray(body.entries) ? body.entries : []
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const confirmation = await withMutationTx(async (client) => {
                const scheduleResult = await client.query(
                  `
        update crew_schedules
        set status = 'confirmed', version = version + 1
        where company_id = $1 and id = $2 and ($3::int is null or version = $3)
        returning id, project_id, scheduled_for, crew, status, version, created_at
        `,
                  [company.id, scheduleId, expectedVersion],
                )
                const schedule = scheduleResult.rows[0]
                if (!schedule) return null
                const createdLaborEntries: Record<string, unknown>[] = []
                for (const entry of entries) {
                  if (!entry.service_item_code || entry.hours === undefined || !entry.occurred_on) continue
                  const inserted = await client.query(
                    `
          insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
          values ($1, $2, $3, $4, $5, coalesce($6, 0), 'confirmed', $7)
          returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, created_at
          `,
                    [
                      company.id,
                      schedule.project_id,
                      entry.worker_id ?? null,
                      entry.service_item_code,
                      entry.hours,
                      entry.sqft_done ?? 0,
                      entry.occurred_on,
                    ],
                  )
                  createdLaborEntries.push(inserted.rows[0])
                }
                await client.query(
                  'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                  [company.id, schedule.project_id],
                )
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'crew_schedule',
                  entityId: scheduleId,
                  action: 'confirm',
                  row: schedule,
                  syncPayload: { action: 'confirm', schedule, laborEntries: createdLaborEntries },
                  outboxPayload: { schedule, laborEntries: createdLaborEntries },
                })
                return { schedule, laborEntries: createdLaborEntries }
              })
              if (!confirmation) {
                if (
                  !(await checkVersion(
                    'crew_schedules',
                    'company_id = $1 and id = $2',
                    [company.id, scheduleId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'schedule not found' })
                return
              }
              sendJson(res, 200, confirmation)
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
              if (!requireRole(res, company, ['admin', 'foreman', 'office'], req)) return
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const deleted = await withMutationTx(async (client) => {
                const result = await client.query(
                  `
        update blueprint_documents
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, file_name, storage_path, version, deleted_at, created_at
        `,
                  [company.id, blueprintId, expectedVersion],
                )
                const row = result.rows[0]
                if (!row) return null
                await recordMutationLedger(client, {
                  companyId: company.id,
                  entityType: 'blueprint_document',
                  entityId: blueprintId,
                  action: 'delete',
                  row,
                  syncPayload: { action: 'delete', blueprint: row },
                })
                return row
              })
              if (!deleted) {
                if (
                  !(await checkVersion(
                    'blueprint_documents',
                    'company_id = $1 and id = $2',
                    [company.id, blueprintId],
                    expectedVersion,
                    res,
                    req,
                  ))
                ) {
                  return
                }
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              sendJson(res, 200, deleted)
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
                sendJson(res, 200, {
                  request_id: requestId,
                  lookup: { kind: byRequest ? 'request_id' : 'trace_id', id: lookupId },
                  trace_id: traceId,
                  sentry: sentryPayload,
                  sentry_error: sentryError,
                  queue: queueRows,
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

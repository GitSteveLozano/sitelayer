import { Sentry } from './instrument.js'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolConfig } from 'pg'
import { createLogger, getRequestContext, runWithRequestContext, type RequestContext } from '@sitelayer/logger'
import { loadAppConfig, logAppConfigBanner, postgresOptionsForTier, TierConfigError } from './tier.js'
import { validateQboStateSecret } from './qbo-config.js'
import { normalizeCompanyRole, type ActiveCompany, type CompanyRole } from './auth-types.js'
import { handleCompanyRoutes } from './routes/companies.js'
import { backfillCustomerMapping, listIntegrationMappings, upsertIntegrationMapping } from './routes/qbo.js'
import { assertBlueprintDocumentsBelongToProject } from './routes/takeoff-write.js'
import { dispatch } from './routes/dispatch.js'
import { handlePublicRoutes } from './routes/public.js'
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
import { AuthConfigError, AuthError, loadAuthConfig, resolveIdentity, type Identity } from './auth.js'
import { attachPool, observeRequest } from './metrics.js'
import { loadEmailConfig } from './email.js'
import { applyRateLimit, createRateLimiter, isRateLimitExempt, loadRateLimitConfig } from './rate-limit.js'
import { assertVersion } from './version-guard.js'
import { validateRequiredEnvVars } from './lib/env-validate.js'

const logger = createLogger('api')
validateRequiredEnvVars(logger)

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

// Most route handlers (bootstrap, summarizeProject, blueprints, takeoff,
// schedules, estimate, customers, workers, divisions, pricing-profiles,
// audit-events, bonus-rules, sync) now live under routes/*.ts and the
// dispatch cascade in routes/dispatch.ts. server.ts keeps only the
// cross-cutting auth/metrics/tx helpers and the request lifecycle.

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

            // Pre-auth public routes (CORS preflight, /health, /api/version,
            // /api/metrics, /api/features, /api/webhooks/{clerk,qbo}).
            // These run BEFORE Clerk identity resolution because they have
            // their own auth boundary (Bearer-metrics-token, svix HMAC,
            // Intuit HMAC) or no auth at all (CORS preflight, health probe).
            // See routes/public.ts for the registry.
            const publicHandled = await handlePublicRoutes(req, url, res, {
              pool,
              tier: appConfig.tier,
              buildSha,
              startedAt,
              metricsToken,
              clerkWebhookSecret,
              qboWebhookVerifier,
              pgHealthProbeTimeoutMs,
              features: { flags: appConfig.flags, ribbon: appConfig.ribbon },
              getCorsOrigin: () => getCorsOrigin(req),
              sendJson: (status, body) => sendJson(res, status, body, req),
              readRawBody: () => readRawBody(req),
            })
            if (publicHandled) return

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

            // Post-auth route cascade (system + entity routes + debug trace).
            // Order matches the pre-extraction inline cascade so behaviour is
            // preserved. See routes/dispatch.ts for the registry; route
            // modules in routes/* still own their own SQL, role gates, and
            // ledger writes — dispatch.ts only walks the list.
            const handled = await dispatch({
              req,
              res,
              url,
              pool,
              company,
              identity,
              tier: appConfig.tier,
              requestId,
              requireRole: (allowed) => requireRole(res, company, allowed as readonly CompanyRole[], req),
              readBody: () => readBody(req),
              sendJson: (status, body) => sendJson(res, status, body, req),
              sendRedirect: (location) => sendRedirect(res, location),
              checkVersion: (table, where, params, expectedVersion) =>
                checkVersion(table, where, params, expectedVersion, res, req),
              getCurrentUserId: () => getCurrentUserId(req),
              storage,
              maxBlueprintUploadBytes,
              blueprintDownloadPresigned,
              qboConfig: {
                clientId: qboClientId,
                clientSecret: qboClientSecret,
                redirectUri: qboRedirectUri,
                successRedirectUri: qboSuccessRedirectUri,
                stateSecret: qboStateSecret,
                baseUrl: qboBaseUrl,
              },
              backfillCustomerMapping: (companyId, customer, executor) =>
                backfillCustomerMapping(pool, companyId, customer, executor),
              listIntegrationMappings: (companyId, provider, entityType) =>
                listIntegrationMappings(pool, companyId, provider, entityType),
              upsertIntegrationMapping: (companyId, provider, values, executor) =>
                upsertIntegrationMapping(pool, companyId, provider, values, executor),
              assertBlueprintDocumentsBelongToProject: (companyId, projectId, blueprintDocumentIds) =>
                assertBlueprintDocumentsBelongToProject(pool, companyId, projectId, blueprintDocumentIds),
              assertDivisionAllowedForServiceItem: (companyId, serviceItemCode, divisionCode) =>
                assertDivisionAllowedForServiceItem(companyId, serviceItemCode, divisionCode),
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
                await renderEstimatePdf(input as Parameters<typeof renderEstimatePdf>[0], res)
              },
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
              setHeader: (name, value) => {
                res.setHeader(name, value)
              },
              send304: (etag) => {
                res.writeHead(304, {
                  ETag: etag,
                  'access-control-allow-origin': getCorsOrigin(req),
                })
                res.end()
              },
            })
            if (handled) return

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

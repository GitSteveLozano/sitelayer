// Deploys run from the fleet via scripts/deploy.sh (off GitHub Actions).
import { Sentry } from './instrument.js'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolConfig } from 'pg'
import { createLogger, getRequestContext, runWithRequestContext, type RequestContext } from '@sitelayer/logger'
import { loadAppConfig, logAppConfigBanner, postgresOptionsForTier, TierConfigError } from './tier.js'
import { resolveDatabasePoolSsl } from '@sitelayer/config'
import { validateQboStateSecret } from './qbo-config.js'
import { normalizeCompanyRole, type ActiveCompany, type CompanyRole } from './auth-types.js'
import { companyRoleToBuiltin, type BuiltinRole, type PermissionAction, type PermissionGrant } from '@sitelayer/domain'
import {
  normalizeGrantConstraints,
  permissionDecision,
  resolveCompanyRoleAuthority,
  type CustomRoleAuthority,
} from './permission-seam.js'
import {
  requireCapability as requireCapabilityResolver,
  resolveAppIssueCapabilities as resolveAppIssueCapabilitiesResolver,
  type CapabilityContext,
} from './capability.js'
import { parseSuperadminEnvIds } from './admin-auth.js'
import { handleCompanyRoutes, loadCompanyCreateGateConfig } from './routes/companies.js'
import { handleInviteRoutes } from './routes/invites.js'
import { handleFeedbackInviteRoutes } from './routes/feedback-invites.js'
import { backfillCustomerMapping, listIntegrationMappings, upsertIntegrationMapping } from './routes/qbo.js'
import { assertBlueprintDocumentsBelongToProject } from './routes/takeoff-write.js'
import { resolveBlueprintVisionProvider } from './takeoff-capture-pipelines/blueprint-vision.js'
import { isAiChatEnabled } from './mesh-dispatcher.js'
import { dispatch, dispatchPlatformAdminRoutes } from './routes/dispatch.js'
import { handlePublicRoutes } from './routes/public.js'
import { handleSignalRoutes } from './routes/signal.js'
import { handleAgentFeedRoutes } from './routes/agent-feed.js'
import { handlePublicEstimateShareRoutes } from './routes/estimate-shares-portal.js'
import { handlePortalRentalRoutes } from './routes/portal-rentals.js'
import { handlePublicPortalRoutes } from './routes/portal-public.js'
import { handleAdminWorkRequestRoutes } from './routes/admin-work-requests.js'
import {
  createClerkSignInTokenMinter,
  handleDemoRoutes,
  resolveDemoSignInTokenTtlSeconds,
  type SignInTokenMinter,
} from './routes/demo.js'
import {
  CORS_ALLOW_HEADERS,
  HttpError,
  getCorsOrigin as getCorsOriginImpl,
  readBody as readBodyImpl,
  sendJson as sendJsonImpl,
  sendRedirect,
} from './http-utils.js'
import { attachMutationTx } from './mutation-tx.js'
import { autoOnboardFirstAdmin } from './auto-onboard.js'
import { continueRequestTrace, shouldBypassTraceContinuation } from './trace-ingress.js'
import { createBlueprintStorage, readStorageEnv, type BlueprintStorage } from './storage.js'
import { BlueprintUploadError } from './blueprint-upload.js'
import { renderEstimatePdf } from './pdf.js'
import {
  AuthConfigError,
  AuthError,
  loadAuthConfig,
  resolveActAsOverride,
  resolveIdentity,
  type Identity,
} from './auth.js'
import { attachPool, observeRequest } from './metrics.js'
import { loadEmailConfig } from './email.js'
import {
  applyRateLimit,
  createRateLimiter,
  enforcePortalTokenRateLimit,
  isRateLimitExempt,
  loadRateLimitConfig,
} from './rate-limit.js'
import { assertVersion } from './version-guard.js'
import { validateRequiredEnvVars } from './lib/env-validate.js'
import { getBuildSha } from './lib/build-sha.js'
import {
  createIdempotencyCache,
  isIdempotentPostPath,
  validateIdempotencyKey,
  type IdempotencyCachedResponse,
} from './idempotency.js'
import {
  matchWorkRequestCallbackWorkItemId,
  resolveWorkRequestCallbackCompany,
} from './work-request-callback-company.js'

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
// Resolved via lib/build-sha.ts so the same value travels the
// `x-sitelayer-build-sha` response header AND the `/api/version` body.
// Resolution order: SITELAYER_BUILD_SHA → APP_BUILD_SHA → SENTRY_RELEASE
// → repo-root BUILD_SHA file → 'dev'. See that module for the rationale.
const buildSha = getBuildSha()
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
// Estimate share-link HMAC secret (sales loop / client portal). Falls back to
// QBO_STATE_SECRET in non-prod so dev fixtures keep working without an extra
// env var; in prod we still accept the fallback but log a warning so it can
// be rotated independently. See apps/api/src/estimate-share-token.ts.
const estimateShareSecret = process.env.ESTIMATE_SHARE_SECRET?.trim() || qboStateSecret || ''
if (appConfig.tier === 'prod' && !process.env.ESTIMATE_SHARE_SECRET?.trim()) {
  logger.warn('[estimate-share] ESTIMATE_SHARE_SECRET not set; falling back to QBO_STATE_SECRET')
}
const portalBaseUrl = process.env.APP_PUBLIC_URL?.trim() || 'https://sitelayer.sandolab.xyz'
const feedbackInviteSecret =
  process.env.FEEDBACK_INVITE_SECRET?.trim() || (appConfig.tier === 'prod' ? '' : estimateShareSecret)
if (appConfig.tier === 'prod' && !process.env.FEEDBACK_INVITE_SECRET?.trim()) {
  logger.warn('[feedback-invite] FEEDBACK_INVITE_SECRET not set; feedback invite routes will return 503')
}
// Demo-tier magic-link config. Only meaningful when APP_TIER=demo (the route
// module hard-gates on tier). The shared access code + the Clerk sign-in-token
// minter are resolved here so the handler stays pure. The minter reuses
// CLERK_SECRET_KEY (the same Clerk TEST instance secret already used by the
// worker's welcome-email runner). When the secret is missing the minter is a
// no-op that returns null, surfacing as a clear "not configured" error.
// Bootstrap superadmin allowlist for the app_issue.* (platform-scope)
// capability boundary. Same source admin-work-requests.ts uses for its
// platform-admin gate; resolved once so the requireCapability closure (and the
// admin-auth isSuperadmin lookup behind it) doesn't reparse the env per request.
const superadminEnvIds = parseSuperadminEnvIds(process.env.PLATFORM_SUPERADMIN_CLERK_IDS)
const demoAccessCode = process.env.DEMO_ACCESS_CODE?.trim() || null
const demoAppOrigin = process.env.DEMO_APP_ORIGIN?.trim() || portalBaseUrl
const demoTicketTtlSeconds = resolveDemoSignInTokenTtlSeconds(process.env)
const demoSignInTokenMinter: SignInTokenMinter = (() => {
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim()
  if (appConfig.tier === 'demo' && clerkSecretKey) {
    return createClerkSignInTokenMinter({ secretKey: clerkSecretKey, expiresInSeconds: demoTicketTtlSeconds })
  }
  // Not configured (or not the demo tier): never mints, always "unseeded".
  return async () => null
})()
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
  // The bound that matters is the DATABASE's connection cap, not the app
  // droplet's CPU. Prod runs on a db-s-1vcpu-1gb managed Postgres whose hard
  // cap is ~22 usable connections, shared with the worker pool (and, on the
  // same instance, the preview/dev stacks). 40 here could demand ~2x what the
  // DB allows → connect() waits out connectionTimeoutMillis then 5xx. Keep the
  // API + worker + headroom under ~20. Add a DigitalOcean connection pool
  // (PgBouncer, transaction mode) in front and this can rise again. Env
  // override always wins.
  const tierDefault = appConfig.tier === 'prod' ? 16 : 20
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
// Close pg backends that have sat idle for this long. Without it the
// API holds onto every managed-Postgres connection it ever opened, and
// DO bills connection-hours on managed instances. 30s default closes
// truly idle conns; reconnects are cheap.
const pgIdleTimeoutMs = (() => {
  const n = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
})()

// HTTP-level timeouts. Without these, Node's plain `http` module will let a
// stalled client (or a wedged downstream call that ignores the pg query
// timeout) hold a socket open indefinitely, piling up requests until the
// process runs out of file descriptors. Defaults are deliberately wider than
// the pg query timeout (10s) so legitimate slow queries finish before the
// HTTP layer kills them. Keep-alive is short so load balancers / health
// probes don't park sockets unnecessarily on the API.
const httpRequestTimeoutMs = (() => {
  const n = Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 30_000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
})()
const httpHeadersTimeoutMs = (() => {
  const n = Number(process.env.HTTP_HEADERS_TIMEOUT_MS ?? 60_000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000
})()
const httpKeepAliveTimeoutMs = (() => {
  const n = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 5_000)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5_000
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
    idleTimeoutMillis: pgIdleTimeoutMs,
  }
}

function getPoolConfig(connectionString: string): PoolConfig {
  // TLS shape comes from @sitelayer/config: DATABASE_CA_CERT -> verified TLS
  // against the managed-PG CA bundle; DATABASE_SSL_REJECT_UNAUTHORIZED=false
  // -> legacy no-verify; default -> pass through (pg owns sslmode).
  const { connectionString: resolvedConnectionString, ssl } = resolveDatabasePoolSsl(connectionString)
  return withTierOptions(
    ssl ? { connectionString: resolvedConnectionString, ssl } : { connectionString: resolvedConnectionString },
  )
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
    perCompanyPerMin: rateLimitConfig.perCompanyPerMin,
    windowMs: rateLimitConfig.windowMs,
  },
  '[rate-limit] configured',
)

// Scale-hygiene: company self-creation is platform-admin-only by default.
// `ALLOW_OPEN_COMPANY_SIGNUP=1` re-opens the historical self-serve pilot flow.
const companyCreateGateConfig = loadCompanyCreateGateConfig(process.env)
logger.info({ allowOpenSignup: companyCreateGateConfig.allowOpenSignup }, '[company-create] gate configured')
logger.info(
  {
    pgPoolMax,
    pgStatementTimeoutMs,
    pgQueryTimeoutMs,
    pgHealthProbeTimeoutMs,
    pgIdleTimeoutMs,
  },
  '[pool] configured',
)
logger.info(
  {
    httpRequestTimeoutMs,
    httpHeadersTimeoutMs,
    httpKeepAliveTimeoutMs,
  },
  '[http] timeouts configured',
)

// HTTP-layer idempotency cache. See apps/api/src/idempotency.ts for the
// rationale; pilot is single-process so an in-memory Map suffices.
const idempotencyCache = createIdempotencyCache()

function getCorsOrigin(req: http.IncomingMessage): string {
  return getCorsOriginImpl(req, allowedOrigins)
}

type CompanyRow = {
  id: string
  slug: string
  name: string
  created_at: string
}

/**
 * Company resolution + the caller's resolved named-action authority.
 *
 * The custom-roles overhaul (docs/RBAC_OVERHAUL_ANALYSIS.md,
 * packages/domain/src/permissions.ts) is two-layer:
 *
 *  - LAYER 1 (the long tail, ~260 `requireRole` sites): `active.role` already
 *    carries the EFFECTIVE company role — for a member with a custom role that
 *    is `builtinToCompanyRole(custom_role.inherit_from)`; for a plain member it
 *    round-trips to exactly `normalizeCompanyRole(raw)` (zero behaviour change).
 *    The existing `requireRole` closure reads `active.role` and gates the long
 *    tail with no per-site edit.
 *
 *  - LAYER 2 (the 9 named actions): `effectiveBuiltin` + `grants` feed
 *    `requirePermission`/`resolveEffectivePermissions` at the specific action
 *    routes, where the matrix is authoritative (e.g. office demotes to
 *    estimator, auth_materials is Owner-only by default) and custom grants +
 *    the $-cap apply. Not yet called from any route (next phase).
 */
type ResolvedCompany = {
  active: ActiveCompany
  effectiveBuiltin: BuiltinRole
  grants: PermissionGrant[]
}

type CustomRoleRow = { inherit_from: string }
type CustomRoleGrantRow = { action: string; constraints: Record<string, unknown> | null }

/**
 * Load a custom role's base + additive grants. Returns null when the linked
 * role is missing or soft-deleted (member falls back to its raw company role).
 * Both reads are company-scoped; the bare pool leaves the RLS GUC unset so the
 * `app_current_company_id() IS NULL` branch of the tenant policy is permissive.
 */
async function loadCustomRole(companyId: string, customRoleId: string): Promise<CustomRoleAuthority | null> {
  const roleResult = await pool.query<CustomRoleRow>(
    `select inherit_from from custom_roles
      where id = $1 and company_id = $2 and deleted_at is null
      limit 1`,
    [customRoleId, companyId],
  )
  const inheritFrom = roleResult.rows[0]?.inherit_from
  // inherit_from is CHECK-constrained to the five built-in bases in migration
  // 136, so this cast is sound for any live row.
  if (!inheritFrom) return null
  const effectiveBuiltin = inheritFrom as BuiltinRole

  const grantResult = await pool.query<CustomRoleGrantRow>(
    `select action, constraints from custom_role_grants
      where custom_role_id = $1 and company_id = $2`,
    [customRoleId, companyId],
  )
  const grants: PermissionGrant[] = grantResult.rows.map((row) => ({
    action: row.action as PermissionAction,
    // resolveEffectivePermissions ignores grants whose action isn't a real
    // PERMISSION_ACTION, so an unknown action row is inert (not a throw).
    constraints: normalizeGrantConstraints(row.constraints),
  }))
  return { effectiveBuiltin, grants }
}

async function getCompany(
  req?: http.IncomingMessage,
  opts: { membershipBypassRole?: CompanyRole } = {},
): Promise<ResolvedCompany | null> {
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

  if (opts.membershipBypassRole) {
    const role = opts.membershipBypassRole
    return {
      active: {
        id: companyRow.id,
        slug: companyRow.slug,
        name: companyRow.name,
        created_at: companyRow.created_at,
        role,
      },
      effectiveBuiltin: companyRoleToBuiltin(role),
      grants: [],
    }
  }

  // Verify membership and surface the role so handlers can enforce RBAC
  // without re-querying. Also read custom_role_id (migration 136): when set,
  // the member's effective authority comes from the custom role's base +
  // grants instead of the raw company role. See `requireRole()` /
  // `requirePermission()` and the ResolvedCompany doc above.
  const userId = getCurrentUserId(req)
  const membership = await pool.query<{ role: string; custom_role_id: string | null }>(
    'select role, custom_role_id from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
    [companyRow.id, userId],
  )
  if (!membership.rows.length) return null

  const rawRole = normalizeCompanyRole(membership.rows[0]?.role)
  const customRoleId = membership.rows[0]?.custom_role_id ?? null

  // A custom_role_id that points at a missing/soft-deleted role resolves to
  // null here, so the member transparently falls back to its raw company role.
  const custom = customRoleId ? await loadCustomRole(companyRow.id, customRoleId) : null
  const { effectiveRole, effectiveBuiltin, grants } = resolveCompanyRoleAuthority(rawRole, custom)

  return {
    active: {
      id: companyRow.id,
      slug: companyRow.slug,
      name: companyRow.name,
      created_at: companyRow.created_at,
      role: effectiveRole,
    },
    effectiveBuiltin,
    grants,
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

/**
 * LAYER 2 of the RBAC overhaul — enforce one of the 9 named permission actions
 * (PERMISSION_ACTIONS) against the caller's EFFECTIVE authority. Returns `true`
 * when the action is held (and, for a constrainable action with a magnitude
 * supplied, within cap); returns `false` after sending a 403, in which case the
 * caller should `return`.
 *
 * The matrix (resolveEffectivePermissions(effectiveBuiltin, grants)) is
 * authoritative here — this is where Foreman loses edit_pricing_book,
 * auth_materials is Owner-only by default, office demotes to estimator, and
 * custom-role grants + the auth_materials $-cap apply. NOT yet called from any
 * route; wired once below at the dispatch boundary for the next phase.
 *
 * `opts.amountCents` / `opts.otHours` carry the per-request magnitude for a
 * constrainable action (auth_materials → max_amount_cents [enforced];
 * approve_time → max_ot_hours_per_week [stored but INERT in v1]). When the
 * action is constrainable and a magnitude is supplied, an over-cap caller is
 * 403'd with the cap surfaced.
 */
function requirePermission(
  res: http.ServerResponse,
  effectiveBuiltin: BuiltinRole,
  grants: readonly PermissionGrant[],
  action: PermissionAction,
  opts: { amountCents?: number; otHours?: number } = {},
  req?: http.IncomingMessage,
): boolean {
  const verdict = permissionDecision(effectiveBuiltin, grants, action, opts)
  if (verdict.outcome === 'denied') {
    sendJson(res, 403, { error: 'forbidden: permission not granted', action, role: effectiveBuiltin }, req)
    return false
  }
  if (verdict.outcome === 'over_cap') {
    sendJson(res, 403, { error: 'forbidden: over permission cap', action, cap: verdict.cap }, req)
    return false
  }
  return true
}

function getHeaderValue(req: http.IncomingMessage | undefined, key: string): string | null {
  const value = req?.headers[key]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getCurrentUserId(req?: http.IncomingMessage): string {
  // Dev-only `x-sitelayer-act-as` override wins over every other path so
  // the RoleSwitcher panel in `apps/web` (Clerk-not-configured mode) can
  // flip identities without touching `ACTIVE_USER_ID`. `resolveActAsOverride`
  // returns null in prod — never accept the header there.
  const actAs = resolveActAsOverride(req, appConfig.tier, (msg, ctx) => logger.warn(ctx, msg))
  if (actAs) return actAs
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
  // Surface the build sha on every response so the SPA Probe can read it
  // without a `/api/version` round-trip. setHeader queues this on the
  // response; Node merges queued headers with anything later writeHead
  // calls add (and writeHead never sets x-sitelayer-build-sha itself), so
  // the header travels for /health, /api/*, OPTIONS preflights, the
  // streaming PDF/file paths, the metrics text response, and webhook
  // 204s alike. The corresponding `access-control-expose-headers` entry
  // lives in http-utils.ts:CORS_EXPOSE_HEADERS so the cross-origin SPA
  // can actually read the value.
  res.setHeader('x-sitelayer-build-sha', buildSha)
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
  const captureSessionHeader =
    typeof req.headers['x-sitelayer-capture-session-id'] === 'string'
      ? req.headers['x-sitelayer-capture-session-id'].trim()
      : ''
  const captureSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    captureSessionHeader,
  )
    ? captureSessionHeader
    : undefined
  const requestContext: RequestContext = {
    requestId,
    route: initialRoute,
    method,
    ...(companySlugHeader ? { companySlug: companySlugHeader } : {}),
    ...(userIdHeader ? { userId: userIdHeader } : {}),
    ...(captureSessionId ? { captureSessionId } : {}),
  }
  res.on('finish', () => {
    observeRequest(method, requestContext.route ?? initialRoute, res.statusCode || 0, Date.now() - requestStartedAt)
  })

  // Continue the upstream trace if the client supplied `sentry-trace` +
  // `baggage` headers. Done BEFORE the isolation scope so the scope, the
  // root span, and every captureException downstream inherit the upstream
  // trace_id. Health/metrics probes bypass to keep them cheap and off the
  // trace timeline. See trace-ingress.ts for the rationale.
  const traceBypass = shouldBypassTraceContinuation(initialRoute)
  const traceWrapper = traceBypass
    ? <T>(fn: () => T): T => fn()
    : <T>(fn: () => T): T => continueRequestTrace(req.headers, fn)

  await traceWrapper(() =>
    runWithRequestContext(requestContext, () =>
      Sentry.withIsolationScope((scope) => {
        scope.setTag('request_id', requestId)
        scope.setTag('route', initialRoute)
        scope.setTag('method', method)
        if (companySlugHeader) scope.setTag('company_slug', companySlugHeader)
        if (captureSessionId) scope.setTag('capture_session_id', captureSessionId)
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
                features: {
                  flags: appConfig.flags,
                  ribbon: appConfig.ribbon,
                  // Live blueprint AI sheet-read availability (C1 follow-up).
                  // True when a REAL blueprint read is available — gemini
                  // (BLUEPRINT_VISION_MODE=gemini + GEMINI_API_KEY) OR anthropic
                  // (live + ANTHROPIC_API_KEY). The SPA only streams a multipart
                  // PDF for a real read when this is true, otherwise it stays on
                  // the dry-run/demo path. Previously this only saw the anthropic
                  // path, so the gemini path was live in the backend but hidden
                  // in the UI.
                  blueprintVisionLive: resolveBlueprintVisionProvider() !== 'dry-run',
                  // In-app operator AI chat availability — single gate in
                  // mesh-dispatcher.ts. Unset MESH_API_URL (no mesh access)
                  // ⇒ false ⇒ the operator-context chat widget hides its
                  // composer instead of staging messages that hang.
                  aiChatEnabled: isAiChatEnabled(),
                },
                getCorsOrigin: () => getCorsOrigin(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                readRawBody: () => readRawBody(req),
              })
              if (publicHandled) return

              // Same-origin @operator/projectkit ingest proxy (POST /api/signal).
              // TELEMETRY only — the browser beacon posts a ProjectEventEnvelope
              // here; this validates against the contract and forwards to the
              // configured subscriber (SIGNAL_SINK_URL). Pre-auth: the public
              // beacon carries no Bearer. Inert (204) when SIGNAL_SINK_URL unset.
              const signalHandled = await handleSignalRoutes(req, url, {
                res,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
                getCorsOrigin: () => getCorsOrigin(req),
              })
              if (signalHandled) return

              // Agent feed — the producer-side @operator/projectkit pull-executor
              // feed (capture-analyzer + Steve's Claude Code poll Concerns and
              // POST Callbacks). MACHINE auth boundary: AGENT_FEED_TOKENS bearer
              // map (constant-time, audience-scoped), NOT Clerk — so it mounts
              // pre-identity like the portal/webhook surfaces. All routes 503
              // when AGENT_FEED_TOKENS is unset (feed off, fail loud not open).
              const agentFeedHandled = await handleAgentFeedRoutes(req, url, {
                pool,
                storage,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
                sendFileContent: (mimeType, fileName, content) => {
                  res.writeHead(200, {
                    'content-type': mimeType,
                    'content-disposition': `inline; filename="${fileName}"`,
                    'cache-control': 'no-store',
                  })
                  res.end(content)
                },
              })
              if (agentFeedHandled) return

              // Public client-portal routes (sales loop + rentals catalog). No
              // Clerk auth — recipients hold an HMAC-signed share token. Handled
              // BEFORE identity resolution so customers without a Clerk session
              // can land on /portal/estimates/:token and /portal/rentals/:token.
              const portalEstimateHandled = await handlePublicEstimateShareRoutes(req, url, {
                pool,
                shareSecret: estimateShareSecret,
                storage,
                maxArtifactBytes: Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
                tier: appConfig.tier,
                buildSha,
                resolveClientIp: () => {
                  const xff = req.headers['x-forwarded-for']
                  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim()
                  if (Array.isArray(xff) && xff.length > 0) return xff[0]!.split(',')[0]!.trim()
                  return req.socket.remoteAddress ?? null
                },
                // Per-share-token bucket for the rate-limit-exempt /api/portal/*
                // surface — caps accept/decline/finalize spam against one token
                // without locking out a NAT-shared single customer.
                rateLimitPortalToken: (token, kind) => enforcePortalTokenRateLimit(rateLimiter, token, kind),
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
              if (portalEstimateHandled) return

              const portalRentalHandled = await handlePortalRentalRoutes(req, url, {
                pool,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
                storage,
                maxArtifactBytes: Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
                tier: appConfig.tier,
                buildSha,
                // Same per-share-token bucket as the estimate portal above.
                rateLimitPortalToken: (token, kind) => enforcePortalTokenRateLimit(rateLimiter, token, kind),
              })
              if (portalRentalHandled) return

              const publicPortalHandled = await handlePublicPortalRoutes(req, url, {
                pool,
                sendJson: (status, body) => sendJson(res, status, body, req),
              })
              if (publicPortalHandled) return

              if (url.pathname.startsWith('/api/portal/feedback-invites/')) {
                const feedbackInvitePublicHandled = await handleFeedbackInviteRoutes(req, url, {
                  pool,
                  userId: 'anonymous-feedback-invite',
                  identitySource: 'default',
                  isAnonymous: true,
                  feedbackInviteSecret,
                  portalBaseUrl,
                  sendJson: (status, body) => sendJson(res, status, body, req),
                  readBody: () => readBody(req),
                })
                if (feedbackInvitePublicHandled) return
              }

              // Demo-tier magic-link sign-in. Structurally inert (returns
              // false → keeps walking → 404) unless APP_TIER=demo. Handled
              // pre-auth because the caller is signed-out and is asking for a
              // Clerk sign-in ticket. See routes/demo.ts.
              const demoHandled = await handleDemoRoutes(req, url, {
                tier: appConfig.tier,
                accessCode: demoAccessCode,
                appOrigin: demoAppOrigin,
                ticketTtlSeconds: demoTicketTtlSeconds,
                mintSignInToken: demoSignInTokenMinter,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
                setNoIndexHeader: () => res.setHeader('x-robots-tag', 'noindex, nofollow'),
              })
              if (demoHandled) return

              const PUBLIC_PATHS = new Set([
                '/api/integrations/qbo/callback',
                '/api/webhooks/clerk',
                '/api/webhooks/qbo',
              ])
              const workRequestCallbackWorkItemId = matchWorkRequestCallbackWorkItemId(req.method, url.pathname)
              const isWorkRequestCallback = workRequestCallbackWorkItemId !== null
              // The QBO OAuth callback is public and SELF-RESOLVES its tenant
              // from the HMAC-signed `state` param inside routes/qbo.ts
              // (decodeQboState verifies the QBO_STATE_SECRET signature, then
              // re-checks the user is a member of stateData.companyId). The
              // synthetic `qbo-oauth-redirect` identity is a member of no
              // company, so getCompany() returns null below — which would 404
              // the request at the company gate BEFORE qbo.ts ever runs. Mirror
              // the isWorkRequestCallback precedent: mark the callback so the
              // gate hands it a placeholder ActiveCompany and lets qbo.ts do the
              // real (signed-state) authorization. ctx.company is never read on
              // the callback path — only stateData.companyId is.
              const isQboCallback = req.method === 'GET' && url.pathname === '/api/integrations/qbo/callback'
              const isPublicPath = PUBLIC_PATHS.has(url.pathname) || isWorkRequestCallback
              let identity: Identity
              try {
                identity = isPublicPath
                  ? {
                      userId: isWorkRequestCallback ? 'work-request-agent-callback' : 'qbo-oauth-redirect',
                      source: 'default',
                    }
                  : resolveIdentity(req, authConfig)
              } catch (err) {
                if (err instanceof AuthError) {
                  if (err.status === 401) {
                    res.setHeader('www-authenticate', 'Bearer realm="sitelayer"')
                  }
                  sendJson(res, err.status, { error: err.message, request_id: requestId })
                  return
                }
                // Defense in depth: identity resolution must FAIL CLOSED. A
                // malformed credential that trips an unexpected throw in the
                // auth chain (e.g. a future unguarded decode/parse) is a 401
                // reject, never a 500 — a bad credential never becomes a server
                // error, and it never bypasses auth. The real root-cause fix is
                // in auth.ts (decodeJwtSegment now throws AuthError); this is
                // the backstop so any other surprise can't leak a 500 either.
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err), request_id: requestId },
                  '[auth] non-AuthError during identity resolution; treating as 401',
                )
                res.setHeader('www-authenticate', 'Bearer realm="sitelayer"')
                sendJson(res, 401, { error: 'authentication failed', request_id: requestId })
                return
              }
              requestContext.actorUserId = identity.userId
              // Impersonation: a Clerk actor-token session carries the real admin
              // in identity.actorUserId. Stamp it on the request context so
              // recordAudit() auto-tags impersonated_by on every audited mutation
              // this session makes — no per-route change needed.
              if (identity.actorUserId) {
                requestContext.impersonatedBy = identity.actorUserId
                scope.setTag('impersonated_by', identity.actorUserId)
                scope.setTag('auth_mode', identity.mode ?? 'impersonate')
              }
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

              const adminWorkRequestsHandled = await handleAdminWorkRequestRoutes(req, url, {
                pool,
                identity,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
              })
              if (adminWorkRequestsHandled) return

              const platformAdminHandled = await dispatchPlatformAdminRoutes({
                req,
                url,
                pool,
                identity,
                tier: appConfig.tier,
                sendJson: (status, body) => sendJson(res, status, body, req),
                readBody: () => readBody(req),
              })
              if (platformAdminHandled) return

              // Company routes (GET/POST /api/companies,
              // POST /api/companies/:id/memberships) handled by the extracted
              // route module. See routes/companies.ts.
              if (
                await handleCompanyRoutes(req, url, {
                  pool,
                  // Act-as-aware identity (matches how getCompany resolves the
                  // user above): under the dev `x-sitelayer-act-as` bypass the
                  // company-settings role checks must read the impersonated
                  // user's membership, not the raw Clerk/default identity.
                  // `getCurrentUserId` returns the override only when
                  // tier !== 'prod', so the prod path is unchanged.
                  userId: getCurrentUserId(req),
                  // Company-creation gate (scale hygiene). Uses the RAW
                  // (pre-act-as) identity — the platform-admin trust boundary
                  // is only reachable via a verified Clerk session, never via
                  // the dev act-as / header / default paths, exactly like
                  // /api/admin/*.
                  createGate: { identity, config: companyCreateGateConfig },
                  sendJson: (status, body) => sendJson(res, status, body, req),
                  readBody: () => readBody(req),
                })
              ) {
                return
              }

              // Teammate invite + accept. Mounted AFTER resolveIdentity but
              // BEFORE getCompany() so create/list/revoke self-resolve the
              // company from the :id path param (no active-company header
              // needed) and accept works for a user who isn't a member of the
              // target company yet. The public GET /api/invites/:token view is
              // reachable by signed-out callers. See routes/invites.ts.
              if (
                await handleInviteRoutes(req, url, {
                  pool,
                  userId: getCurrentUserId(req),
                  identitySource: identity.source,
                  // Anonymous = the default identity with no act-as override.
                  // In dev act-as the source is still 'default' but
                  // getCurrentUserId returns a concrete dev id, so compare the
                  // two: equal → no override → genuinely anonymous.
                  isAnonymous: identity.source === 'default' && getCurrentUserId(req) === identity.userId,
                  tier: appConfig.tier,
                  sendJson: (status, body) => sendJson(res, status, body, req),
                  readBody: () => readBody(req),
                })
              ) {
                return
              }

              if (
                await handleFeedbackInviteRoutes(req, url, {
                  pool,
                  userId: getCurrentUserId(req),
                  identitySource: identity.source,
                  isAnonymous: identity.source === 'default' && getCurrentUserId(req) === identity.userId,
                  feedbackInviteSecret,
                  portalBaseUrl,
                  sendJson: (status, body) => sendJson(res, status, body, req),
                  readBody: () => readBody(req),
                })
              ) {
                return
              }

              // `company` is a ResolvedCompany: the ActiveCompany (with the
              // EFFECTIVE long-tail role) plus the named-action authority
              // (effectiveBuiltin + grants) for the LAYER 2 overlay. The
              // work-request-callback path has no membership row, so it carries
              // the admin base with no grants (same authority as its
              // hard-coded admin role).
              let company: ResolvedCompany | null =
                workRequestCallbackWorkItemId !== null
                  ? await (async () => {
                      const active = await resolveWorkRequestCallbackCompany(pool, workRequestCallbackWorkItemId)
                      return active ? { active, effectiveBuiltin: companyRoleToBuiltin(active.role), grants: [] } : null
                    })()
                  : isQboCallback
                    ? // Placeholder so the company gate doesn't 404 the public,
                      // self-resolving QBO callback (see isQboCallback above).
                      // qbo.ts ignores ctx.company on the callback path and binds
                      // the tenant from the HMAC-signed state instead; this
                      // ActiveCompany only exists to satisfy the dispatch ctx
                      // shape. It is NOT a real tenant — no real company id is
                      // bound, so no tenant data is reachable through it.
                      {
                        active: {
                          id: '00000000-0000-0000-0000-000000000000',
                          slug: 'qbo-oauth-callback',
                          name: 'QBO OAuth Callback',
                          created_at: '',
                          role: 'member' as CompanyRole,
                        },
                        effectiveBuiltin: companyRoleToBuiltin('member'),
                        grants: [],
                      }
                    : await getCompany(req)
              // First-user self-onboard. The Clerk webhook that mirrors
              // org membership into `company_memberships` isn't wired
              // (CLERK_WEBHOOK_SECRET unset) and ADR 0003 marks the install
              // as zero-customer, so the first authenticated user against
              // a company slug that has *no memberships at all* auto-claims
              // admin. After that the upsert no-ops — additional users must
              // be invited via POST /api/companies/:id/memberships, and the
              // role gate stays honest (otherwise every test fixture user
              // gets promoted to admin and the role-rejection tests fail).
              // Drop this block once the Clerk webhook ships.
              //
              // MULTI-TENANT: resolve the slug the REQUEST actually asked for
              // (`x-sitelayer-company-slug`, falling back to the dev default)
              // instead of the process-wide `activeCompanySlug` constant. With
              // the worker + product now multi-company, a request for company B
              // that auto-onboarded into `activeCompanySlug` (la-operations)
              // would (a) grant admin on the WRONG tenant and (b) still 404 on
              // company B with a misleading "la-operations not found" message.
              // `getCurrentCompanySlug` is the same resolver getCompany() uses,
              // so the membership lands on exactly the tenant getCompany() will
              // re-resolve. (The `x-sitelayer-company-id` path is handled inside
              // getCompany and never reaches here as a slug onboard.)
              const requestedCompanySlug = getCurrentCompanySlug(req)
              if (!company && !isPublicPath && requestedCompanySlug && identity.userId) {
                try {
                  await autoOnboardFirstAdmin(pool, {
                    resolvedCompanySlug: requestedCompanySlug,
                    userId: identity.userId,
                  })
                  company = await getCompany(req)
                } catch (err) {
                  logger.warn(
                    { err, route: url.pathname, slug: requestedCompanySlug, userId: identity.userId },
                    'auto-onboard membership insert failed',
                  )
                }
              }
              if (!company) {
                if (isWorkRequestCallback) {
                  sendJson(res, 404, { error: 'work request not found', user_id: identity.userId })
                  return
                }
                sendJson(res, 404, {
                  error: `company slug ${requestedCompanySlug} not found`,
                  user_id: identity.userId,
                })
                return
              }

              // Bind the resolved company id into the AsyncLocalStorage request
              // context. mutation-tx.ts reads this to `SET LOCAL app.company_id`
              // on every withMutationTx() and withCompanyClient() tx, which the
              // RLS policies created by migration 066 use to scope rows.
              //
              // EXCEPTION: the QBO callback's `company` is a placeholder (no
              // real tenant id — see the isQboCallback branch above). Binding
              // the all-zeros placeholder would `SET LOCAL app.company_id` to a
              // bogus id and make the company_isolation RLS WITH CHECK
              // (`company_id = app_current_company_id()`) REJECT the connection
              // INSERT that qbo.ts writes against the real `stateData.companyId`.
              // Leaving it unset keeps `app_current_company_id()` NULL, which
              // the policy's NULL branch allows; qbo.ts still scopes correctly
              // via its explicit `withCompanyClient(stateData.companyId, …)` and
              // `upsertIntegrationConnection(…, stateData.companyId, …)` calls.
              if (!isQboCallback) {
                requestContext.companyId = company.active.id
              }
              scope.setTag('company_id', company.active.id)

              // HTTP-layer idempotency. Resolve the Idempotency-Key header (if
              // present) and either short-circuit with the cached response or
              // wrap the dispatch `sendJson` to capture the first response for
              // future replays. See apps/api/src/idempotency.ts for the path
              // wire-list rationale.
              let idempotencyKey: string | null = null
              if (req.method === 'POST' && isIdempotentPostPath(url.pathname)) {
                const rawIdempotencyHeader = req.headers['idempotency-key']
                if (rawIdempotencyHeader !== undefined) {
                  const validated = validateIdempotencyKey(rawIdempotencyHeader)
                  if (!validated.ok) {
                    sendJson(res, 400, { error: validated.error, request_id: requestId })
                    return
                  }
                  idempotencyKey = validated.key
                  const cached = idempotencyCache.get(company.active.id, idempotencyKey)
                  if (cached) {
                    res.setHeader('idempotent-replay', 'true')
                    sendJson(res, cached.status, cached.body, req)
                    return
                  }
                }
              }
              const dispatchSendJson = (status: number, body: unknown): void => {
                if (idempotencyKey) {
                  const captured: IdempotencyCachedResponse = { status, body }
                  idempotencyCache.set(company.active.id, idempotencyKey, captured)
                }
                sendJson(res, status, body, req)
              }

              // Post-auth route cascade (system + entity routes + debug trace).
              // Order matches the pre-extraction inline cascade so behaviour is
              // preserved. See routes/dispatch.ts for the registry; route
              // modules in routes/* still own their own SQL, role gates, and
              // ledger writes — dispatch.ts only walks the list.
              const resolvedCompany = company
              const handled = await dispatch({
                req,
                res,
                url,
                pool,
                company: resolvedCompany.active,
                identity,
                tier: appConfig.tier,
                requestId,
                requireRole: (allowed) =>
                  requireRole(res, resolvedCompany.active, allowed as readonly CompanyRole[], req),
                // LAYER 2 named-action overlay. Closes over the request's
                // resolved effective base + custom-role grants. Not yet called
                // by any route — wired here next to requireRole so the next
                // phase can gate the 9 action routes. See requirePermission().
                requirePermission: (action, opts) =>
                  requirePermission(res, resolvedCompany.effectiveBuiltin, resolvedCompany.grants, action, opts, req),
                // Capability overlay for the two work-item domains (migration
                // 009). field_request.* resolves on the company boundary (role
                // defaults ∪ the custom_role_grants action names loaded into
                // resolvedCompany.grants); app_issue.* resolves on the platform
                // boundary using the RAW (pre-act-as) `identity` — so the
                // platform domain is unreachable via the dev act-as / header
                // fallback. Not yet called by any route. See capability.ts.
                requireCapability: (capability) => {
                  const capabilityCtx: CapabilityContext = {
                    role: resolvedCompany.active.role,
                    grantActions: resolvedCompany.grants.map((grant) => grant.action),
                    identity,
                    client: pool,
                    superadminEnvIds,
                    // Tier gates the LOCAL DEV app_issue.* relaxation in
                    // capability.ts (non-prod → dev/local identity = platform
                    // admin). In prod this is 'prod' so the boundary is
                    // unchanged (Clerk + superadmin only).
                    tier: appConfig.tier,
                  }
                  return requireCapabilityResolver(capabilityCtx, capability, dispatchSendJson)
                },
                // Caller's effective app_issue.* caps for /api/session — same
                // platform-boundary resolution over the RAW identity.
                resolveAppIssueCapabilities: () =>
                  resolveAppIssueCapabilitiesResolver({
                    role: resolvedCompany.active.role,
                    grantActions: resolvedCompany.grants.map((grant) => grant.action),
                    identity,
                    client: pool,
                    superadminEnvIds,
                    tier: appConfig.tier,
                  }),
                readBody: () => readBody(req),
                sendJson: dispatchSendJson,
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
                  environment: qboEnvironment,
                },
                estimateShareConfig: {
                  secret: estimateShareSecret,
                  portalBaseUrl: portalBaseUrl,
                },
                backfillCustomerMapping: (companyId, customer, executor) =>
                  backfillCustomerMapping(pool, companyId, customer, executor),
                listIntegrationMappings: (companyId, provider, entityType, pagination) =>
                  listIntegrationMappings(pool, companyId, provider, entityType, pagination),
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
              // Scope tags (route, request_id, company_id) are already set on
              // the Sentry isolation scope above; adding scope='unhandled' so
              // it shares the same captureWithEntityContext taxonomy as the
              // sub-handlers. We ALSO pass request_id + route + method
              // explicitly so the captured event keeps these dimensions
              // even if the isolation scope is somehow swapped (e.g. an
              // integration cleared the active scope before the catch
              // fired). Defensive: bare Sentry.captureException dropped
              // request_id in the 2026-05-16 verification audit, so we
              // belt-and-suspenders the load-bearing fields here. Entity
              // context (company_id / entity_id) intentionally NOT set —
              // the top-level catch may fire BEFORE getCompany() resolves
              // and inventing tags would be misleading.
              Sentry.captureException(error, {
                tags: {
                  scope: 'unhandled',
                  request_id: requestId,
                  route: requestContext.route ?? initialRoute,
                  method,
                },
              })
              const status =
                error instanceof HttpError ? error.status : error instanceof BlueprintUploadError ? error.status : 500
              if (rootSpan) {
                rootSpan.setStatus({ code: 2, message: error instanceof Error ? error.message : 'internal_error' })
              }
              // Surface intentional client-facing messages (HttpError /
              // BlueprintUploadError carry validation text); for any other
              // unhandled error (500) return a generic message so raw pg /
              // internal details — constraint names, columns, sometimes values
              // — don't leak to the client. Full detail stays in Sentry, keyed
              // by request_id.
              const clientError =
                error instanceof HttpError || error instanceof BlueprintUploadError
                  ? error.message
                  : 'internal server error'
              sendJson(res, status, {
                error: clientError,
                request_id: requestId,
              })
            }
          },
        )
      }),
    ),
  )
})

// HTTP-layer timeouts (see HTTP_REQUEST_TIMEOUT_MS etc. above). Applied
// after createServer so the values come from the same env-derived knobs
// the boot log reports. requestTimeout must be > pgQueryTimeout so a
// legitimately slow query isn't killed by the socket layer mid-flight.
server.requestTimeout = httpRequestTimeoutMs
server.headersTimeout = httpHeadersTimeoutMs
server.keepAliveTimeout = httpKeepAliveTimeoutMs

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

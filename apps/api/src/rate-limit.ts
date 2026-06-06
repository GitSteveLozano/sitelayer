/**
 * Per-user / per-IP token-bucket rate limiting for `/api/*`.
 *
 * Design constraints:
 * - In-memory only (single API replica today; revisit with shared cache once
 *   we run more than one node).
 * - Skips `/health` and `/api/webhooks/*` so platform probes and signed
 *   webhooks (Clerk, QBO) never get throttled.
 * - Authenticated requests are throttled by the JWT-resolved user id; anything
 *   without an identity falls back to the request IP (X-Forwarded-For first
 *   hop, then `req.socket.remoteAddress`).
 * - Returns `429` with a `Retry-After` header in seconds when the bucket is
 *   empty.
 *
 * The bucket model is the standard one:
 *   - capacity = N requests (per-user or per-IP, configurable)
 *   - refill rate = capacity / windowMs
 *   - on every request we refill linearly with elapsed time, then deduct one
 *     token if available.
 */
import type http from 'node:http'

export type RateLimitConfig = {
  /** Token capacity (per minute) for authenticated users. */
  perUserPerMin: number
  /** Token capacity (per minute) for anonymous/IP-keyed callers. */
  perIpPerMin: number
  /**
   * Token capacity (per minute) for a whole company (tenant). A second,
   * independent bucket on top of the per-user one: it caps the AGGREGATE
   * request rate of a single tenant so one noisy company (many users, or a
   * runaway client) can't starve the shared API for every other tenant.
   * Sized HIGH relative to per-user so it only bites pathological tenants.
   */
  perCompanyPerMin: number
  /**
   * Token capacity (per minute) for READ hits on a single public-portal
   * share token. The `/api/portal/*` surface is rate-limit-EXEMPT from the
   * per-user/per-IP buckets above (a NAT-shared customer would otherwise
   * collide with internal API callers — see isRateLimitExempt), so the only
   * fairness lever left for that surface is a per-TOKEN bucket. Reads (GET
   * the portal view) are sized generously so a legitimate customer
   * refreshing the page is never throttled. Optional in the type so callers
   * that only build the user/ip/company buckets stay valid; `capacityFor`
   * falls back to the documented default when absent.
   */
  perPortalTokenReadPerMin?: number
  /**
   * Token capacity (per minute) for state-changing POSTs on a single
   * public-portal share token (accept / decline / finalize + the capture
   * lifecycle). Sized tight: a real customer accepts/declines once and
   * finalizes a handful of capture sessions, so a low cap still leaves
   * single-customer use working while bounding a flood of forged-body POSTs
   * against one leaked token.
   */
  perPortalTokenWritePerMin?: number
  /** Window length in milliseconds. Refill rate = capacity / windowMs. */
  windowMs: number
}

// Per-token portal caps. Reads are generous (a customer reloading the estimate
// view); writes are tight (accept/decline once, finalize a few capture
// sessions). Both are per single share token, so they never bleed across
// customers. Standalone consts so `capacityFor` / `loadRateLimitConfig` always
// have a concrete `number` fallback even though the config fields are optional.
export const DEFAULT_PORTAL_TOKEN_READ_PER_MIN = 60
export const DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN = 20

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perUserPerMin: 100,
  perIpPerMin: 30,
  // ~10x the per-user cap: a busy 10-seat tenant stays well under it, but a
  // single tenant flooding the API gets bounded before it can starve others.
  perCompanyPerMin: 1000,
  perPortalTokenReadPerMin: DEFAULT_PORTAL_TOKEN_READ_PER_MIN,
  perPortalTokenWritePerMin: DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN,
  windowMs: 60_000,
}

function clampPositiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    perUserPerMin: clampPositiveInt(
      env.RATE_LIMIT_PER_USER_PER_MIN ?? DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin,
      DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin,
    ),
    perIpPerMin: clampPositiveInt(
      env.RATE_LIMIT_PER_IP_PER_MIN ?? DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin,
      DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin,
    ),
    perCompanyPerMin: clampPositiveInt(
      env.RATE_LIMIT_PER_COMPANY_PER_MIN ?? DEFAULT_RATE_LIMIT_CONFIG.perCompanyPerMin,
      DEFAULT_RATE_LIMIT_CONFIG.perCompanyPerMin,
    ),
    perPortalTokenReadPerMin: clampPositiveInt(
      env.RATE_LIMIT_PER_PORTAL_TOKEN_READ_PER_MIN ?? DEFAULT_PORTAL_TOKEN_READ_PER_MIN,
      DEFAULT_PORTAL_TOKEN_READ_PER_MIN,
    ),
    perPortalTokenWritePerMin: clampPositiveInt(
      env.RATE_LIMIT_PER_PORTAL_TOKEN_WRITE_PER_MIN ?? DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN,
      DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN,
    ),
    windowMs: DEFAULT_RATE_LIMIT_CONFIG.windowMs,
  }
}

type Bucket = { tokens: number; updatedAt: number }

/**
 * Which keyed bucket a decision came from. `company` is the per-tenant cap;
 * `portal_read` / `portal_write` are the per-share-token public-portal caps
 * (the `/api/portal/*` surface is exempt from user/ip — see isRateLimitExempt).
 */
export type RateLimitScope = 'user' | 'ip' | 'company' | 'portal_read' | 'portal_write'

export type RateLimitResult =
  | { allowed: true; remaining: number; capacity: number }
  | { allowed: false; retryAfterSeconds: number; capacity: number }

export type RateLimitDecision = RateLimitResult & {
  /** Resolution that was used: which key, what scope. */
  scope: RateLimitScope
  key: string
}

export type RateLimiter = {
  /** Test a single bucket. Returns whether the call may proceed and how long to wait if not. */
  consume: (scope: RateLimitScope, key: string, now?: number) => RateLimitDecision
  /** Drop all in-memory state. Used by tests; not wired to an admin endpoint. */
  reset: () => void
}

export function createRateLimiter(config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG): RateLimiter {
  const buckets = new Map<string, Bucket>()
  let lastSweep = Date.now()

  // Evict buckets idle for a full window. After `windowMs` a bucket has
  // refilled to capacity, so it's indistinguishable from a fresh one — keeping
  // it only leaks memory. Without this the map grows one permanent entry per
  // distinct user/IP, and the IP key comes from a client-controllable
  // X-Forwarded-For (resolveRequestIp), so a caller rotating spoofed XFF values
  // can grow the heap without bound. Sweeping at most once per window keeps it
  // amortised O(1) per request.
  const sweep = (now: number) => {
    if (now - lastSweep < config.windowMs) return
    lastSweep = now
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt >= config.windowMs) buckets.delete(key)
    }
  }

  const capacityFor = (scope: RateLimitScope): number => {
    switch (scope) {
      case 'user':
        return config.perUserPerMin
      case 'company':
        return config.perCompanyPerMin
      case 'portal_read':
        return config.perPortalTokenReadPerMin ?? DEFAULT_PORTAL_TOKEN_READ_PER_MIN
      case 'portal_write':
        return config.perPortalTokenWritePerMin ?? DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN
      case 'ip':
        return config.perIpPerMin
    }
  }

  return {
    consume(scope, key, now = Date.now()) {
      sweep(now)
      const capacity = capacityFor(scope)
      const refillRatePerMs = capacity / config.windowMs
      const composite = `${scope}:${key}`
      const current = buckets.get(composite) ?? { tokens: capacity, updatedAt: now }
      const elapsed = Math.max(0, now - current.updatedAt)
      const refilled = Math.min(capacity, current.tokens + elapsed * refillRatePerMs)
      if (refilled < 1) {
        // Persist the partial-refilled bucket so the wait time keeps draining.
        buckets.set(composite, { tokens: refilled, updatedAt: now })
        const tokensNeeded = 1 - refilled
        const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          capacity,
          scope,
          key,
        }
      }
      const tokensAfter = refilled - 1
      buckets.set(composite, { tokens: tokensAfter, updatedAt: now })
      return { allowed: true, remaining: Math.floor(tokensAfter), capacity, scope, key }
    },
    reset() {
      buckets.clear()
    },
  }
}

/** Routes that should never be rate-limited. */
export function isRateLimitExempt(pathname: string): boolean {
  if (pathname === '/health' || pathname.startsWith('/health')) return true
  if (pathname.startsWith('/api/webhooks/')) return true
  // OAuth callbacks redirect from third-party providers and must succeed in
  // a single shot. Per-IP throttling can't tell a legit redirect from abuse,
  // so we exempt them. /api/integrations/<provider>/callback.
  if (/^\/api\/integrations\/[^/]+\/callback$/.test(pathname)) return true
  // Public client portals (signed-token-protected). The auth boundary is the
  // HMAC-verified share_token in the URL itself. Not rate-limit-exempt for
  // bandwidth — a separate per-IP limiter should be added inline if abuse
  // becomes an issue, but the global per-user/per-IP `/api/*` bucket would
  // accidentally lock out a legitimate customer who shares a NAT with API
  // callers. Path is /api/portal/* so Caddy proxies it to the API container
  // (Caddyfile only routes /api/* and /health to the API).
  if (pathname.startsWith('/api/portal/')) return true
  return false
}

/**
 * Resolve the request IP from `X-Forwarded-For` (first hop) with a fallback to
 * `req.socket.remoteAddress`. Returns 'unknown' when neither is present so we
 * still produce a (single-bucket) limit instead of skipping the check.
 */
export function resolveRequestIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  const xffStr = Array.isArray(xff) ? xff[0] : xff
  if (xffStr) {
    const first = xffStr.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export type EnforceArgs = {
  req: http.IncomingMessage
  pathname: string
  /** Resolved authenticated user id (from JWT/getRequestContext). Null for anon. */
  userId: string | null
  /**
   * Resolved company/tenant key (slug or id), from the same place auth reads it
   * (`x-sitelayer-company-slug` / the active company). Null/absent skips the
   * per-company bucket — e.g. signed-out callers or routes with no tenant.
   */
  companyKey?: string | null
}

export type RateLimitRejection = Extract<RateLimitDecision, { allowed: false }>

/**
 * Resolve the tenant key for the per-company bucket from the same header auth
 * uses (`x-sitelayer-company-slug`). Returns null when absent so the company
 * bucket is simply skipped (no synthetic "unknown" tenant pooling every
 * headerless caller into one shared bucket).
 */
export function resolveCompanyKey(req: http.IncomingMessage): string | null {
  const raw = req.headers['x-sitelayer-company-slug']
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Decide whether to allow the request. Returns null when allowed; returns the
 * 429 metadata to write when blocked. The handler is responsible for actually
 * formatting the response — we keep the limiter pure so tests don't drag in
 * an HTTP server.
 *
 * Two INDEPENDENT buckets must both pass:
 *   1. the per-COMPANY bucket (when a tenant key is present) — the tenant-level
 *      fairness cap, checked FIRST so a noisy tenant is throttled regardless of
 *      which user/IP it hammers from.
 *   2. the per-user bucket (authenticated) OR the per-IP bucket (anonymous).
 */
export function enforceRateLimit(limiter: RateLimiter, args: EnforceArgs): RateLimitRejection | null {
  if (isRateLimitExempt(args.pathname)) return null
  const companyKey = args.companyKey?.trim()
  if (companyKey) {
    const companyDecision = limiter.consume('company', companyKey)
    if (!companyDecision.allowed) return companyDecision
  }
  if (args.userId) {
    const decision = limiter.consume('user', args.userId)
    return decision.allowed ? null : decision
  }
  const ip = resolveRequestIp(args.req)
  const decision = limiter.consume('ip', ip)
  return decision.allowed ? null : decision
}

/**
 * Express-style middleware wrapper. The Sitelayer API isn't on Express, but we
 * still expose this small wrapper so future routing code (or tests) can hand a
 * single function to `server.use(...)`-shaped frameworks.
 *
 * Returns `true` if the request was rejected (caller should bail), `false` if
 * the caller should continue handling.
 */
export function applyRateLimit(
  limiter: RateLimiter,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  userId: string | null,
): boolean {
  const decision = enforceRateLimit(limiter, {
    req,
    pathname,
    userId,
    companyKey: resolveCompanyKey(req),
  })
  if (!decision) return false
  res.setHeader('retry-after', String(decision.retryAfterSeconds))
  res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify(
      {
        error: 'rate limit exceeded',
        scope: decision.scope,
        retry_after_seconds: decision.retryAfterSeconds,
      },
      null,
      2,
    ),
  )
  return true
}

/**
 * Which class of portal hit is being limited. READ = the customer fetching the
 * portal view (generous cap); WRITE = a state-changing POST (accept/decline/
 * finalize + capture lifecycle — tight cap). They are independent buckets, so a
 * WRITE flood never throttles the customer's own reads.
 */
export type PortalRateLimitKind = 'read' | 'write'

/**
 * Per-share-token rate limit for the public `/api/portal/*` surface, which is
 * EXEMPT from the per-user/per-IP buckets (a NAT-shared customer would collide
 * with internal callers — see isRateLimitExempt). The auth boundary on that
 * surface is the HMAC-signed token in the URL itself, so the token is the only
 * stable per-recipient key we have; we bucket on it (never logged, in-memory
 * only) so a single leaked/guessed token can't spam-flood accept/decline/
 * finalize while a legitimate single customer stays well under the cap.
 *
 * Returns null when allowed; the 429 rejection metadata when blocked. The
 * caller formats the response (kept pure so tests don't drag in an HTTP
 * server). An empty token is NOT limited here — the route's own token
 * validation already 4xx's it, and limiting "" would pool every malformed
 * request into one shared bucket.
 */
export function enforcePortalTokenRateLimit(
  limiter: RateLimiter,
  token: string,
  kind: PortalRateLimitKind,
): RateLimitRejection | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  const scope: RateLimitScope = kind === 'write' ? 'portal_write' : 'portal_read'
  const decision = limiter.consume(scope, trimmed)
  return decision.allowed ? null : decision
}

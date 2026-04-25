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
  /** Window length in milliseconds. Refill rate = capacity / windowMs. */
  windowMs: number
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perUserPerMin: 100,
  perIpPerMin: 30,
  windowMs: 60_000,
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const perUser = Number(env.RATE_LIMIT_PER_USER_PER_MIN ?? DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin)
  const perIp = Number(env.RATE_LIMIT_PER_IP_PER_MIN ?? DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin)
  return {
    perUserPerMin:
      Number.isFinite(perUser) && perUser > 0 ? Math.floor(perUser) : DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin,
    perIpPerMin: Number.isFinite(perIp) && perIp > 0 ? Math.floor(perIp) : DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin,
    windowMs: DEFAULT_RATE_LIMIT_CONFIG.windowMs,
  }
}

type Bucket = { tokens: number; updatedAt: number }

export type RateLimitResult =
  | { allowed: true; remaining: number; capacity: number }
  | { allowed: false; retryAfterSeconds: number; capacity: number }

export type RateLimitDecision = RateLimitResult & {
  /** Resolution that was used: which key, what scope. */
  scope: 'user' | 'ip'
  key: string
}

export type RateLimiter = {
  /** Test a single bucket. Returns whether the call may proceed and how long to wait if not. */
  consume: (scope: 'user' | 'ip', key: string, now?: number) => RateLimitDecision
  /** Drop all in-memory state. Used by tests; not wired to an admin endpoint. */
  reset: () => void
}

export function createRateLimiter(config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG): RateLimiter {
  const buckets = new Map<string, Bucket>()

  const capacityFor = (scope: 'user' | 'ip') => (scope === 'user' ? config.perUserPerMin : config.perIpPerMin)

  return {
    consume(scope, key, now = Date.now()) {
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
}

export type RateLimitRejection = Extract<RateLimitDecision, { allowed: false }>

/**
 * Decide whether to allow the request. Returns null when allowed; returns the
 * 429 metadata to write when blocked. The handler is responsible for actually
 * formatting the response — we keep the limiter pure so tests don't drag in
 * an HTTP server.
 */
export function enforceRateLimit(limiter: RateLimiter, args: EnforceArgs): RateLimitRejection | null {
  if (isRateLimitExempt(args.pathname)) return null
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
  const decision = enforceRateLimit(limiter, { req, pathname, userId })
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

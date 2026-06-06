import { describe, expect, it } from 'vitest'
import {
  applyRateLimit,
  createRateLimiter,
  enforcePortalTokenRateLimit,
  enforceRateLimit,
  isRateLimitExempt,
  loadRateLimitConfig,
  resolveCompanyKey,
  resolveRequestIp,
  DEFAULT_PORTAL_TOKEN_READ_PER_MIN,
  DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './rate-limit.js'
import type http from 'node:http'

function makeReq(opts: { ip?: string; xff?: string; companySlug?: string } = {}): http.IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.xff) headers['x-forwarded-for'] = opts.xff
  if (opts.companySlug) headers['x-sitelayer-company-slug'] = opts.companySlug
  return {
    headers,
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
  } as unknown as http.IncomingMessage
}

function makeRes() {
  const headers = new Map<string, string>()
  let statusCode = 0
  let body = ''
  return {
    headers,
    body: () => body,
    statusCode: () => statusCode,
    res: {
      setHeader: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value)
      },
      writeHead: (status: number) => {
        statusCode = status
      },
      end: (chunk: string) => {
        body = chunk
      },
    } as unknown as http.ServerResponse,
  }
}

describe('loadRateLimitConfig', () => {
  it('uses defaults when env vars are unset', () => {
    const cfg = loadRateLimitConfig({} as NodeJS.ProcessEnv)
    expect(cfg).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
  })

  it('honours RATE_LIMIT_PER_USER_PER_MIN, RATE_LIMIT_PER_IP_PER_MIN and RATE_LIMIT_PER_COMPANY_PER_MIN', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_USER_PER_MIN: '250',
      RATE_LIMIT_PER_IP_PER_MIN: '5',
      RATE_LIMIT_PER_COMPANY_PER_MIN: '4000',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perUserPerMin).toBe(250)
    expect(cfg.perIpPerMin).toBe(5)
    expect(cfg.perCompanyPerMin).toBe(4000)
    expect(cfg.windowMs).toBe(60_000)
  })

  it('falls back to defaults for non-numeric values', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_USER_PER_MIN: 'nope',
      RATE_LIMIT_PER_IP_PER_MIN: '-3',
      RATE_LIMIT_PER_COMPANY_PER_MIN: '0',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perUserPerMin).toBe(DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin)
    expect(cfg.perIpPerMin).toBe(DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin)
    expect(cfg.perCompanyPerMin).toBe(DEFAULT_RATE_LIMIT_CONFIG.perCompanyPerMin)
  })

  it('has a high per-company default relative to per-user (a busy tenant is not throttled)', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIG.perCompanyPerMin).toBeGreaterThan(DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin)
  })

  it('honours the per-portal-token read/write env overrides', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_PORTAL_TOKEN_READ_PER_MIN: '120',
      RATE_LIMIT_PER_PORTAL_TOKEN_WRITE_PER_MIN: '7',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perPortalTokenReadPerMin).toBe(120)
    expect(cfg.perPortalTokenWritePerMin).toBe(7)
  })

  it('falls back to the portal-token defaults for non-numeric values', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_PORTAL_TOKEN_READ_PER_MIN: 'nope',
      RATE_LIMIT_PER_PORTAL_TOKEN_WRITE_PER_MIN: '0',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perPortalTokenReadPerMin).toBe(DEFAULT_PORTAL_TOKEN_READ_PER_MIN)
    expect(cfg.perPortalTokenWritePerMin).toBe(DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN)
  })

  it('writes are tighter than reads (single-customer use stays well under the read cap)', () => {
    expect(DEFAULT_PORTAL_TOKEN_WRITE_PER_MIN).toBeLessThan(DEFAULT_PORTAL_TOKEN_READ_PER_MIN)
  })
})

describe('isRateLimitExempt', () => {
  it('exempts /health and /api/webhooks/*', () => {
    expect(isRateLimitExempt('/health')).toBe(true)
    expect(isRateLimitExempt('/health/db')).toBe(true)
    expect(isRateLimitExempt('/api/webhooks/clerk')).toBe(true)
    expect(isRateLimitExempt('/api/webhooks/qbo')).toBe(true)
  })

  it('does not exempt regular API routes', () => {
    expect(isRateLimitExempt('/api/projects')).toBe(false)
    expect(isRateLimitExempt('/api/sign-in/callback')).toBe(false)
    expect(isRateLimitExempt('/api/companies')).toBe(false)
  })

  it('exempts OAuth callbacks', () => {
    expect(isRateLimitExempt('/api/integrations/qbo/callback')).toBe(true)
    expect(isRateLimitExempt('/api/integrations/xero/callback')).toBe(true)
  })

  it('does not exempt nested OAuth-like paths', () => {
    expect(isRateLimitExempt('/api/integrations/qbo/callback/extra')).toBe(false)
    expect(isRateLimitExempt('/api/integrations/qbo/sync')).toBe(false)
  })
})

describe('resolveRequestIp', () => {
  it('prefers the first X-Forwarded-For hop', () => {
    const req = makeReq({ xff: '203.0.113.10, 10.0.0.1', ip: '127.0.0.1' })
    expect(resolveRequestIp(req)).toBe('203.0.113.10')
  })

  it('falls back to socket.remoteAddress when XFF is missing', () => {
    const req = makeReq({ ip: '198.51.100.7' })
    expect(resolveRequestIp(req)).toBe('198.51.100.7')
  })

  it('uses "unknown" when nothing identifies the caller', () => {
    const req = { headers: {}, socket: {} } as unknown as http.IncomingMessage
    expect(resolveRequestIp(req)).toBe('unknown')
  })
})

describe('resolveCompanyKey', () => {
  it('reads the trimmed x-sitelayer-company-slug header', () => {
    expect(resolveCompanyKey(makeReq({ companySlug: '  acme-co  ' }))).toBe('acme-co')
  })

  it('returns null when the header is absent (the per-company bucket is skipped)', () => {
    expect(resolveCompanyKey(makeReq())).toBeNull()
  })

  it('returns null for a blank/whitespace header', () => {
    expect(resolveCompanyKey(makeReq({ companySlug: '   ' }))).toBeNull()
  })

  it('takes the first value when the header arrives as an array', () => {
    const req = {
      headers: { 'x-sitelayer-company-slug': ['acme', 'globex'] },
      socket: {},
    } as unknown as http.IncomingMessage
    expect(resolveCompanyKey(req)).toBe('acme')
  })
})

describe('rate limiter token bucket', () => {
  it('fills to capacity, rejects with Retry-After once drained, then refills over the window', () => {
    const limiter = createRateLimiter({ perUserPerMin: 3, perIpPerMin: 30, perCompanyPerMin: 1000, windowMs: 60_000 })
    const t0 = 1_700_000_000_000

    // Three calls in the same instant should all pass.
    for (let i = 0; i < 3; i++) {
      const decision = limiter.consume('user', 'alice', t0)
      expect(decision.allowed).toBe(true)
    }

    // Fourth call at the same instant must be denied with a finite retry hint.
    const denied = limiter.consume('user', 'alice', t0)
    expect(denied.allowed).toBe(false)
    if (denied.allowed) throw new Error('expected denial')
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    // 3 tokens / 60s → one token per 20s, so retry should be ~20s.
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(20)

    // After the full window passes, the bucket is full again.
    const refillT = t0 + 60_000
    const refilled = limiter.consume('user', 'alice', refillT)
    expect(refilled.allowed).toBe(true)
  })

  it('keeps per-user, per-IP and per-company buckets independent', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 1, windowMs: 60_000 })
    const t0 = 1_700_000_000_000
    expect(limiter.consume('user', 'alice', t0).allowed).toBe(true)
    // user:alice exhausted, but ip:1.2.3.4 and company:acme untouched
    expect(limiter.consume('user', 'alice', t0).allowed).toBe(false)
    expect(limiter.consume('ip', '1.2.3.4', t0).allowed).toBe(true)
    expect(limiter.consume('ip', '1.2.3.4', t0).allowed).toBe(false)
    expect(limiter.consume('company', 'acme', t0).allowed).toBe(true)
    expect(limiter.consume('company', 'acme', t0).allowed).toBe(false)
  })

  it('uses the per-company capacity for the company scope', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 3, windowMs: 60_000 })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 3; i++) expect(limiter.consume('company', 'acme', t0).allowed).toBe(true)
    expect(limiter.consume('company', 'acme', t0).allowed).toBe(false)
  })

  it('refills proportionally over partial windows', () => {
    const limiter = createRateLimiter({ perUserPerMin: 6, perIpPerMin: 30, perCompanyPerMin: 1000, windowMs: 60_000 })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 6; i++) limiter.consume('user', 'bob', t0)
    expect(limiter.consume('user', 'bob', t0).allowed).toBe(false)
    // After 10 seconds, 1 token has refilled (6 tokens / 60s = 0.1/s).
    const partial = limiter.consume('user', 'bob', t0 + 10_000)
    expect(partial.allowed).toBe(true)
  })
})

describe('enforceRateLimit', () => {
  it('returns null for exempt paths regardless of identity', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 1000, windowMs: 60_000 })
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/health', userId: null })).toBeNull()
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/api/webhooks/clerk', userId: 'user_1' })).toBeNull()
  })

  it('keys authenticated requests by user even when IP varies', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 100, perCompanyPerMin: 1000, windowMs: 60_000 })
    const userId = 'user_123'
    expect(enforceRateLimit(limiter, { req: makeReq({ ip: '1.1.1.1' }), pathname: '/api/projects', userId })).toBeNull()
    const second = enforceRateLimit(limiter, {
      req: makeReq({ ip: '2.2.2.2' }),
      pathname: '/api/projects',
      userId,
    })
    expect(second).not.toBeNull()
    expect(second!.allowed).toBe(false)
    if (second!.allowed) throw new Error('expected denial')
    expect(second!.scope).toBe('user')
  })

  it('keys anonymous requests by IP', () => {
    const limiter = createRateLimiter({ perUserPerMin: 100, perIpPerMin: 1, perCompanyPerMin: 1000, windowMs: 60_000 })
    expect(
      enforceRateLimit(limiter, {
        req: makeReq({ xff: '203.0.113.5' }),
        pathname: '/api/sign-in/callback',
        userId: null,
      }),
    ).toBeNull()
    const second = enforceRateLimit(limiter, {
      req: makeReq({ xff: '203.0.113.5' }),
      pathname: '/api/sign-in/callback',
      userId: null,
    })
    expect(second).not.toBeNull()
    if (second!.allowed) throw new Error('expected denial')
    expect(second!.scope).toBe('ip')
    expect(second!.key).toBe('203.0.113.5')
  })

  it('throttles a noisy tenant via the per-company bucket (one tenant cannot starve another)', () => {
    // per-company cap of 2; per-user is generous so the company bucket is what bites.
    const limiter = createRateLimiter({ perUserPerMin: 100, perIpPerMin: 100, perCompanyPerMin: 2, windowMs: 60_000 })
    const req = makeReq()
    // Two different users in the SAME company drain the shared company bucket.
    expect(
      enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u1', companyKey: 'noisy-co' }),
    ).toBeNull()
    expect(
      enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u2', companyKey: 'noisy-co' }),
    ).toBeNull()
    // Third request from a THIRD user in the same company is blocked by the company bucket.
    const blocked = enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u3', companyKey: 'noisy-co' })
    expect(blocked).not.toBeNull()
    if (blocked!.allowed) throw new Error('expected denial')
    expect(blocked!.scope).toBe('company')
    expect(blocked!.key).toBe('noisy-co')
    // A user in a DIFFERENT company is unaffected — the whole point of the bucket.
    expect(
      enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u9', companyKey: 'quiet-co' }),
    ).toBeNull()
  })

  it('checks the company bucket BEFORE the per-user bucket', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 100, perCompanyPerMin: 1, windowMs: 60_000 })
    const req = makeReq()
    expect(enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u1', companyKey: 'acme' })).toBeNull()
    // A different user in the same company: their per-user bucket is full, but
    // the company bucket is drained, so the company scope wins the rejection.
    const blocked = enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u2', companyKey: 'acme' })
    if (!blocked || blocked.allowed) throw new Error('expected company denial')
    expect(blocked.scope).toBe('company')
  })

  it('skips the company bucket when no company key is present (anonymous/headerless)', () => {
    const limiter = createRateLimiter({ perUserPerMin: 100, perIpPerMin: 100, perCompanyPerMin: 1, windowMs: 60_000 })
    // No company key → company bucket untouched, so a second call still passes.
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/api/projects', userId: 'u1' })).toBeNull()
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/api/projects', userId: 'u2' })).toBeNull()
  })

  it('still exempts the same routes as before even when a company key is present', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 1, windowMs: 60_000 })
    const req = makeReq()
    // /api/webhooks/*, /health and /api/portal/* are exempt — the company bucket must not be consumed.
    expect(
      enforceRateLimit(limiter, { req, pathname: '/api/webhooks/clerk', userId: 'u1', companyKey: 'acme' }),
    ).toBeNull()
    expect(enforceRateLimit(limiter, { req, pathname: '/health', userId: null, companyKey: 'acme' })).toBeNull()
    expect(enforceRateLimit(limiter, { req, pathname: '/api/portal/abc', userId: null, companyKey: 'acme' })).toBeNull()
    // The company bucket (capacity 1) was never touched, so a real API call still passes.
    expect(enforceRateLimit(limiter, { req, pathname: '/api/projects', userId: 'u1', companyKey: 'acme' })).toBeNull()
  })
})

describe('applyRateLimit', () => {
  it('writes a 429 with Retry-After header and JSON body when rejected', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 1000, windowMs: 60_000 })
    const responder = makeRes()
    expect(applyRateLimit(limiter, makeReq(), responder.res, '/api/projects', 'user_1')).toBe(false)
    const blocked = applyRateLimit(limiter, makeReq(), responder.res, '/api/projects', 'user_1')
    expect(blocked).toBe(true)
    expect(responder.statusCode()).toBe(429)
    expect(responder.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = JSON.parse(responder.body())
    expect(body.error).toBe('rate limit exceeded')
    expect(body.scope).toBe('user')
    expect(body.retry_after_seconds).toBeGreaterThan(0)
  })

  it('returns false for exempt paths without writing to the response', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, perCompanyPerMin: 1000, windowMs: 60_000 })
    const responder = makeRes()
    expect(applyRateLimit(limiter, makeReq(), responder.res, '/health', null)).toBe(false)
    expect(responder.statusCode()).toBe(0)
    expect(responder.body()).toBe('')
  })

  it('emits a 429 with scope:"company" when the per-company bucket is exhausted', () => {
    // Company cap of 1, generous per-user — the company bucket bites first.
    const limiter = createRateLimiter({ perUserPerMin: 100, perIpPerMin: 100, perCompanyPerMin: 1, windowMs: 60_000 })
    const responder = makeRes()
    // First request (user_1 @ acme) drains the shared company bucket.
    expect(applyRateLimit(limiter, makeReq({ companySlug: 'acme' }), responder.res, '/api/projects', 'user_1')).toBe(
      false,
    )
    // A different user in the same company is blocked by the tenant bucket.
    const blocked = applyRateLimit(limiter, makeReq({ companySlug: 'acme' }), responder.res, '/api/projects', 'user_2')
    expect(blocked).toBe(true)
    expect(responder.statusCode()).toBe(429)
    const body = JSON.parse(responder.body())
    expect(body.scope).toBe('company')
    expect(body.retry_after_seconds).toBeGreaterThan(0)
  })
})

describe('enforcePortalTokenRateLimit', () => {
  it('allows the first writes up to the per-token cap, then 429s with scope portal_write', () => {
    const limiter = createRateLimiter({
      perUserPerMin: 100,
      perIpPerMin: 100,
      perCompanyPerMin: 1000,
      perPortalTokenReadPerMin: 100,
      perPortalTokenWritePerMin: 2,
      windowMs: 60_000,
    })
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).toBeNull()
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).toBeNull()
    const blocked = enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')
    expect(blocked).not.toBeNull()
    if (!blocked || blocked.allowed) throw new Error('expected denial')
    expect(blocked.scope).toBe('portal_write')
    expect(blocked.key).toBe('tok-A')
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('keeps the read and write buckets independent on the same token', () => {
    const limiter = createRateLimiter({
      perUserPerMin: 100,
      perIpPerMin: 100,
      perCompanyPerMin: 1000,
      perPortalTokenReadPerMin: 100,
      perPortalTokenWritePerMin: 1,
      windowMs: 60_000,
    })
    // Drain the write bucket.
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).toBeNull()
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).not.toBeNull()
    // Reads on the same token are untouched — the customer can still load the page.
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'read')).toBeNull()
  })

  it('keeps different tokens independent (one flooded customer never throttles another)', () => {
    const limiter = createRateLimiter({
      perUserPerMin: 100,
      perIpPerMin: 100,
      perCompanyPerMin: 1000,
      perPortalTokenReadPerMin: 100,
      perPortalTokenWritePerMin: 1,
      windowMs: 60_000,
    })
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).toBeNull()
    // tok-A is now drained, but tok-B (a different customer) is unaffected.
    expect(enforcePortalTokenRateLimit(limiter, 'tok-A', 'write')).not.toBeNull()
    expect(enforcePortalTokenRateLimit(limiter, 'tok-B', 'write')).toBeNull()
  })

  it('lets a legitimate single customer accept/decline + a few captures without throttling', () => {
    // Default config: 20 writes/token/min. A real customer does << that.
    const limiter = createRateLimiter(loadRateLimitConfig({} as NodeJS.ProcessEnv))
    // One accept + a 3-step capture finalize flow = 4 writes, well under the cap.
    for (let i = 0; i < 4; i++) {
      expect(enforcePortalTokenRateLimit(limiter, 'customer-token', 'write')).toBeNull()
    }
    // And many page reloads (reads) still pass.
    for (let i = 0; i < 30; i++) {
      expect(enforcePortalTokenRateLimit(limiter, 'customer-token', 'read')).toBeNull()
    }
  })

  it('does not limit an empty token (the route validation 4xxs it; "" would pool every bad request)', () => {
    const limiter = createRateLimiter({
      perUserPerMin: 100,
      perIpPerMin: 100,
      perCompanyPerMin: 1000,
      perPortalTokenReadPerMin: 100,
      perPortalTokenWritePerMin: 1,
      windowMs: 60_000,
    })
    expect(enforcePortalTokenRateLimit(limiter, '', 'write')).toBeNull()
    expect(enforcePortalTokenRateLimit(limiter, '   ', 'write')).toBeNull()
    // The blank calls never consumed the bucket, so a real token still has its full allowance.
    expect(enforcePortalTokenRateLimit(limiter, 'real', 'write')).toBeNull()
  })
})

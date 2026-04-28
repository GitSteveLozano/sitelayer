import { describe, expect, it } from 'vitest'
import {
  applyRateLimit,
  createRateLimiter,
  enforceRateLimit,
  isRateLimitExempt,
  loadRateLimitConfig,
  resolveRequestIp,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './rate-limit.js'
import type http from 'node:http'

function makeReq(opts: { ip?: string; xff?: string } = {}): http.IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.xff) headers['x-forwarded-for'] = opts.xff
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

  it('honours RATE_LIMIT_PER_USER_PER_MIN and RATE_LIMIT_PER_IP_PER_MIN', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_USER_PER_MIN: '250',
      RATE_LIMIT_PER_IP_PER_MIN: '5',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perUserPerMin).toBe(250)
    expect(cfg.perIpPerMin).toBe(5)
    expect(cfg.windowMs).toBe(60_000)
  })

  it('falls back to defaults for non-numeric values', () => {
    const cfg = loadRateLimitConfig({
      RATE_LIMIT_PER_USER_PER_MIN: 'nope',
      RATE_LIMIT_PER_IP_PER_MIN: '-3',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.perUserPerMin).toBe(DEFAULT_RATE_LIMIT_CONFIG.perUserPerMin)
    expect(cfg.perIpPerMin).toBe(DEFAULT_RATE_LIMIT_CONFIG.perIpPerMin)
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

describe('rate limiter token bucket', () => {
  it('fills to capacity, rejects with Retry-After once drained, then refills over the window', () => {
    const limiter = createRateLimiter({ perUserPerMin: 3, perIpPerMin: 30, windowMs: 60_000 })
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

  it('keeps per-user and per-IP buckets independent', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, windowMs: 60_000 })
    const t0 = 1_700_000_000_000
    expect(limiter.consume('user', 'alice', t0).allowed).toBe(true)
    // user:alice exhausted, but ip:1.2.3.4 untouched
    expect(limiter.consume('user', 'alice', t0).allowed).toBe(false)
    expect(limiter.consume('ip', '1.2.3.4', t0).allowed).toBe(true)
    expect(limiter.consume('ip', '1.2.3.4', t0).allowed).toBe(false)
  })

  it('refills proportionally over partial windows', () => {
    const limiter = createRateLimiter({ perUserPerMin: 6, perIpPerMin: 30, windowMs: 60_000 })
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
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, windowMs: 60_000 })
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/health', userId: null })).toBeNull()
    expect(enforceRateLimit(limiter, { req: makeReq(), pathname: '/api/webhooks/clerk', userId: 'user_1' })).toBeNull()
  })

  it('keys authenticated requests by user even when IP varies', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 100, windowMs: 60_000 })
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
    const limiter = createRateLimiter({ perUserPerMin: 100, perIpPerMin: 1, windowMs: 60_000 })
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
})

describe('applyRateLimit', () => {
  it('writes a 429 with Retry-After header and JSON body when rejected', () => {
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, windowMs: 60_000 })
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
    const limiter = createRateLimiter({ perUserPerMin: 1, perIpPerMin: 1, windowMs: 60_000 })
    const responder = makeRes()
    expect(applyRateLimit(limiter, makeReq(), responder.res, '/health', null)).toBe(false)
    expect(responder.statusCode()).toBe(0)
    expect(responder.body()).toBe('')
  })
})

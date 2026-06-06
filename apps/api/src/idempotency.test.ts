import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdempotencyCache, isIdempotentPostPath, validateIdempotencyKey } from './idempotency.js'

describe('validateIdempotencyKey', () => {
  it('accepts a normal string key and trims it', () => {
    const result = validateIdempotencyKey('  abc-123  ')
    expect(result).toEqual({ ok: true, key: 'abc-123' })
  })

  it('rejects undefined', () => {
    const result = validateIdempotencyKey(undefined)
    expect(result.ok).toBe(false)
  })

  it('rejects an empty / whitespace-only header', () => {
    expect(validateIdempotencyKey('').ok).toBe(false)
    expect(validateIdempotencyKey('   ').ok).toBe(false)
  })

  it('rejects an array header (duplicate Idempotency-Key)', () => {
    const result = validateIdempotencyKey(['a', 'b'])
    expect(result.ok).toBe(false)
  })

  it('rejects keys longer than 255 characters', () => {
    const key = 'a'.repeat(256)
    const result = validateIdempotencyKey(key)
    expect(result.ok).toBe(false)
  })

  it('accepts the exact 255-char boundary', () => {
    const key = 'a'.repeat(255)
    const result = validateIdempotencyKey(key)
    expect(result).toEqual({ ok: true, key })
  })
})

describe('createIdempotencyCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null on miss', () => {
    const cache = createIdempotencyCache(60_000)
    expect(cache.get('co-1', 'k')).toBeNull()
  })

  it('round-trips a cached response under (company, key)', () => {
    const cache = createIdempotencyCache(60_000)
    const response = { status: 201, body: { id: 'a' } }
    cache.set('co-1', 'k', response)
    expect(cache.get('co-1', 'k')).toEqual(response)
  })

  it('scopes by company_id (same key, different company → miss)', () => {
    const cache = createIdempotencyCache(60_000)
    cache.set('co-1', 'k', { status: 201, body: { id: 'a' } })
    expect(cache.get('co-2', 'k')).toBeNull()
  })

  it('evicts entries after TTL', () => {
    const cache = createIdempotencyCache(15 * 60 * 1000)
    cache.set('co-1', 'k', { status: 201, body: { id: 'a' } })
    expect(cache.get('co-1', 'k')).not.toBeNull()
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    expect(cache.get('co-1', 'k')).toBeNull()
  })
})

describe('end-to-end behaviour: same key twice returns byte-identical response', () => {
  // Mirrors the server.ts wrapper: on the first POST we run the "handler",
  // capture { status, body } into the cache, and respond. On the second POST
  // with the same Idempotency-Key (and company), the wrapper short-circuits
  // and the handler must NOT run a second time. The second response payload
  // must be byte-identical to the first when JSON.stringify-ed (this is what
  // a retrying client actually compares against).
  function runWithCache(
    cache: ReturnType<typeof createIdempotencyCache>,
    companyId: string,
    key: string,
    handler: () => { status: number; body: unknown },
  ): { status: number; body: unknown; cached: boolean } {
    const hit = cache.get(companyId, key)
    if (hit) return { ...hit, cached: true }
    const result = handler()
    cache.set(companyId, key, result)
    return { ...result, cached: false }
  }

  it('returns identical JSON on the second POST and does not re-invoke the handler', () => {
    const cache = createIdempotencyCache(60_000)
    let handlerInvocations = 0
    const handler = () => {
      handlerInvocations += 1
      return {
        status: 201,
        body: { id: 'cust-7', name: 'Acme', version: 1, created_at: '2026-05-17T19:00:00.000Z' },
      }
    }

    const first = runWithCache(cache, 'co-1', 'retry-token-1', handler)
    const second = runWithCache(cache, 'co-1', 'retry-token-1', handler)

    expect(handlerInvocations).toBe(1)
    expect(second.cached).toBe(true)
    expect(second.status).toBe(first.status)
    // Byte-identical JSON serialization is what real clients compare on
    // when reconciling a retry.
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body))
  })

  it('runs the handler again for a different company even with the same key', () => {
    const cache = createIdempotencyCache(60_000)
    let invocations = 0
    const handler = () => {
      invocations += 1
      return { status: 201, body: { invocation: invocations } }
    }

    runWithCache(cache, 'co-1', 'shared-token', handler)
    const otherCompany = runWithCache(cache, 'co-2', 'shared-token', handler)

    expect(invocations).toBe(2)
    expect(otherCompany.cached).toBe(false)
    expect(otherCompany.body).toEqual({ invocation: 2 })
  })
})

describe('isIdempotentPostPath', () => {
  it('matches CREATE-style POSTs on the wire list', () => {
    expect(isIdempotentPostPath('/api/customers')).toBe(true)
    expect(isIdempotentPostPath('/api/workers')).toBe(true)
    expect(isIdempotentPostPath('/api/material-bills')).toBe(true)
    expect(isIdempotentPostPath('/api/projects')).toBe(true)
    expect(isIdempotentPostPath('/api/integrations/qbo/mappings')).toBe(true)
    expect(isIdempotentPostPath('/api/pricing-profiles')).toBe(true)
    expect(isIdempotentPostPath('/api/bonus-rules')).toBe(true)
    expect(isIdempotentPostPath('/api/service-items')).toBe(true)
  })

  it('matches project-scoped subresource creators', () => {
    expect(isIdempotentPostPath('/api/projects/abc/blueprints')).toBe(true)
    expect(isIdempotentPostPath('/api/projects/abc/material-bills')).toBe(true)
    expect(isIdempotentPostPath('/api/projects/abc/takeoff-drafts')).toBe(true)
  })

  it('does NOT match workflow event endpoints', () => {
    expect(isIdempotentPostPath('/api/rental-billing-runs/abc/events')).toBe(false)
    expect(isIdempotentPostPath('/api/time-review-runs/abc/events')).toBe(false)
    expect(isIdempotentPostPath('/api/labor-payroll-runs/abc/events')).toBe(false)
    expect(isIdempotentPostPath('/api/project-lifecycle/abc/events')).toBe(false)
  })

  it('does NOT match webhook endpoints', () => {
    expect(isIdempotentPostPath('/api/webhooks/clerk')).toBe(false)
    expect(isIdempotentPostPath('/api/webhooks/qbo')).toBe(false)
  })

  it('does NOT match unknown / read-only paths', () => {
    expect(isIdempotentPostPath('/api/bootstrap')).toBe(false)
    expect(isIdempotentPostPath('/api/projects/abc/summary')).toBe(false)
    expect(isIdempotentPostPath('/health')).toBe(false)
  })
})

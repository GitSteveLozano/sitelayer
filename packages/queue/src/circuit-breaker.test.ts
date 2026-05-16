import { describe, expect, it } from 'vitest'
import { CircuitBreaker, isTrippingError } from './circuit-breaker.js'

describe('CircuitBreaker', () => {
  it('opens after threshold consecutive failures', () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 })
    breaker.recordFailure('qbo', '503')
    breaker.recordFailure('qbo', '503')
    expect(breaker.isOpen('qbo')).toBe(false)
    breaker.recordFailure('qbo', '503')
    expect(breaker.isOpen('qbo')).toBe(true)
    expect(breaker.snapshot('qbo')).toMatchObject({ open: true, failureCount: 3 })
  })

  it('resets the counter on success even before threshold', () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 })
    breaker.recordFailure('qbo', '503')
    breaker.recordFailure('qbo', '503')
    breaker.recordSuccess('qbo')
    expect(breaker.snapshot('qbo').failureCount).toBe(0)
    breaker.recordFailure('qbo', '503')
    expect(breaker.isOpen('qbo')).toBe(false)
  })

  it('half-opens after cooldown elapses', () => {
    let now = 1_000_000
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 5000 }, () => now)
    breaker.recordFailure('qbo', '503')
    breaker.recordFailure('qbo', '503')
    expect(breaker.isOpen('qbo')).toBe(true)
    now += 4999
    expect(breaker.isOpen('qbo')).toBe(true)
    now += 2
    expect(breaker.isOpen('qbo')).toBe(false)
  })

  it('fires onOpen exactly once when the circuit trips', () => {
    let opens = 0
    const breaker = new CircuitBreaker({
      threshold: 2,
      cooldownMs: 60_000,
      onOpen: () => {
        opens++
      },
    })
    breaker.recordFailure('qbo', '503')
    breaker.recordFailure('qbo', '503')
    breaker.recordFailure('qbo', '503') // already open — should not fire again
    expect(opens).toBe(1)
  })

  it('isolates state per key', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 })
    breaker.recordFailure('qbo', '503')
    expect(breaker.isOpen('qbo')).toBe(true)
    expect(breaker.isOpen('clerk')).toBe(false)
  })
})

describe('isTrippingError', () => {
  it('treats 5xx in message as tripping', () => {
    expect(isTrippingError(new Error('QBO push failed: 503 Service Unavailable'))).toBe(true)
    expect(isTrippingError(new Error('Internal Server Error (500)'))).toBe(true)
  })
  it('treats network-class errors as tripping', () => {
    expect(isTrippingError(new Error('fetch failed: ECONNREFUSED'))).toBe(true)
    expect(isTrippingError(new Error('ETIMEDOUT'))).toBe(true)
    expect(isTrippingError(new Error('network unreachable'))).toBe(true)
  })
  it('does NOT trip on 4xx', () => {
    expect(isTrippingError(new Error('400 bad request'))).toBe(false)
    expect(isTrippingError(new Error('404 not found'))).toBe(false)
  })
  it('does NOT trip on non-Error', () => {
    expect(isTrippingError('something')).toBe(false)
    expect(isTrippingError(null)).toBe(false)
  })
})

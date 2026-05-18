import { describe, it, expect } from 'vitest'
import { nextInterval } from './lifecycle.js'

describe('nextInterval (adaptive backoff)', () => {
  const base = 10_000
  const max = 60_000

  it('returns the base interval immediately when work is found', () => {
    expect(nextInterval(40_000, base, max, true)).toBe(base)
    expect(nextInterval(max, base, max, true)).toBe(base)
    expect(nextInterval(base, base, max, true)).toBe(base)
  })

  it('doubles the current interval on an empty tick', () => {
    expect(nextInterval(base, base, max, false)).toBe(20_000)
    expect(nextInterval(20_000, base, max, false)).toBe(40_000)
  })

  it('caps the backoff at max', () => {
    // 40_000 * 2 = 80_000 → clamped to 60_000.
    expect(nextInterval(40_000, base, max, false)).toBe(max)
    // Already at max → stay at max.
    expect(nextInterval(max, base, max, false)).toBe(max)
    // Above max somehow → clamped down.
    expect(nextInterval(120_000, base, max, false)).toBe(max)
  })

  it('produces a full backoff progression from base to max', () => {
    let current = base
    const sequence: number[] = [current]
    for (let i = 0; i < 5; i += 1) {
      current = nextInterval(current, base, max, false)
      sequence.push(current)
    }
    // 10_000 → 20_000 → 40_000 → 60_000 (capped) → 60_000 → 60_000
    expect(sequence).toEqual([10_000, 20_000, 40_000, max, max, max])
  })

  it('resets from anywhere in the backoff curve as soon as work appears', () => {
    let current = base
    for (let i = 0; i < 4; i += 1) {
      current = nextInterval(current, base, max, false)
    }
    expect(current).toBe(max)
    const reset = nextInterval(current, base, max, true)
    expect(reset).toBe(base)
  })

  it('floors max at base when misconfigured', () => {
    // If WORKER_POLL_MAX_INTERVAL_MS is accidentally set below the base,
    // we should still return at least the base — never below it.
    expect(nextInterval(base, base, 1_000, false)).toBe(base)
    expect(nextInterval(base, base, 1_000, true)).toBe(base)
  })

  it('treats sub-base current values as base', () => {
    // Defensive: if `current` is somehow corrupted to a smaller value,
    // the math should resume from `base`, not from the broken value.
    expect(nextInterval(0, base, max, false)).toBe(20_000)
    expect(nextInterval(-1, base, max, false)).toBe(20_000)
  })

  it('floors fractional inputs', () => {
    expect(nextInterval(15_500.7, 10_000.4, 60_000.9, false)).toBe(31_000)
  })
})

import { describe, expect, it } from 'vitest'
import { endOfWeek, startOfWeek } from './format'

/**
 * Week-window helpers feeding the time-review screen's "WEEK · …" header
 * and its labor-list fallback filter. Monday-anchored, local-date,
 * 6-day span. Pure → exercised directly with explicit dates so the
 * Monday-start + Sunday-crossover edge cases are pinned.
 */
describe('startOfWeek / endOfWeek (Monday-anchored)', () => {
  it('returns the Monday for a mid-week date', () => {
    // 2026-04-29 is a Wednesday → Monday 2026-04-27.
    expect(startOfWeek('2026-04-29')).toBe('2026-04-27')
    expect(endOfWeek('2026-04-29')).toBe('2026-05-03')
  })

  it('is a no-op start when the date is already Monday', () => {
    expect(startOfWeek('2026-04-27')).toBe('2026-04-27')
    expect(endOfWeek('2026-04-27')).toBe('2026-05-03')
  })

  it('treats Sunday as the end of the prior Monday-week (not the start)', () => {
    // 2026-05-03 is a Sunday → its week started Monday 2026-04-27.
    expect(startOfWeek('2026-05-03')).toBe('2026-04-27')
    expect(endOfWeek('2026-05-03')).toBe('2026-05-03')
  })

  it('spans exactly 6 days end-minus-start', () => {
    const start = new Date(startOfWeek('2026-04-29'))
    const end = new Date(endOfWeek('2026-04-29'))
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
    expect(days).toBe(6)
  })
})

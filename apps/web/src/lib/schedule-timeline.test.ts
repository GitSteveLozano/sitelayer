import { describe, expect, it } from 'vitest'
import {
  TIMELINE_DAYS,
  clampShift,
  computeRescheduleOps,
  offsetToIsoDate,
  pxToDayShift,
  type TimelineBlock,
} from './schedule-timeline'

// Mon 2026-05-04 is the anchor Monday used across these cases.
const ANCHOR = new Date(2026, 4, 4)

describe('offsetToIsoDate', () => {
  it('maps offset 0 to the anchor Monday', () => {
    expect(offsetToIsoDate(ANCHOR, 0)).toBe('2026-05-04')
  })

  it('maps within-week offsets to consecutive weekdays', () => {
    expect(offsetToIsoDate(ANCHOR, 1)).toBe('2026-05-05') // Tue
    expect(offsetToIsoDate(ANCHOR, 4)).toBe('2026-05-08') // Fri
  })

  it('skips the weekend at week boundaries', () => {
    // offset 5 is the next Monday (May 11), NOT Saturday May 9.
    expect(offsetToIsoDate(ANCHOR, 5)).toBe('2026-05-11')
    expect(offsetToIsoDate(ANCHOR, 10)).toBe('2026-05-18')
    expect(offsetToIsoDate(ANCHOR, 19)).toBe('2026-05-29') // last grid day (Fri wk4)
  })
})

describe('pxToDayShift', () => {
  it('returns 0 for a non-positive track width', () => {
    expect(pxToDayShift(100, 0)).toBe(0)
    expect(pxToDayShift(100, -5)).toBe(0)
  })

  it('snaps a one-column drag to a one-day shift', () => {
    const trackWidth = 1000 // 50px per column over 20 columns
    expect(pxToDayShift(50, trackWidth)).toBe(1)
    expect(pxToDayShift(-50, trackWidth)).toBe(-1)
  })

  it('rounds partial-column drags to the nearest day', () => {
    const trackWidth = 1000
    expect(pxToDayShift(70, trackWidth)).toBe(1) // 1.4 cols → 1
    expect(pxToDayShift(80, trackWidth)).toBe(2) // 1.6 cols → 2
    expect(pxToDayShift(20, trackWidth)).toBe(0) // 0.4 cols → 0
  })
})

describe('clampShift', () => {
  it('passes a shift through when the block stays in range', () => {
    expect(clampShift(3, 5, 2)).toBe(2)
  })

  it('clamps a left over-drag to keep start ≥ 0', () => {
    expect(clampShift(2, 4, -5)).toBe(-2)
  })

  it('clamps a right over-drag to keep start+span ≤ TIMELINE_DAYS', () => {
    // start 14, span 4 → max start is 16, so max shift is +2.
    expect(clampShift(14, 4, 9)).toBe(2)
    expect(14 + 4 + clampShift(14, 4, 9)).toBe(TIMELINE_DAYS)
  })
})

describe('computeRescheduleOps', () => {
  const block: TimelineBlock = {
    start: 0,
    span: 2,
    label: 'EPS · 3',
    days: [
      { offset: 0, ids: ['a1'] },
      { offset: 1, ids: ['b1', 'b2'] },
    ],
  }

  it('yields no ops for a zero shift', () => {
    expect(computeRescheduleOps(block, 0, ANCHOR)).toEqual([])
  })

  it('yields no ops when the shift clamps to zero (already at the left edge)', () => {
    expect(computeRescheduleOps(block, -3, ANCHOR)).toEqual([])
  })

  it('shifts every underlying schedule row by the clamped day delta', () => {
    // +5 working days: offset 0→5 (May 11), offset 1→6 (May 12).
    const ops = computeRescheduleOps(block, 5, ANCHOR)
    expect(ops).toEqual([
      { id: 'a1', scheduled_for: '2026-05-11' },
      { id: 'b1', scheduled_for: '2026-05-12' },
      { id: 'b2', scheduled_for: '2026-05-12' },
    ])
  })

  it('clamps an over-drag so the rightmost day lands on the last grid day', () => {
    const wide: TimelineBlock = {
      start: 14,
      span: 4,
      label: 'FINISH · 4',
      days: [
        { offset: 14, ids: ['x'] },
        { offset: 17, ids: ['y'] },
      ],
    }
    // Requested +9 clamps to +2; offset 17→19 (Fri wk4, last grid day).
    const ops = computeRescheduleOps(wide, 9, ANCHOR)
    expect(ops).toEqual([
      { id: 'x', scheduled_for: offsetToIsoDate(ANCHOR, 16) },
      { id: 'y', scheduled_for: '2026-05-29' },
    ])
  })
})

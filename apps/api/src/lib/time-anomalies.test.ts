import { describe, expect, it } from 'vitest'
import {
  clockOverlapAt,
  detectTimeAnomalies,
  pairClockIntervals,
  type ClockEventInput,
  type LaborEntryInput,
  type TimeAnomalyCode,
} from './time-anomalies.js'

const DAY = '2026-05-20'

function labor(over: Partial<LaborEntryInput> & { id: string }): LaborEntryInput {
  return {
    worker_id: 'w1',
    project_id: 'p1',
    hours: 8,
    occurred_on: DAY,
    division_code: 'FRAMING',
    service_item_code: 'FRAME-WALL',
    ...over,
  }
}

function clk(
  over: Partial<ClockEventInput> & { id: string; event_type: string; occurred_at: string },
): ClockEventInput {
  return {
    worker_id: 'w1',
    project_id: 'p1',
    inside_geofence: true,
    ...over,
  }
}

function codesFor(result: ReturnType<typeof detectTimeAnomalies>, id: string): TimeAnomalyCode[] {
  return (result.byEntryId[id] ?? []).map((a) => a.code)
}

describe('pairClockIntervals', () => {
  it('pairs in→out and skips voided rows and dangling ins', () => {
    const intervals = pairClockIntervals([
      clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T15:00:00Z` }),
      clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T23:00:00Z` }),
      clk({ id: 'c3', event_type: 'in', occurred_at: `${DAY}T23:30:00Z`, voided_at: `${DAY}T23:31:00Z` }),
      clk({ id: 'c4', event_type: 'in', occurred_at: `${DAY}T23:45:00Z` }), // dangling, no out
    ])
    expect(intervals).toHaveLength(1)
    expect(intervals[0]!.end - intervals[0]!.start).toBe(8 * 3_600_000)
  })
})

describe('clockOverlapAt', () => {
  it('returns the timestamp of a second concurrent open session', () => {
    const at = clockOverlapAt([
      clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T14:00:00Z` }),
      clk({ id: 'c2', event_type: 'in', occurred_at: `${DAY}T18:00:00Z`, project_id: 'p2' }),
      clk({ id: 'c3', event_type: 'out', occurred_at: `${DAY}T20:00:00Z` }),
    ])
    expect(at).toBe(Date.parse(`${DAY}T18:00:00Z`))
  })

  it('returns null when sessions never overlap', () => {
    const at = clockOverlapAt([
      clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T14:00:00Z` }),
      clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T17:00:00Z` }),
      clk({ id: 'c3', event_type: 'in', occurred_at: `${DAY}T17:30:00Z` }),
      clk({ id: 'c4', event_type: 'out', occurred_at: `${DAY}T21:00:00Z` }),
    ])
    expect(at).toBeNull()
  })
})

describe('detectTimeAnomalies', () => {
  it('flags zero/negative duration', () => {
    const zero = detectTimeAnomalies([labor({ id: 'z', hours: 0 })], [])
    expect(codesFor(zero, 'z')).toContain('zero_negative')

    const neg = detectTimeAnomalies([labor({ id: 'n', hours: -2 })], [])
    expect(codesFor(neg, 'n')).toContain('zero_negative')
    expect(neg.byEntryId['n']![0]!.message).toMatch(/negative/i)
  })

  it('flags excessive hours over the 12h cap', () => {
    const result = detectTimeAnomalies([labor({ id: 'e', hours: 14 })], [])
    expect(codesFor(result, 'e')).toContain('excessive')
    // 12.0 exactly is NOT excessive.
    const ok = detectTimeAnomalies([labor({ id: 'ok', hours: 12 })], [])
    expect(codesFor(ok, 'ok')).not.toContain('excessive')
  })

  it('flags overlap when a worker has labor on two jobs the same day', () => {
    const result = detectTimeAnomalies([labor({ id: 'a', project_id: 'p1' }), labor({ id: 'b', project_id: 'p2' })], [])
    expect(codesFor(result, 'a')).toContain('overlap')
    expect(codesFor(result, 'b')).toContain('overlap')
  })

  it('flags overlap when two clock sessions are open at once', () => {
    const result = detectTimeAnomalies(
      [labor({ id: 'a', hours: 9 })],
      [
        // Clocked into job A at 14:00, then clocked into job B at 18:00
        // before clocking out of A — two open sessions overlap.
        clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T14:00:00Z` }),
        clk({ id: 'c3', event_type: 'in', occurred_at: `${DAY}T18:00:00Z`, project_id: 'p2' }),
        clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T20:00:00Z` }),
        clk({ id: 'c4', event_type: 'out', occurred_at: `${DAY}T22:00:00Z`, project_id: 'p2' }),
      ],
    )
    expect(codesFor(result, 'a')).toContain('overlap')
  })

  it('flags missing_break on a long shift with no recorded break', () => {
    // 8h shift, single continuous clock interval (no gap) → no break.
    const result = detectTimeAnomalies(
      [labor({ id: 'a', hours: 8 })],
      [
        clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T13:00:00Z` }),
        clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T21:00:00Z` }),
      ],
    )
    expect(codesFor(result, 'a')).toContain('missing_break')
  })

  it('does NOT flag missing_break when a break gap exists in the clock chain', () => {
    // in 13:00 → out 17:00, lunch, in 17:30 → out 21:30. 30-min break.
    const result = detectTimeAnomalies(
      [labor({ id: 'a', hours: 8 })],
      [
        clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T13:00:00Z` }),
        clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T17:00:00Z` }),
        clk({ id: 'c3', event_type: 'in', occurred_at: `${DAY}T17:30:00Z` }),
        clk({ id: 'c4', event_type: 'out', occurred_at: `${DAY}T21:30:00Z` }),
      ],
    )
    expect(codesFor(result, 'a')).not.toContain('missing_break')
  })

  it('flags geofence on an off-site punch', () => {
    const result = detectTimeAnomalies(
      [labor({ id: 'a', hours: 8 })],
      [
        clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T13:00:00Z`, inside_geofence: false }),
        clk({ id: 'c2', event_type: 'out', occurred_at: `${DAY}T21:00:00Z`, inside_geofence: true }),
      ],
    )
    expect(codesFor(result, 'a')).toContain('geofence')
  })

  it('flags clockout_before_photo when a later same-site activity follows the clock-out', () => {
    const result = detectTimeAnomalies(
      [labor({ id: 'a', hours: 8 })],
      [
        clk({ id: 'c1', event_type: 'in', occurred_at: `${DAY}T13:00:00Z` }),
        clk({
          id: 'c2',
          event_type: 'out',
          occurred_at: `${DAY}T20:48:00Z`,
          // Photo uploaded 14 min after the clock-out → suspicious.
          photo_uploaded_at: `${DAY}T21:02:00Z`,
        }),
      ],
    )
    expect(codesFor(result, 'a')).toContain('clockout_before_photo')
  })

  it('flags variance when an entry is far above the crew norm for the day', () => {
    // Cohort of framers: most at ~8h, one at 16h.
    const entries = [
      labor({ id: 'a', worker_id: 'w1', hours: 8 }),
      labor({ id: 'b', worker_id: 'w2', hours: 8 }),
      labor({ id: 'c', worker_id: 'w3', hours: 8.5 }),
      labor({ id: 'd', worker_id: 'w4', hours: 16 }),
    ]
    const result = detectTimeAnomalies(entries, [])
    expect(codesFor(result, 'd')).toContain('variance')
    expect(codesFor(result, 'a')).not.toContain('variance')
  })

  it('counts distinct flagged entries, not total reasons', () => {
    // Entry "x" trips both excessive AND variance — still counts once.
    const entries = [
      labor({ id: 'x', worker_id: 'w1', hours: 16 }),
      labor({ id: 'y', worker_id: 'w2', hours: 8 }),
      labor({ id: 'z', worker_id: 'w3', hours: 8 }),
      labor({ id: 'q', worker_id: 'w4', hours: 8 }),
    ]
    const result = detectTimeAnomalies(entries, [])
    expect((result.byEntryId['x'] ?? []).length).toBeGreaterThan(1)
    expect(result.anomalyCount).toBe(1)
  })

  it('returns no anomalies for a clean normal day', () => {
    const entries = [
      labor({ id: 'a', worker_id: 'w1', hours: 8 }),
      labor({ id: 'b', worker_id: 'w2', hours: 8 }),
      labor({ id: 'c', worker_id: 'w3', hours: 8 }),
    ]
    const clock: ClockEventInput[] = [
      clk({ id: 'c1', worker_id: 'w1', event_type: 'in', occurred_at: `${DAY}T13:00:00Z` }),
      clk({ id: 'c2', worker_id: 'w1', event_type: 'out', occurred_at: `${DAY}T17:00:00Z` }),
      clk({ id: 'c3', worker_id: 'w1', event_type: 'in', occurred_at: `${DAY}T17:30:00Z` }),
      clk({ id: 'c4', worker_id: 'w1', event_type: 'out', occurred_at: `${DAY}T21:30:00Z` }),
    ]
    const result = detectTimeAnomalies(entries, clock)
    expect(result.anomalyCount).toBe(0)
    expect(result.byEntryId).toEqual({})
  })

  it('coerces string hours from pg numeric', () => {
    const result = detectTimeAnomalies([labor({ id: 'a', hours: '13.50' })], [])
    expect(codesFor(result, 'a')).toContain('excessive')
  })
})

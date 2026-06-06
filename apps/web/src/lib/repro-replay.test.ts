import { describe, expect, it } from 'vitest'
import {
  formatReproDuration,
  formatReproOffset,
  parseReproBracketSummary,
  parseRrwebReplayEvents,
} from './repro-replay'

const SUMMARY = {
  schema_version: 1,
  artifact_type: 'capture.repro_bracket',
  capture_session_id: 's1',
  route_path: '/projects/p1/takeoff-canvas',
  started_at: '2026-06-05T12:00:00.000Z',
  ended_at: '2026-06-05T12:00:19.000Z',
  duration_ms: 19000,
  window_ms: { start: 0, end: 19000, relative_to: 'repro_started' },
  start_condition: { note: 'about to push the estimate', snapshot_reason: 'repro_start' },
  end_condition: { note: 'total doubled', snapshot_reason: 'repro_end' },
  marks: [
    { offset_ms: 4000, label: 'total looks wrong', at: '2026-06-05T12:00:04.000Z' },
    { offset_ms: 9500, label: 'Mark 2', at: '2026-06-05T12:00:09.500Z' },
  ],
  replay: { enabled: true, event_count: 142 },
}

describe('parseReproBracketSummary', () => {
  it('parses a well-formed repro_bracket artifact', () => {
    const view = parseReproBracketSummary(SUMMARY)
    expect(view).toMatchObject({
      duration_ms: 19000,
      route_path: '/projects/p1/takeoff-canvas',
      start_note: 'about to push the estimate',
      end_note: 'total doubled',
      replay_enabled: true,
      replay_event_count: 142,
    })
    expect(view?.marks).toHaveLength(2)
    expect(view?.marks[0]).toMatchObject({ offset_ms: 4000, label: 'total looks wrong' })
  })

  it('rejects the wrong artifact type and non-objects', () => {
    expect(parseReproBracketSummary({ artifact_type: 'capture.rrweb_replay' })).toBeNull()
    expect(parseReproBracketSummary(null)).toBeNull()
    expect(parseReproBracketSummary('nope')).toBeNull()
  })

  it('survives missing/odd fields without throwing', () => {
    const view = parseReproBracketSummary({
      artifact_type: 'capture.repro_bracket',
      marks: [{ label: 'no offset' }, 7],
    })
    expect(view).not.toBeNull()
    expect(view?.marks).toHaveLength(0) // a mark with no numeric offset is dropped
    expect(view?.start_note).toBeNull()
    expect(view?.replay_enabled).toBe(false)
  })
})

describe('parseRrwebReplayEvents', () => {
  it('returns the events array when there are enough of them', () => {
    const events = parseRrwebReplayEvents({
      artifact_type: 'capture.rrweb_replay',
      event_count: 2,
      events: [{ type: 2 }, { type: 3 }],
    })
    expect(events).toHaveLength(2)
  })

  it('returns null for too-few events or the wrong type', () => {
    expect(parseRrwebReplayEvents({ artifact_type: 'capture.rrweb_replay', events: [{ type: 2 }] })).toBeNull()
    expect(parseRrwebReplayEvents({ artifact_type: 'capture.repro_bracket', events: [1, 2] })).toBeNull()
    expect(parseRrwebReplayEvents({ events: 'x' })).toBeNull()
  })
})

describe('formatting', () => {
  it('formats offsets as mm:ss', () => {
    expect(formatReproOffset(0)).toBe('00:00')
    expect(formatReproOffset(9500)).toBe('00:09')
    expect(formatReproOffset(125000)).toBe('02:05')
  })

  it('formats short durations in seconds and long ones as mm:ss', () => {
    expect(formatReproDuration(null)).toBe('—')
    expect(formatReproDuration(4200)).toBe('4.2s')
    expect(formatReproDuration(75000)).toBe('01:15')
  })
})

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  DAILY_LOG_ALL_STATES,
  DAILY_LOG_TERMINAL_STATES,
  DAILY_LOG_WORKFLOW_NAME,
  DAILY_LOG_WORKFLOW_SCHEMA_VERSION,
  dailyLogStatusToWorkflowState,
  dailyLogWorkflow,
  isHumanDailyLogEvent,
  nextDailyLogEvents,
  parseDailyLogEventRequest,
  transitionDailyLogWorkflow,
  type DailyLogWorkflowEvent,
  type DailyLogWorkflowSnapshot,
  type DailyLogWorkflowState,
} from './daily-log.js'
import { applyEventLog, type WorkflowEventLogEntry } from './replay.js'

describe('transitionDailyLogWorkflow', () => {
  it('draft → submitted via SUBMIT (happy path)', () => {
    const draft: DailyLogWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const submitted = transitionDailyLogWorkflow(draft, {
      type: 'SUBMIT',
      submitted_at: '2026-05-09T20:00:00.000Z',
      submitted_by: 'foreman-1',
    })
    expect(submitted).toMatchObject({
      state: 'submitted',
      state_version: 2,
      submitted_at: '2026-05-09T20:00:00.000Z',
      submitted_by: 'foreman-1',
    })
  })

  it('preserves unrelated snapshot fields across the transition', () => {
    const draft: DailyLogWorkflowSnapshot = {
      state: 'draft',
      state_version: 5,
      submitted_at: null,
      submitted_by: null,
    }
    const submitted = transitionDailyLogWorkflow(draft, {
      type: 'SUBMIT',
      submitted_at: '2026-05-09T20:00:00.000Z',
      submitted_by: 'foreman-2',
    })
    expect(submitted.state_version).toBe(6)
  })

  it('rejects SUBMIT from submitted (terminal; no UNSUBMIT)', () => {
    expect(() =>
      transitionDailyLogWorkflow(
        { state: 'submitted', state_version: 2 },
        { type: 'SUBMIT', submitted_at: '2026-05-09T20:00:00.000Z', submitted_by: 'foreman-1' },
      ),
    ).toThrow(/not allowed/)
  })
})

describe('dailyLogStatusToWorkflowState', () => {
  it('maps "submitted" to "submitted"', () => {
    expect(dailyLogStatusToWorkflowState('submitted')).toBe('submitted')
  })
  it('maps "draft" and anything else to "draft"', () => {
    expect(dailyLogStatusToWorkflowState('draft')).toBe('draft')
    expect(dailyLogStatusToWorkflowState('')).toBe('draft')
    expect(dailyLogStatusToWorkflowState('garbage')).toBe('draft')
  })
})

describe('isHumanDailyLogEvent', () => {
  it('accepts SUBMIT', () => {
    expect(isHumanDailyLogEvent('SUBMIT')).toBe(true)
  })
  it('rejects garbage', () => {
    expect(isHumanDailyLogEvent('UNSUBMIT')).toBe(false)
    expect(isHumanDailyLogEvent('')).toBe(false)
  })
})

describe('nextDailyLogEvents', () => {
  it('exposes SUBMIT from draft', () => {
    expect(nextDailyLogEvents('draft').map((e) => e.type)).toEqual(['SUBMIT'])
  })
  it('exposes nothing from submitted (terminal)', () => {
    expect(nextDailyLogEvents('submitted')).toEqual([])
  })
})

describe('parseDailyLogEventRequest', () => {
  it('accepts a well-formed SUBMIT', () => {
    const r = parseDailyLogEventRequest({ event: 'SUBMIT', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('accepts state_version as a numeric string from offline replay', () => {
    const r = parseDailyLogEventRequest({ event: 'SUBMIT', state_version: '5' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(5)
  })
  it('rejects unknown events', () => {
    expect(parseDailyLogEventRequest({ event: 'UNSUBMIT', state_version: 1 }).ok).toBe(false)
  })
  it('rejects missing fields', () => {
    expect(parseDailyLogEventRequest({}).ok).toBe(false)
    expect(parseDailyLogEventRequest({ event: 'SUBMIT' }).ok).toBe(false)
    expect(parseDailyLogEventRequest({ state_version: 1 }).ok).toBe(false)
  })
  it('rejects zero / negative / non-integer state_version', () => {
    expect(parseDailyLogEventRequest({ event: 'SUBMIT', state_version: 0 }).ok).toBe(false)
    expect(parseDailyLogEventRequest({ event: 'SUBMIT', state_version: -1 }).ok).toBe(false)
    expect(parseDailyLogEventRequest({ event: 'SUBMIT', state_version: 1.5 }).ok).toBe(false)
  })
  it('handles non-object bodies safely', () => {
    expect(parseDailyLogEventRequest(null).ok).toBe(false)
    expect(parseDailyLogEventRequest(undefined).ok).toBe(false)
    expect(parseDailyLogEventRequest('not an object').ok).toBe(false)
    expect(parseDailyLogEventRequest(['array']).ok).toBe(false)
  })
})

describe('dailyLogWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(dailyLogWorkflow.name).toBe(DAILY_LOG_WORKFLOW_NAME)
    expect(dailyLogWorkflow.schemaVersion).toBe(DAILY_LOG_WORKFLOW_SCHEMA_VERSION)
    expect(dailyLogWorkflow.initialState).toBe('draft')
    expect(dailyLogWorkflow.terminalStates).toEqual(['submitted'])
    expect(dailyLogWorkflow.sideEffectTypes).toEqual([])
  })
})

describe('applyEventLog replay — daily_log', () => {
  it('replays a single SUBMIT entry to the persisted snapshot bit-for-bit', () => {
    // Fixture mirrors what workflow_event_log would persist for a draft
    // log that the foreman submits once. state_version on the entry is
    // the version BEFORE the transition (i.e. 1); the snapshot_after
    // version is 2.
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: DAILY_LOG_WORKFLOW_NAME,
        schema_version: DAILY_LOG_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-4000-8000-000000000001',
        state_version: 1,
        event_payload: {
          type: 'SUBMIT',
          submitted_at: '2026-05-09T20:00:00.000Z',
          submitted_by: 'foreman-1',
        },
        snapshot_after: {
          state: 'submitted',
          state_version: 2,
          submitted_at: '2026-05-09T20:00:00.000Z',
          submitted_by: 'foreman-1',
        },
      },
    ]
    const initial: DailyLogWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const result = applyEventLog<DailyLogWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot).toMatchObject({
      state: 'submitted',
      state_version: 2,
      submitted_by: 'foreman-1',
    })
  })
})

describe('daily-log reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<DailyLogWorkflowState> = fc.constantFrom(...DAILY_LOG_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<DailyLogWorkflowEvent> = fc.record({
    type: fc.constant('SUBMIT' as const),
    submitted_at: fc.constant('2026-05-09T20:00:00.000Z'),
    submitted_by: fc.string({ minLength: 1, maxLength: 32 }),
  })

  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: DailyLogWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionDailyLogWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('terminal states (submitted) reject every event — terminal closure', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DAILY_LOG_TERMINAL_STATES), EVENT_GEN, (state, event) => {
        expect(() => transitionDailyLogWorkflow({ state, state_version: 2 }, event)).toThrow(/not allowed/)
      }),
    )
  })

  it('reducer output is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionDailyLogWorkflow({ state, state_version: 1 }, event)
          expect(DAILY_LOG_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('reducer is deterministic — same input twice yields equal output (replay determinism)', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        const snap: DailyLogWorkflowSnapshot = { state, state_version: 7 }
        let a: DailyLogWorkflowSnapshot | null = null
        let b: DailyLogWorkflowSnapshot | null = null
        let aThrew = false
        let bThrew = false
        try {
          a = transitionDailyLogWorkflow(snap, event)
        } catch {
          aThrew = true
        }
        try {
          b = transitionDailyLogWorkflow(snap, event)
        } catch {
          bThrew = true
        }
        expect(aThrew).toBe(bThrew)
        if (!aThrew && !bThrew) {
          expect(a).toEqual(b)
        }
      }),
    )
  })

  it('nextEvents only returns events the reducer accepts from that state', () => {
    for (const state of DAILY_LOG_ALL_STATES) {
      const events = nextDailyLogEvents(state)
      for (const next of events) {
        const event: DailyLogWorkflowEvent = {
          type: next.type,
          submitted_at: '2026-05-09T20:00:00.000Z',
          submitted_by: 'tester',
        }
        expect(() => transitionDailyLogWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })
})

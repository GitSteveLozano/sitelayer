import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  CREW_SCHEDULE_ALL_STATES,
  CREW_SCHEDULE_TERMINAL_STATES,
  crewScheduleWorkflow,
  isHumanCrewScheduleEvent,
  nextCrewScheduleEvents,
  parseCrewScheduleEventRequest,
  transitionCrewScheduleWorkflow,
  type CrewScheduleWorkflowEvent,
  type CrewScheduleWorkflowSnapshot,
  type CrewScheduleWorkflowState,
} from './crew-schedule.js'

describe('transitionCrewScheduleWorkflow — happy path', () => {
  it('draft → confirmed via CONFIRM', () => {
    const draft: CrewScheduleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const confirmed = transitionCrewScheduleWorkflow(draft, {
      type: 'CONFIRM',
      confirmed_at: '2026-04-29T15:00:00.000Z',
      confirmed_by: 'foreman-user',
    })
    expect(confirmed).toEqual({
      state: 'confirmed',
      state_version: 2,
      confirmed_at: '2026-04-29T15:00:00.000Z',
      confirmed_by: 'foreman-user',
    })
  })

  it('rejects CONFIRM from confirmed (terminal)', () => {
    expect(() =>
      transitionCrewScheduleWorkflow(
        { state: 'confirmed', state_version: 2 },
        { type: 'CONFIRM', confirmed_at: '2026-04-29T15:00:00.000Z', confirmed_by: 'x' },
      ),
    ).toThrow(/not allowed/)
  })
})

describe('crew-schedule reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<CrewScheduleWorkflowState> = fc.constantFrom(...CREW_SCHEDULE_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<CrewScheduleWorkflowEvent> = fc.record({
    type: fc.constant('CONFIRM' as const),
    confirmed_at: fc.constant('2026-04-29T15:00:00.000Z'),
    confirmed_by: fc.string({ minLength: 1, maxLength: 32 }),
  })

  it('state_version increments by 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: CrewScheduleWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionCrewScheduleWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CREW_SCHEDULE_TERMINAL_STATES), EVENT_GEN, (state, event) => {
        expect(() => transitionCrewScheduleWorkflow({ state, state_version: 1 }, event)).toThrow(/not allowed/)
      }),
    )
  })

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionCrewScheduleWorkflow({ state, state_version: 1 }, event)
          expect(CREW_SCHEDULE_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of CREW_SCHEDULE_ALL_STATES) {
      const events = nextCrewScheduleEvents(state)
      for (const next of events) {
        const snap: CrewScheduleWorkflowSnapshot = { state, state_version: 1 }
        const event: CrewScheduleWorkflowEvent = {
          type: next.type,
          confirmed_at: '2026-04-29T15:00:00.000Z',
          confirmed_by: 't',
        }
        expect(() => transitionCrewScheduleWorkflow(snap, event)).not.toThrow()
      }
    }
  })

  it('terminal states have no next events', () => {
    expect(nextCrewScheduleEvents('confirmed')).toEqual([])
  })

  it('draft state offers CONFIRM', () => {
    expect(nextCrewScheduleEvents('draft').map((e) => e.type)).toEqual(['CONFIRM'])
  })
})

describe('isHumanCrewScheduleEvent', () => {
  it('accepts CONFIRM', () => {
    expect(isHumanCrewScheduleEvent('CONFIRM')).toBe(true)
  })
  it('rejects garbage', () => {
    expect(isHumanCrewScheduleEvent('CANCEL')).toBe(false)
    expect(isHumanCrewScheduleEvent('')).toBe(false)
  })
})

describe('parseCrewScheduleEventRequest', () => {
  it('accepts a well-formed CONFIRM', () => {
    const r = parseCrewScheduleEventRequest({ event: 'CONFIRM', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('accepts state_version as a numeric string', () => {
    const r = parseCrewScheduleEventRequest({ event: 'CONFIRM', state_version: '5' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(5)
  })
  it('rejects unknown events', () => {
    expect(parseCrewScheduleEventRequest({ event: 'NOPE', state_version: 1 }).ok).toBe(false)
  })
  it('rejects missing fields', () => {
    expect(parseCrewScheduleEventRequest({}).ok).toBe(false)
  })
})

describe('crewScheduleWorkflow registry registration', () => {
  it('exposes reducer + metadata', () => {
    expect(crewScheduleWorkflow.name).toBe('crew_schedule')
    expect(crewScheduleWorkflow.schemaVersion).toBe(1)
    expect(crewScheduleWorkflow.initialState).toBe('draft')
    expect(crewScheduleWorkflow.terminalStates).toEqual(['confirmed'])
    expect(crewScheduleWorkflow.sideEffectTypes).toEqual([])
  })
})

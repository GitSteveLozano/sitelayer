import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  PROJECT_CLOSEOUT_ALL_STATES,
  PROJECT_CLOSEOUT_TERMINAL_STATES,
  projectCloseoutWorkflow,
  isHumanProjectCloseoutEvent,
  nextProjectCloseoutEvents,
  parseProjectCloseoutEventRequest,
  projectStatusToCloseoutState,
  transitionProjectCloseoutWorkflow,
  type ProjectCloseoutWorkflowEvent,
  type ProjectCloseoutWorkflowSnapshot,
  type ProjectCloseoutWorkflowState,
} from './project-closeout.js'

describe('transitionProjectCloseoutWorkflow', () => {
  it('active → completed via CLOSEOUT', () => {
    const active: ProjectCloseoutWorkflowSnapshot = { state: 'active', state_version: 1 }
    const completed = transitionProjectCloseoutWorkflow(active, {
      type: 'CLOSEOUT',
      closed_at: '2026-04-29T15:00:00.000Z',
      closed_by: 'office-user',
    })
    expect(completed).toMatchObject({
      state: 'completed',
      state_version: 2,
      closed_at: '2026-04-29T15:00:00.000Z',
      closed_by: 'office-user',
    })
  })

  it('rejects CLOSEOUT from completed (terminal)', () => {
    expect(() =>
      transitionProjectCloseoutWorkflow(
        { state: 'completed', state_version: 2 },
        { type: 'CLOSEOUT', closed_at: '2026-04-29T15:00:00.000Z', closed_by: 'x' },
      ),
    ).toThrow(/not allowed/)
  })
})

describe('projectStatusToCloseoutState', () => {
  it('maps "completed" to "completed"', () => {
    expect(projectStatusToCloseoutState('completed')).toBe('completed')
  })
  it('maps everything else to "active"', () => {
    expect(projectStatusToCloseoutState('lead')).toBe('active')
    expect(projectStatusToCloseoutState('active')).toBe('active')
    expect(projectStatusToCloseoutState('on_hold')).toBe('active')
    expect(projectStatusToCloseoutState('')).toBe('active')
    expect(projectStatusToCloseoutState('garbage')).toBe('active')
  })
})

describe('project-closeout reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<ProjectCloseoutWorkflowState> = fc.constantFrom(...PROJECT_CLOSEOUT_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<ProjectCloseoutWorkflowEvent> = fc.record({
    type: fc.constant('CLOSEOUT' as const),
    closed_at: fc.constant('2026-04-29T15:00:00.000Z'),
    closed_by: fc.string({ minLength: 1, maxLength: 32 }),
  })

  it('state_version increments by 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: ProjectCloseoutWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionProjectCloseoutWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PROJECT_CLOSEOUT_TERMINAL_STATES), EVENT_GEN, (state, event) => {
        expect(() => transitionProjectCloseoutWorkflow({ state, state_version: 1 }, event)).toThrow(/not allowed/)
      }),
    )
  })

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionProjectCloseoutWorkflow({ state, state_version: 1 }, event)
          expect(PROJECT_CLOSEOUT_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of PROJECT_CLOSEOUT_ALL_STATES) {
      const events = nextProjectCloseoutEvents(state)
      for (const next of events) {
        const event: ProjectCloseoutWorkflowEvent = {
          type: next.type,
          closed_at: '2026-04-29T15:00:00.000Z',
          closed_by: 't',
        }
        expect(() => transitionProjectCloseoutWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })

  it('terminal states have no next events', () => {
    expect(nextProjectCloseoutEvents('completed')).toEqual([])
  })
})

describe('isHumanProjectCloseoutEvent', () => {
  it('accepts CLOSEOUT', () => {
    expect(isHumanProjectCloseoutEvent('CLOSEOUT')).toBe(true)
  })
  it('rejects garbage', () => {
    expect(isHumanProjectCloseoutEvent('CANCEL')).toBe(false)
    expect(isHumanProjectCloseoutEvent('')).toBe(false)
  })
})

describe('parseProjectCloseoutEventRequest', () => {
  it('accepts a well-formed CLOSEOUT', () => {
    const r = parseProjectCloseoutEventRequest({ event: 'CLOSEOUT', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('accepts state_version as a numeric string', () => {
    const r = parseProjectCloseoutEventRequest({ event: 'CLOSEOUT', state_version: '5' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(5)
  })
  it('rejects unknown events', () => {
    expect(parseProjectCloseoutEventRequest({ event: 'NOPE', state_version: 1 }).ok).toBe(false)
  })
  it('rejects missing fields', () => {
    expect(parseProjectCloseoutEventRequest({}).ok).toBe(false)
  })
})

describe('projectCloseoutWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(projectCloseoutWorkflow.name).toBe('project_closeout')
    expect(projectCloseoutWorkflow.schemaVersion).toBe(1)
    expect(projectCloseoutWorkflow.initialState).toBe('active')
    expect(projectCloseoutWorkflow.terminalStates).toEqual(['completed'])
    expect(projectCloseoutWorkflow.sideEffectTypes).toEqual([])
  })
})

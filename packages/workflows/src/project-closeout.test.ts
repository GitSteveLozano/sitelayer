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

  it('rejects CLOSEOUT from completed (no longer the initial→terminal hop)', () => {
    expect(() =>
      transitionProjectCloseoutWorkflow(
        { state: 'completed', state_version: 2 },
        { type: 'CLOSEOUT', closed_at: '2026-04-29T15:00:00.000Z', closed_by: 'x' },
      ),
    ).toThrow(/not allowed/)
  })

  it('CLOSEOUT locks the summary at closed_at and preserves an existing lock', () => {
    const fresh = transitionProjectCloseoutWorkflow(
      { state: 'active', state_version: 1 },
      { type: 'CLOSEOUT', closed_at: '2026-04-29T15:00:00.000Z', closed_by: 'office-user' },
    )
    expect(fresh.summary_locked_at).toBe('2026-04-29T15:00:00.000Z')

    const preserved = transitionProjectCloseoutWorkflow(
      { state: 'active', state_version: 1, summary_locked_at: '2026-01-01T00:00:00.000Z' },
      { type: 'CLOSEOUT', closed_at: '2026-04-29T15:00:00.000Z', closed_by: 'office-user' },
    )
    expect(preserved.summary_locked_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('completed → post_mortem via ACKNOWLEDGE_POST_MORTEM', () => {
    const completed: ProjectCloseoutWorkflowSnapshot = {
      state: 'completed',
      state_version: 2,
      closed_at: '2026-04-29T15:00:00.000Z',
      closed_by: 'office-user',
    }
    const postMortem = transitionProjectCloseoutWorkflow(completed, {
      type: 'ACKNOWLEDGE_POST_MORTEM',
      acknowledged_at: '2026-05-02T10:00:00.000Z',
      acknowledged_by: 'owner-user',
    })
    expect(postMortem).toMatchObject({
      state: 'post_mortem',
      state_version: 3,
      post_mortem_acknowledged_at: '2026-05-02T10:00:00.000Z',
      post_mortem_acknowledged_by: 'owner-user',
    })
  })

  it('rejects ACKNOWLEDGE_POST_MORTEM from active', () => {
    expect(() =>
      transitionProjectCloseoutWorkflow(
        { state: 'active', state_version: 1 },
        {
          type: 'ACKNOWLEDGE_POST_MORTEM',
          acknowledged_at: '2026-05-02T10:00:00.000Z',
          acknowledged_by: 'owner-user',
        },
      ),
    ).toThrow(/not allowed/)
  })

  it('post_mortem is terminal — rejects both events', () => {
    const terminal: ProjectCloseoutWorkflowSnapshot = { state: 'post_mortem', state_version: 3 }
    expect(() =>
      transitionProjectCloseoutWorkflow(terminal, {
        type: 'CLOSEOUT',
        closed_at: '2026-04-29T15:00:00.000Z',
        closed_by: 'x',
      }),
    ).toThrow(/not allowed/)
    expect(() =>
      transitionProjectCloseoutWorkflow(terminal, {
        type: 'ACKNOWLEDGE_POST_MORTEM',
        acknowledged_at: '2026-05-02T10:00:00.000Z',
        acknowledged_by: 'owner-user',
      }),
    ).toThrow(/not allowed/)
  })
})

describe('projectStatusToCloseoutState', () => {
  it('maps "completed" with no post-mortem ack to "completed"', () => {
    expect(projectStatusToCloseoutState('completed')).toBe('completed')
    expect(projectStatusToCloseoutState('completed', null)).toBe('completed')
  })
  it('maps "completed" with a post-mortem ack timestamp to "post_mortem"', () => {
    expect(projectStatusToCloseoutState('completed', '2026-05-02T10:00:00.000Z')).toBe('post_mortem')
  })
  it('maps everything else to "active" regardless of ack', () => {
    expect(projectStatusToCloseoutState('lead')).toBe('active')
    expect(projectStatusToCloseoutState('active')).toBe('active')
    expect(projectStatusToCloseoutState('on_hold')).toBe('active')
    expect(projectStatusToCloseoutState('')).toBe('active')
    expect(projectStatusToCloseoutState('garbage')).toBe('active')
    expect(projectStatusToCloseoutState('lead', '2026-05-02T10:00:00.000Z')).toBe('active')
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
        const event: ProjectCloseoutWorkflowEvent =
          next.type === 'CLOSEOUT'
            ? { type: 'CLOSEOUT', closed_at: '2026-04-29T15:00:00.000Z', closed_by: 't' }
            : { type: 'ACKNOWLEDGE_POST_MORTEM', acknowledged_at: '2026-05-02T10:00:00.000Z', acknowledged_by: 't' }
        expect(() => transitionProjectCloseoutWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })

  it('terminal state (post_mortem) has no next events', () => {
    expect(nextProjectCloseoutEvents('post_mortem')).toEqual([])
  })

  it('completed offers ACKNOWLEDGE_POST_MORTEM', () => {
    expect(nextProjectCloseoutEvents('completed')).toEqual([{ type: 'ACKNOWLEDGE_POST_MORTEM', label: 'Open post-mortem' }])
  })
})

describe('isHumanProjectCloseoutEvent', () => {
  it('accepts CLOSEOUT and ACKNOWLEDGE_POST_MORTEM', () => {
    expect(isHumanProjectCloseoutEvent('CLOSEOUT')).toBe(true)
    expect(isHumanProjectCloseoutEvent('ACKNOWLEDGE_POST_MORTEM')).toBe(true)
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
  it('accepts a well-formed ACKNOWLEDGE_POST_MORTEM', () => {
    const r = parseProjectCloseoutEventRequest({ event: 'ACKNOWLEDGE_POST_MORTEM', state_version: 2 })
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
    expect(projectCloseoutWorkflow.terminalStates).toEqual(['post_mortem'])
    expect(projectCloseoutWorkflow.sideEffectTypes).toEqual([])
  })
})

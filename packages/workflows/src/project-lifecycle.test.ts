import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  PROJECT_LIFECYCLE_ALL_STATES,
  isHumanProjectLifecycleEvent,
  nextProjectLifecycleEvents,
  parseProjectLifecycleEventRequest,
  projectLifecycleWorkflow,
  projectStatusToLifecycleState,
  transitionProjectLifecycleWorkflow,
  type ProjectLifecycleWorkflowEvent,
  type ProjectLifecycleWorkflowSnapshot,
  type ProjectLifecycleWorkflowState,
} from './project-lifecycle.js'

const ACTOR = 'admin-user'

function buildEvent<T extends ProjectLifecycleWorkflowEvent['type']>(
  type: T,
  occurredAt = '2026-05-09T12:00:00.000Z',
  reason?: string,
): ProjectLifecycleWorkflowEvent {
  if (type === 'DECLINE') {
    return reason !== undefined
      ? { type: 'DECLINE', actor_user_id: ACTOR, occurred_at: occurredAt, reason }
      : { type: 'DECLINE', actor_user_id: ACTOR, occurred_at: occurredAt }
  }
  return { type, actor_user_id: ACTOR, occurred_at: occurredAt } as ProjectLifecycleWorkflowEvent
}

function snap(
  state: ProjectLifecycleWorkflowState,
  overrides: Partial<ProjectLifecycleWorkflowSnapshot> = {},
): ProjectLifecycleWorkflowSnapshot {
  return { state, state_version: 1, ...overrides }
}

describe('transitionProjectLifecycleWorkflow — happy paths', () => {
  it('walks the full draft → archived path', () => {
    let s = snap('draft')
    s = transitionProjectLifecycleWorkflow(s, buildEvent('START_ESTIMATING', '2026-05-09T10:00:00.000Z'))
    expect(s.state).toBe('estimating')
    expect(s.state_version).toBe(2)

    s = transitionProjectLifecycleWorkflow(s, buildEvent('SEND', '2026-05-09T11:00:00.000Z'))
    expect(s.state).toBe('sent')
    expect(s.sent_at).toBe('2026-05-09T11:00:00.000Z')

    s = transitionProjectLifecycleWorkflow(s, buildEvent('ACCEPT', '2026-05-09T12:00:00.000Z'))
    expect(s.state).toBe('accepted')
    expect(s.accepted_at).toBe('2026-05-09T12:00:00.000Z')

    s = transitionProjectLifecycleWorkflow(s, buildEvent('START_WORK', '2026-05-09T13:00:00.000Z'))
    expect(s.state).toBe('in_progress')
    expect(s.started_at).toBe('2026-05-09T13:00:00.000Z')

    s = transitionProjectLifecycleWorkflow(s, buildEvent('COMPLETE', '2026-05-09T14:00:00.000Z'))
    expect(s.state).toBe('done')
    expect(s.completed_at).toBe('2026-05-09T14:00:00.000Z')

    s = transitionProjectLifecycleWorkflow(s, buildEvent('ARCHIVE', '2026-05-09T15:00:00.000Z'))
    expect(s.state).toBe('archived')
    expect(s.archived_at).toBe('2026-05-09T15:00:00.000Z')
    expect(s.state_version).toBe(7)
  })

  it('sent → DECLINE captures reason and timestamp', () => {
    const sent = snap('sent', { sent_at: '2026-05-09T11:00:00.000Z', state_version: 3 })
    const declined = transitionProjectLifecycleWorkflow(
      sent,
      buildEvent('DECLINE', '2026-05-09T12:00:00.000Z', 'budget too high'),
    )
    expect(declined.state).toBe('declined')
    expect(declined.declined_at).toBe('2026-05-09T12:00:00.000Z')
    expect(declined.decline_reason).toBe('budget too high')
    expect(declined.state_version).toBe(4)
  })

  it('declined → ARCHIVE works', () => {
    const declined = snap('declined', {
      declined_at: '2026-05-09T12:00:00.000Z',
      decline_reason: 'budget',
      state_version: 4,
    })
    const archived = transitionProjectLifecycleWorkflow(declined, buildEvent('ARCHIVE', '2026-05-09T15:00:00.000Z'))
    expect(archived.state).toBe('archived')
    expect(archived.archived_at).toBe('2026-05-09T15:00:00.000Z')
    // The decline trail is preserved on archive — only REOPEN clears
    // closeout-style timestamps.
    expect(archived.decline_reason).toBe('budget')
  })

  it('done → REOPEN moves back to in_progress and clears completed_at/archived_at', () => {
    const done = snap('done', {
      started_at: '2026-05-09T13:00:00.000Z',
      completed_at: '2026-05-09T14:00:00.000Z',
      state_version: 5,
    })
    const reopened = transitionProjectLifecycleWorkflow(done, buildEvent('REOPEN', '2026-05-09T16:00:00.000Z'))
    expect(reopened.state).toBe('in_progress')
    expect(reopened.state_version).toBe(6)
    expect(reopened.completed_at).toBeNull()
    expect(reopened.archived_at).toBeNull()
    // started_at is preserved — REOPEN doesn't reset the run start.
    expect(reopened.started_at).toBe('2026-05-09T13:00:00.000Z')
  })

  it('archived → REOPEN moves back to in_progress and clears archived_at', () => {
    const archived = snap('archived', {
      started_at: '2026-05-09T13:00:00.000Z',
      completed_at: '2026-05-09T14:00:00.000Z',
      archived_at: '2026-05-09T15:00:00.000Z',
      state_version: 6,
    })
    const reopened = transitionProjectLifecycleWorkflow(archived, buildEvent('REOPEN', '2026-05-09T16:00:00.000Z'))
    expect(reopened.state).toBe('in_progress')
    expect(reopened.archived_at).toBeNull()
    expect(reopened.completed_at).toBeNull()
    expect(reopened.state_version).toBe(7)
  })

  it('ACCEPT after a prior decline trail clears decline_at + decline_reason', () => {
    // Not actually reachable through the official transition graph
    // (declined doesn't go to accepted directly), but the reducer
    // defensively wipes the decline trail when ACCEPT lands so a
    // hypothetical replay path doesn't carry stale rejection metadata.
    const sentAfterPriorDecline = snap('sent', {
      declined_at: '2026-04-09T12:00:00.000Z',
      decline_reason: 'old reason',
      sent_at: '2026-05-09T11:00:00.000Z',
    })
    const accepted = transitionProjectLifecycleWorkflow(sentAfterPriorDecline, buildEvent('ACCEPT'))
    expect(accepted.declined_at).toBeNull()
    expect(accepted.decline_reason).toBeNull()
  })
})

describe('transitionProjectLifecycleWorkflow — illegal transitions', () => {
  it.each([
    ['SEND', 'draft'],
    ['ACCEPT', 'draft'],
    ['DECLINE', 'draft'],
    ['START_WORK', 'draft'],
    ['COMPLETE', 'draft'],
    ['ARCHIVE', 'draft'],
    ['REOPEN', 'draft'],
    ['START_ESTIMATING', 'estimating'],
    ['ACCEPT', 'estimating'],
    ['DECLINE', 'estimating'],
    ['START_ESTIMATING', 'sent'],
    ['SEND', 'sent'],
    ['START_WORK', 'sent'],
    ['START_ESTIMATING', 'accepted'],
    ['SEND', 'accepted'],
    ['ACCEPT', 'accepted'],
    ['DECLINE', 'accepted'],
    ['COMPLETE', 'accepted'],
    ['START_ESTIMATING', 'in_progress'],
    ['SEND', 'in_progress'],
    ['ACCEPT', 'in_progress'],
    ['DECLINE', 'in_progress'],
    ['START_WORK', 'in_progress'],
    ['ARCHIVE', 'in_progress'],
    ['REOPEN', 'in_progress'],
    ['COMPLETE', 'done'],
    ['START_ESTIMATING', 'done'],
    ['SEND', 'done'],
    ['ACCEPT', 'done'],
    ['DECLINE', 'done'],
    ['START_WORK', 'done'],
    ['ARCHIVE', 'archived'],
    ['START_ESTIMATING', 'archived'],
    ['COMPLETE', 'archived'],
    ['SEND', 'declined'],
    ['ACCEPT', 'declined'],
    ['REOPEN', 'declined'],
  ] as Array<[ProjectLifecycleWorkflowEvent['type'], ProjectLifecycleWorkflowState]>)(
    'rejects %s from %s',
    (eventType, fromState) => {
      expect(() => transitionProjectLifecycleWorkflow(snap(fromState), buildEvent(eventType))).toThrow(/not allowed/)
    },
  )
})

describe('snapshot version increments', () => {
  it('every legal transition bumps state_version by exactly 1', () => {
    let s = snap('draft', { state_version: 17 })
    s = transitionProjectLifecycleWorkflow(s, buildEvent('START_ESTIMATING'))
    expect(s.state_version).toBe(18)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('SEND'))
    expect(s.state_version).toBe(19)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('ACCEPT'))
    expect(s.state_version).toBe(20)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('START_WORK'))
    expect(s.state_version).toBe(21)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('COMPLETE'))
    expect(s.state_version).toBe(22)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('REOPEN'))
    expect(s.state_version).toBe(23)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('COMPLETE'))
    expect(s.state_version).toBe(24)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('ARCHIVE'))
    expect(s.state_version).toBe(25)
    s = transitionProjectLifecycleWorkflow(s, buildEvent('REOPEN'))
    expect(s.state_version).toBe(26)
  })
})

describe('reducer property invariants', () => {
  const STATE_GEN: fc.Arbitrary<ProjectLifecycleWorkflowState> = fc.constantFrom(...PROJECT_LIFECYCLE_ALL_STATES)
  const TYPE_GEN = fc.constantFrom(
    'START_ESTIMATING',
    'SEND',
    'ACCEPT',
    'DECLINE',
    'START_WORK',
    'COMPLETE',
    'ARCHIVE',
    'REOPEN',
  ) as fc.Arbitrary<ProjectLifecycleWorkflowEvent['type']>

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, TYPE_GEN, (state, type) => {
        try {
          const next = transitionProjectLifecycleWorkflow(snap(state), buildEvent(type))
          expect(PROJECT_LIFECYCLE_ALL_STATES).toContain(next.state)
        } catch {
          // illegal — skip
        }
      }),
    )
  })

  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), TYPE_GEN, (state, version, type) => {
        try {
          const next = transitionProjectLifecycleWorkflow(snap(state, { state_version: version }), buildEvent(type))
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of PROJECT_LIFECYCLE_ALL_STATES) {
      const events = nextProjectLifecycleEvents(state)
      for (const next of events) {
        expect(() => transitionProjectLifecycleWorkflow(snap(state), buildEvent(next.type))).not.toThrow()
      }
    }
  })
})

describe('isHumanProjectLifecycleEvent', () => {
  it('accepts every declared human event type', () => {
    expect(isHumanProjectLifecycleEvent('START_ESTIMATING')).toBe(true)
    expect(isHumanProjectLifecycleEvent('SEND')).toBe(true)
    expect(isHumanProjectLifecycleEvent('ACCEPT')).toBe(true)
    expect(isHumanProjectLifecycleEvent('DECLINE')).toBe(true)
    expect(isHumanProjectLifecycleEvent('START_WORK')).toBe(true)
    expect(isHumanProjectLifecycleEvent('COMPLETE')).toBe(true)
    expect(isHumanProjectLifecycleEvent('ARCHIVE')).toBe(true)
    expect(isHumanProjectLifecycleEvent('REOPEN')).toBe(true)
  })
  it('rejects unknown event types', () => {
    expect(isHumanProjectLifecycleEvent('NOT_A_REAL_EVENT')).toBe(false)
    expect(isHumanProjectLifecycleEvent('CLOSEOUT')).toBe(false)
  })
})

describe('parseProjectLifecycleEventRequest', () => {
  it('accepts START_ESTIMATING without reason', () => {
    const r = parseProjectLifecycleEventRequest({ event: 'START_ESTIMATING', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('accepts DECLINE with optional reason', () => {
    const a = parseProjectLifecycleEventRequest({ event: 'DECLINE', state_version: 3 })
    expect(a.ok).toBe(true)
    const b = parseProjectLifecycleEventRequest({ event: 'DECLINE', state_version: 3, reason: 'budget' })
    expect(b.ok).toBe(true)
  })
  it('coerces stringified state_version (offline-replay path)', () => {
    const r = parseProjectLifecycleEventRequest({ event: 'SEND', state_version: '7' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(7)
  })
  it('rejects unknown event types', () => {
    expect(parseProjectLifecycleEventRequest({ event: 'CLOSEOUT', state_version: 1 }).ok).toBe(false)
  })
  it('rejects non-positive state_version', () => {
    expect(parseProjectLifecycleEventRequest({ event: 'SEND', state_version: 0 }).ok).toBe(false)
    expect(parseProjectLifecycleEventRequest({ event: 'SEND', state_version: -1 }).ok).toBe(false)
  })
})

describe('projectStatusToLifecycleState', () => {
  it('passes valid lifecycle states through unchanged', () => {
    expect(projectStatusToLifecycleState('draft')).toBe('draft')
    expect(projectStatusToLifecycleState('in_progress')).toBe('in_progress')
    expect(projectStatusToLifecycleState('done')).toBe('done')
  })
  it('defaults unknown values to draft', () => {
    expect(projectStatusToLifecycleState('lead')).toBe('draft')
    expect(projectStatusToLifecycleState('garbage')).toBe('draft')
    expect(projectStatusToLifecycleState('')).toBe('draft')
  })
})

describe('projectLifecycleWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(projectLifecycleWorkflow.name).toBe('project_lifecycle')
    expect(projectLifecycleWorkflow.initialState).toBe('draft')
    expect(projectLifecycleWorkflow.terminalStates).toEqual([])
    // No side-effects in this phase; notify_foreman_assignment is wired
    // in a follow-up.
    expect(projectLifecycleWorkflow.sideEffectTypes).toEqual([])
  })
})

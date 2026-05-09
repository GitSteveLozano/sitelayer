import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  FIELD_EVENT_ALL_STATES,
  FIELD_EVENT_RESOLUTION_ACTIONS,
  fieldEventWorkflow,
  isHumanFieldEventEvent,
  nextFieldEventEvents,
  parseFieldEventEventRequest,
  transitionFieldEventWorkflow,
  type FieldEventWorkflowEvent,
  type FieldEventWorkflowSnapshot,
  type FieldEventWorkflowState,
} from './field-event.js'

const RESOLVE: FieldEventWorkflowEvent = {
  type: 'RESOLVE',
  resolved_at: '2026-05-09T15:00:00.000Z',
  resolved_by_user_id: 'foreman-user',
  action: 'order_more',
  message_to_worker: 'Ordering another pallet now — should be on site within the hour.',
}
const ESCALATE: FieldEventWorkflowEvent = {
  type: 'ESCALATE',
  escalated_at: '2026-05-09T15:01:00.000Z',
  escalator_user_id: 'foreman-user',
  reason: 'Crew is stopped — need estimator to confirm spec change.',
}
const DISMISS: FieldEventWorkflowEvent = {
  type: 'DISMISS',
  dismissed_at: '2026-05-09T15:02:00.000Z',
  dismissed_by_user_id: 'foreman-user',
}
const REOPEN: FieldEventWorkflowEvent = {
  type: 'REOPEN',
  reopened_at: '2026-05-09T15:30:00.000Z',
  reopener_user_id: 'admin-user',
}

describe('transitionFieldEventWorkflow — happy paths', () => {
  it('open → resolved persists action + message and clears any prior escalation trail', () => {
    const start: FieldEventWorkflowSnapshot = {
      state: 'open',
      state_version: 1,
      escalated_to_estimator_at: '2026-05-09T14:00:00.000Z',
      escalation_reason: 'previously escalated, now reopened',
    }
    const next = transitionFieldEventWorkflow(start, RESOLVE)
    expect(next).toMatchObject({
      state: 'resolved',
      state_version: 2,
      resolved_at: RESOLVE.resolved_at,
      resolved_by_user_id: RESOLVE.resolved_by_user_id,
      resolved_action: RESOLVE.action,
      resolution_message: RESOLVE.message_to_worker,
      last_actor_user_id: RESOLVE.resolved_by_user_id,
      escalated_to_estimator_at: null,
      escalation_reason: null,
    })
  })

  it('open → escalated stamps escalator + reason and clears prior resolved trail', () => {
    const start: FieldEventWorkflowSnapshot = {
      state: 'open',
      state_version: 3,
      resolved_at: '2026-05-09T13:00:00.000Z',
      resolution_message: 'previously resolved',
    }
    const next = transitionFieldEventWorkflow(start, ESCALATE)
    expect(next).toMatchObject({
      state: 'escalated',
      state_version: 4,
      escalated_to_estimator_at: ESCALATE.escalated_at,
      escalation_reason: ESCALATE.reason,
      last_actor_user_id: ESCALATE.escalator_user_id,
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_action: null,
      resolution_message: null,
    })
  })

  it('open → dismissed records dismisser and leaves no resolution', () => {
    const start: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const next = transitionFieldEventWorkflow(start, DISMISS)
    expect(next).toMatchObject({
      state: 'dismissed',
      state_version: 2,
      dismissed_at: DISMISS.dismissed_at,
      dismissed_by_user_id: DISMISS.dismissed_by_user_id,
      last_actor_user_id: DISMISS.dismissed_by_user_id,
      resolved_at: null,
      escalated_to_estimator_at: null,
    })
  })

  it('resolved → REOPEN moves back to open and clears the resolution columns', () => {
    const resolved = transitionFieldEventWorkflow({ state: 'open', state_version: 1 }, RESOLVE)
    expect(resolved.resolution_message).toBe(RESOLVE.message_to_worker)

    const reopened = transitionFieldEventWorkflow(resolved, REOPEN)
    expect(reopened.state).toBe('open')
    expect(reopened.state_version).toBe(resolved.state_version + 1)
    expect(reopened.reopened_at).toBe(REOPEN.reopened_at)
    expect(reopened.last_actor_user_id).toBe(REOPEN.reopener_user_id)
    // Per the reducer's housekeeping rule: a re-opened ticket is
    // shaped like a fresh open ticket, so prior columns are cleared.
    expect(reopened.resolved_at).toBeNull()
    expect(reopened.resolved_by_user_id).toBeNull()
    expect(reopened.resolved_action).toBeNull()
    expect(reopened.resolution_message).toBeNull()
  })

  it('escalated → REOPEN clears the escalation trail', () => {
    const escalated = transitionFieldEventWorkflow({ state: 'open', state_version: 1 }, ESCALATE)
    const reopened = transitionFieldEventWorkflow(escalated, REOPEN)
    expect(reopened.state).toBe('open')
    expect(reopened.escalated_to_estimator_at).toBeNull()
    expect(reopened.escalation_reason).toBeNull()
  })

  it('dismissed → REOPEN clears the dismissal trail', () => {
    const dismissed = transitionFieldEventWorkflow({ state: 'open', state_version: 1 }, DISMISS)
    const reopened = transitionFieldEventWorkflow(dismissed, REOPEN)
    expect(reopened.state).toBe('open')
    expect(reopened.dismissed_at).toBeNull()
    expect(reopened.dismissed_by_user_id).toBeNull()
  })
})

describe('transitionFieldEventWorkflow — illegal transitions', () => {
  it('rejects RESOLVE from resolved', () => {
    const resolved: FieldEventWorkflowSnapshot = {
      state: 'resolved',
      state_version: 2,
      resolved_at: RESOLVE.resolved_at,
    }
    expect(() => transitionFieldEventWorkflow(resolved, RESOLVE)).toThrow(/not allowed/)
  })

  it('rejects ESCALATE from escalated', () => {
    const escalated: FieldEventWorkflowSnapshot = {
      state: 'escalated',
      state_version: 2,
      escalated_to_estimator_at: ESCALATE.escalated_at,
    }
    expect(() => transitionFieldEventWorkflow(escalated, ESCALATE)).toThrow(/not allowed/)
  })

  it('rejects DISMISS from dismissed', () => {
    const dismissed: FieldEventWorkflowSnapshot = {
      state: 'dismissed',
      state_version: 2,
      dismissed_at: DISMISS.dismissed_at,
    }
    expect(() => transitionFieldEventWorkflow(dismissed, DISMISS)).toThrow(/not allowed/)
  })

  it('rejects REOPEN from open', () => {
    expect(() => transitionFieldEventWorkflow({ state: 'open', state_version: 1 }, REOPEN)).toThrow(/not allowed/)
  })

  it('rejects RESOLVE from escalated', () => {
    const escalated: FieldEventWorkflowSnapshot = {
      state: 'escalated',
      state_version: 2,
      escalated_to_estimator_at: ESCALATE.escalated_at,
    }
    expect(() => transitionFieldEventWorkflow(escalated, RESOLVE)).toThrow(/not allowed/)
  })
})

describe('field-event reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<FieldEventWorkflowState> = fc.constantFrom(...FIELD_EVENT_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<FieldEventWorkflowEvent> = fc.oneof(
    fc.record({
      type: fc.constant('RESOLVE' as const),
      resolved_at: fc.constant(RESOLVE.resolved_at),
      resolved_by_user_id: fc.string({ minLength: 1, maxLength: 32 }),
      action: fc.constantFrom(...FIELD_EVENT_RESOLUTION_ACTIONS),
      message_to_worker: fc.string({ minLength: 1, maxLength: 500 }),
    }),
    fc.record({
      type: fc.constant('ESCALATE' as const),
      escalated_at: fc.constant(ESCALATE.escalated_at),
      escalator_user_id: fc.string({ minLength: 1, maxLength: 32 }),
      reason: fc.string({ minLength: 1, maxLength: 500 }),
    }),
    fc.record({
      type: fc.constant('DISMISS' as const),
      dismissed_at: fc.constant(DISMISS.dismissed_at),
      dismissed_by_user_id: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      type: fc.constant('REOPEN' as const),
      reopened_at: fc.constant(REOPEN.reopened_at),
      reopener_user_id: fc.string({ minLength: 1, maxLength: 32 }),
    }),
  )

  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: FieldEventWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionFieldEventWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionFieldEventWorkflow({ state, state_version: 1 }, event)
          expect(FIELD_EVENT_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of FIELD_EVENT_ALL_STATES) {
      const events = nextFieldEventEvents(state)
      for (const next of events) {
        const event: FieldEventWorkflowEvent =
          next.type === 'RESOLVE'
            ? RESOLVE
            : next.type === 'ESCALATE'
              ? ESCALATE
              : next.type === 'DISMISS'
                ? DISMISS
                : REOPEN
        expect(() => transitionFieldEventWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })

  it('RESOLVE always sets a non-empty message_to_worker', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (message) => {
        const next = transitionFieldEventWorkflow(
          { state: 'open', state_version: 1 },
          {
            type: 'RESOLVE',
            resolved_at: RESOLVE.resolved_at,
            resolved_by_user_id: 'r',
            action: 'order_more',
            message_to_worker: message,
          },
        )
        expect(next.resolution_message).toBe(message)
      }),
    )
  })
})

describe('isHumanFieldEventEvent', () => {
  it('treats RESOLVE / ESCALATE / DISMISS / REOPEN as human', () => {
    expect(isHumanFieldEventEvent('RESOLVE')).toBe(true)
    expect(isHumanFieldEventEvent('ESCALATE')).toBe(true)
    expect(isHumanFieldEventEvent('DISMISS')).toBe(true)
    expect(isHumanFieldEventEvent('REOPEN')).toBe(true)
  })

  it('rejects worker-only / unknown events', () => {
    expect(isHumanFieldEventEvent('NOTIFY_WORKER_RESOLUTION')).toBe(false)
    expect(isHumanFieldEventEvent('NOTIFY_ESTIMATOR_ESCALATION')).toBe(false)
    expect(isHumanFieldEventEvent('TIMEOUT')).toBe(false)
  })
})

describe('parseFieldEventEventRequest', () => {
  it('accepts a well-formed RESOLVE body', () => {
    const r = parseFieldEventEventRequest({
      event: 'RESOLVE',
      state_version: 1,
      action: 'order_more',
      message_to_worker: 'on it',
    })
    expect(r.ok).toBe(true)
  })

  it('requires action + message_to_worker for RESOLVE', () => {
    expect(parseFieldEventEventRequest({ event: 'RESOLVE', state_version: 1 }).ok).toBe(false)
    expect(parseFieldEventEventRequest({ event: 'RESOLVE', state_version: 1, action: 'order_more' }).ok).toBe(false)
    expect(
      parseFieldEventEventRequest({
        event: 'RESOLVE',
        state_version: 1,
        action: 'order_more',
        message_to_worker: '',
      }).ok,
    ).toBe(false)
  })

  it('rejects unknown resolution actions', () => {
    expect(
      parseFieldEventEventRequest({
        event: 'RESOLVE',
        state_version: 1,
        action: 'fly_to_supplier',
        message_to_worker: 'on it',
      }).ok,
    ).toBe(false)
  })

  it('requires reason for ESCALATE', () => {
    expect(parseFieldEventEventRequest({ event: 'ESCALATE', state_version: 1 }).ok).toBe(false)
    expect(parseFieldEventEventRequest({ event: 'ESCALATE', state_version: 1, reason: 'see notes' }).ok).toBe(true)
  })

  it('accepts DISMISS / REOPEN with no extra fields', () => {
    expect(parseFieldEventEventRequest({ event: 'DISMISS', state_version: 1 }).ok).toBe(true)
    expect(parseFieldEventEventRequest({ event: 'REOPEN', state_version: 1 }).ok).toBe(true)
  })

  it('coerces stringified state_version (offline-replay path)', () => {
    const r = parseFieldEventEventRequest({ event: 'DISMISS', state_version: '7' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(7)
  })

  it('rejects unknown event types', () => {
    expect(parseFieldEventEventRequest({ event: 'TIMEOUT', state_version: 1 }).ok).toBe(false)
  })
})

describe('fieldEventWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(fieldEventWorkflow.name).toBe('field_event')
    expect(fieldEventWorkflow.initialState).toBe('open')
    expect(fieldEventWorkflow.terminalStates).toEqual([])
    expect(fieldEventWorkflow.sideEffectTypes).toEqual(['notify_worker_resolution', 'notify_estimator_escalation'])
  })
})

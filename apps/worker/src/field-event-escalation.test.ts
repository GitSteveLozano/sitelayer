import { describe, expect, it } from 'vitest'
import {
  FIELD_EVENT_WORKFLOW_NAME,
  FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  transitionFieldEventWorkflow,
  type FieldEventWorkflowSnapshot,
} from '@sitelayer/workflows'

/**
 * Lock the contract this module relies on: the reducer accepts a
 * minimal snapshot and an ESCALATE event with the system-actor id, and
 * advances the state machine without throwing. The actual DB-driven
 * `processFieldEventAutoEscalation` is gated on integration tests
 * (RUN_API_INTEGRATION=1); this test runs at the reducer boundary.
 */
describe('field-event auto-escalation contract', () => {
  it('reducer accepts a minimal snapshot + ESCALATE event with system actor', () => {
    const snapshot: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const next = transitionFieldEventWorkflow(snapshot, {
      type: 'ESCALATE',
      escalated_at: '2026-05-16T12:00:00.000Z',
      escalator_user_id: 'system:auto-escalation',
      reason: 'auto_15min_stopped',
    })
    expect(next.state).toBe('escalated')
    expect(next.state_version).toBe(2)
    expect(next.escalated_to_estimator_at).toBe('2026-05-16T12:00:00.000Z')
    expect(next.escalation_reason).toBe('auto_15min_stopped')
    expect(next.last_actor_user_id).toBe('system:auto-escalation')
  })

  it('refuses ESCALATE from a non-open state (the worker query filters but defense-in-depth holds)', () => {
    const snapshot: FieldEventWorkflowSnapshot = { state: 'resolved', state_version: 5 }
    expect(() =>
      transitionFieldEventWorkflow(snapshot, {
        type: 'ESCALATE',
        escalated_at: '2026-05-16T12:00:00.000Z',
        escalator_user_id: 'system:auto-escalation',
        reason: 'auto_15min_stopped',
      }),
    ).toThrow(/not allowed/)
  })

  it('exposes the workflow constants the worker uses for event-log writes', () => {
    expect(FIELD_EVENT_WORKFLOW_NAME).toBe('field_event')
    expect(FIELD_EVENT_WORKFLOW_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})

import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  FIELD_EVENT_WORKFLOW_NAME,
  FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  transitionFieldEventWorkflow,
  type FieldEventWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = FIELD_EVENT_WORKFLOW_NAME
const SCHEMA = FIELD_EVENT_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000050'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: FieldEventWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version,
    event_payload,
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('field-event — applyEventLog replay', () => {
  it('happy path: open → resolved', () => {
    const initial: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const resolveEvent = {
      type: 'RESOLVE' as const,
      resolved_at: '2026-05-01T11:00:00.000Z',
      resolved_by_user_id: 'foreman-1',
      action: 'order_more' as const,
      message_to_worker: 'will order more by end of day',
    }
    const resolved = transitionFieldEventWorkflow(initial, resolveEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, resolveEvent, resolved)]
    const result = applyEventLog<FieldEventWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('resolved')
  })

  it('alternate path: open → escalated → reopen → open → dismissed', () => {
    let snap: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const escalateEvent = {
      type: 'ESCALATE' as const,
      escalated_at: '2026-05-01T11:30:00.000Z',
      escalator_user_id: 'foreman-1',
      reason: 'design conflict',
    }
    let prev = snap
    snap = transitionFieldEventWorkflow(prev, escalateEvent)
    log.push(entry(1, escalateEvent, snap))

    const reopenEvent = {
      type: 'REOPEN' as const,
      reopened_at: '2026-05-01T12:00:00.000Z',
      reopener_user_id: 'admin',
    }
    prev = snap
    snap = transitionFieldEventWorkflow(prev, reopenEvent)
    log.push(entry(2, reopenEvent, snap))

    const dismissEvent = {
      type: 'DISMISS' as const,
      dismissed_at: '2026-05-01T13:00:00.000Z',
      dismissed_by_user_id: 'foreman-1',
    }
    prev = snap
    snap = transitionFieldEventWorkflow(prev, dismissEvent)
    log.push(entry(3, dismissEvent, snap))

    const initial: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const result = applyEventLog<FieldEventWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('dismissed')
  })
})

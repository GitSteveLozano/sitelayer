import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  CHANGE_ORDER_ALL_STATES,
  CHANGE_ORDER_WORKFLOW_NAME,
  CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION,
  nextChangeOrderEvents,
  transitionChangeOrderWorkflow,
  type ChangeOrderWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = CHANGE_ORDER_WORKFLOW_NAME
const SCHEMA = CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000097'
const AT = '2026-05-28T12:00:00.000Z'

describe('change-order — golden next_events map', () => {
  it('freezes the per-state next_events affordance set', () => {
    const map = Object.fromEntries(CHANGE_ORDER_ALL_STATES.map((s) => [s, nextChangeOrderEvents(s)]))
    expect(map).toMatchInlineSnapshot(`
      {
        "accepted": [],
        "draft": [
          {
            "label": "Send to client",
            "type": "SEND",
          },
          {
            "label": "Void",
            "type": "VOID",
          },
        ],
        "rejected": [],
        "sent": [
          {
            "label": "Mark accepted",
            "type": "ACCEPT",
          },
          {
            "label": "Mark rejected",
            "type": "REJECT",
          },
          {
            "label": "Void",
            "type": "VOID",
          },
        ],
        "voided": [],
      }
    `)
  })
})

describe('change-order — applyEventLog replay', () => {
  it('happy path: draft → sent → accepted', () => {
    const initial: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const sendEvent = { type: 'SEND' as const, occurred_at: AT }
    const sent = transitionChangeOrderWorkflow(initial, sendEvent)
    const acceptEvent = { type: 'ACCEPT' as const, occurred_at: AT, actor_user_id: 'office-user' }
    const accepted = transitionChangeOrderWorkflow(sent, acceptEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: sendEvent,
        snapshot_after: sent as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: acceptEvent,
        snapshot_after: accepted as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<ChangeOrderWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('accepted')
    expect(result.finalSnapshot?.state_version).toBe(3)
    expect(result.finalSnapshot?.approved_by).toBe('office-user')
  })

  it('alternate path: draft → sent → rejected with reason that survives', () => {
    const initial: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const sendEvent = { type: 'SEND' as const, occurred_at: AT }
    const sent = transitionChangeOrderWorkflow(initial, sendEvent)
    const rejectEvent = { type: 'REJECT' as const, occurred_at: AT, reason: 'over budget' }
    const rejected = transitionChangeOrderWorkflow(sent, rejectEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: sendEvent,
        snapshot_after: sent as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: rejectEvent,
        snapshot_after: rejected as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<ChangeOrderWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('rejected')
    expect(result.finalSnapshot?.reject_reason).toBe('over budget')
  })

  it('void path: draft → voided', () => {
    const initial: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const voidEvent = { type: 'VOID' as const, occurred_at: AT }
    const voided = transitionChangeOrderWorkflow(initial, voidEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: voidEvent,
        snapshot_after: voided as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<ChangeOrderWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('voided')
    expect(result.finalSnapshot?.voided_at).toBe(AT)
  })
})

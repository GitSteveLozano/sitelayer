import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
  RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalRequestApprovalWorkflow,
  type RentalRequestApprovalWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME
const SCHEMA = RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000110'

describe('rental-request-approval — applyEventLog replay', () => {
  it('happy path: pending → approved', () => {
    const initial: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-05-01T09:00:00.000Z',
      approved_by: 'office-user',
    }
    const approved = transitionRentalRequestApprovalWorkflow(initial, approveEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: approveEvent,
        snapshot_after: approved as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<RentalRequestApprovalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('approved')
  })

  it('alternate path: pending → declined with reason', () => {
    const initial: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const declineEvent = {
      type: 'DECLINE' as const,
      declined_at: '2026-05-01T09:00:00.000Z',
      declined_by: 'office-user',
      decline_reason: 'inventory unavailable',
    }
    const declined = transitionRentalRequestApprovalWorkflow(initial, declineEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: declineEvent,
        snapshot_after: declined as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<RentalRequestApprovalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('declined')
    expect(result.finalSnapshot?.decline_reason).toBe('inventory unavailable')
  })
})

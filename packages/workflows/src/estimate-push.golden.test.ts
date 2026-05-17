import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  ESTIMATE_PUSH_WORKFLOW_NAME,
  ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
  transitionEstimatePushWorkflow,
  type EstimatePushWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = ESTIMATE_PUSH_WORKFLOW_NAME
const SCHEMA = ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000010'

describe('estimate-push — applyEventLog replay', () => {
  it('happy path: drafted → reviewed → approved → posting → posted', () => {
    const initial: EstimatePushWorkflowSnapshot = { state: 'drafted', state_version: 1 }
    const reviewEvent = {
      type: 'REVIEW' as const,
      reviewed_at: '2026-04-29T09:00:00.000Z',
      reviewed_by: 'office-user',
    }
    const reviewed = transitionEstimatePushWorkflow(initial, reviewEvent)
    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'admin-user',
    }
    const approved = transitionEstimatePushWorkflow(reviewed, approveEvent)
    const posting = transitionEstimatePushWorkflow(approved, { type: 'POST_REQUESTED' })
    const succeededEvent = {
      type: 'POST_SUCCEEDED' as const,
      posted_at: '2026-04-29T10:01:00.000Z',
      qbo_estimate_id: 'qbo-est-123',
    }
    const posted = transitionEstimatePushWorkflow(posting, succeededEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: reviewEvent,
        snapshot_after: reviewed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: approveEvent,
        snapshot_after: approved as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 3,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: posting as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 4,
        event_payload: succeededEvent,
        snapshot_after: posted as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<EstimatePushWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot).toEqual(posted)
  })

  it('alternate path: ends in voided', () => {
    const initial: EstimatePushWorkflowSnapshot = { state: 'drafted', state_version: 1 }
    const voided = transitionEstimatePushWorkflow(initial, { type: 'VOID' })

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: { type: 'VOID' },
        snapshot_after: voided as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<EstimatePushWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('voided')
  })

  it('alternate path: failure → retry → re-post → posted', () => {
    const initial: EstimatePushWorkflowSnapshot = { state: 'drafted', state_version: 1 }
    const reviewEvent = {
      type: 'REVIEW' as const,
      reviewed_at: '2026-04-29T09:00:00.000Z',
      reviewed_by: 'office',
    }
    const reviewed = transitionEstimatePushWorkflow(initial, reviewEvent)
    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'admin',
    }
    const approved = transitionEstimatePushWorkflow(reviewed, approveEvent)
    const posting1 = transitionEstimatePushWorkflow(approved, { type: 'POST_REQUESTED' })
    const failEvent = {
      type: 'POST_FAILED' as const,
      failed_at: '2026-04-29T10:01:00.000Z',
      error: 'qbo timeout',
    }
    const failed = transitionEstimatePushWorkflow(posting1, failEvent)
    const reapproved = transitionEstimatePushWorkflow(failed, { type: 'RETRY_POST' })
    const posting2 = transitionEstimatePushWorkflow(reapproved, { type: 'POST_REQUESTED' })
    const succeededEvent = {
      type: 'POST_SUCCEEDED' as const,
      posted_at: '2026-04-29T10:02:00.000Z',
      qbo_estimate_id: 'qbo-est-999',
    }
    const posted = transitionEstimatePushWorkflow(posting2, succeededEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: reviewEvent,
        snapshot_after: reviewed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: approveEvent,
        snapshot_after: approved as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 3,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: posting1 as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 4,
        event_payload: failEvent,
        snapshot_after: failed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 5,
        event_payload: { type: 'RETRY_POST' },
        snapshot_after: reapproved as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 6,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: posting2 as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 7,
        event_payload: succeededEvent,
        snapshot_after: posted as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<EstimatePushWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot).toEqual(posted)
  })
})

import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  TIME_REVIEW_WORKFLOW_NAME,
  TIME_REVIEW_WORKFLOW_SCHEMA_VERSION,
  transitionTimeReviewWorkflow,
  type TimeReviewWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = TIME_REVIEW_WORKFLOW_NAME
const SCHEMA = TIME_REVIEW_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000040'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: TimeReviewWorkflowSnapshot,
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

describe('time-review — applyEventLog replay', () => {
  it('happy path: pending → approved', () => {
    const initial: TimeReviewWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-05-01T17:30:00.000Z',
      reviewer_user_id: 'foreman-1',
    }
    const approved = transitionTimeReviewWorkflow(initial, approveEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, approveEvent, approved)]
    const result = applyEventLog<TimeReviewWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('approved')
    expect(result.finalSnapshot?.reviewer_user_id).toBe('foreman-1')
  })

  it('alternate path: pending → rejected → reopen → pending', () => {
    let snap: TimeReviewWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const rejectEvent = {
      type: 'REJECT' as const,
      rejected_at: '2026-05-01T17:31:00.000Z',
      reviewer_user_id: 'foreman-1',
      reason: 'wrong project allocation',
    }
    let prev = snap
    snap = transitionTimeReviewWorkflow(prev, rejectEvent)
    log.push(entry(1, rejectEvent, snap))

    const reopenEvent = {
      type: 'REOPEN' as const,
      reopened_at: '2026-05-02T09:00:00.000Z',
      reviewer_user_id: 'office-user',
      reason: 'crew corrected hours',
    }
    prev = snap
    snap = transitionTimeReviewWorkflow(prev, reopenEvent)
    log.push(entry(2, reopenEvent, snap))

    const initial: TimeReviewWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const result = applyEventLog<TimeReviewWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('pending')
    expect(result.finalSnapshot?.rejected_at).toBeNull()
  })
})

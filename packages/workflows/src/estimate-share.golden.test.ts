import { describe, expect, it } from 'vitest'
import {
  applyEventLog,
  ESTIMATE_SHARE_WORKFLOW_NAME,
  ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION,
  transitionEstimateShareWorkflow,
  type EstimateShareWorkflowEvent,
  type EstimateShareWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = ESTIMATE_SHARE_WORKFLOW_NAME
const SCHEMA = ESTIMATE_SHARE_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000020'

function entry(
  stateVersion: number,
  payload: EstimateShareWorkflowEvent,
  after: EstimateShareWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version: stateVersion,
    event_payload: payload,
    snapshot_after: after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('estimate-share — applyEventLog replay', () => {
  it('happy path: sent → viewed → accepted', () => {
    const initial: EstimateShareWorkflowSnapshot = { state: 'sent', state_version: 1, view_count: 0 }
    const viewEvent = { type: 'VIEW' as const, viewed_at: '2026-05-01T10:00:00.000Z' }
    const viewed = transitionEstimateShareWorkflow(initial, viewEvent)
    const acceptEvent = { type: 'ACCEPT' as const, accepted_at: '2026-05-01T11:00:00.000Z', signer_name: 'Jane' }
    const accepted = transitionEstimateShareWorkflow(viewed, acceptEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, viewEvent, viewed), entry(2, acceptEvent, accepted)]
    const result = applyEventLog<EstimateShareWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot).toEqual(accepted)
  })

  it('alternate path: sent → viewed → declined', () => {
    const initial: EstimateShareWorkflowSnapshot = { state: 'sent', state_version: 1, view_count: 0 }
    const viewEvent = { type: 'VIEW' as const, viewed_at: '2026-05-01T10:00:00.000Z' }
    const viewed = transitionEstimateShareWorkflow(initial, viewEvent)
    const declineEvent = { type: 'DECLINE' as const, declined_at: '2026-05-01T11:00:00.000Z', decline_reason: 'no' }
    const declined = transitionEstimateShareWorkflow(viewed, declineEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, viewEvent, viewed), entry(2, declineEvent, declined)]
    const result = applyEventLog<EstimateShareWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('declined')
  })

  it('alternate path: sent → expired (worker sweep)', () => {
    const initial: EstimateShareWorkflowSnapshot = { state: 'sent', state_version: 1, view_count: 0 }
    const expireEvent = { type: 'EXPIRE' as const, expired_at: '2026-06-01T00:00:00.000Z' }
    const expired = transitionEstimateShareWorkflow(initial, expireEvent)

    const result = applyEventLog<EstimateShareWorkflowSnapshot>(initial, [entry(1, expireEvent, expired)])
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('expired')
  })

  it('alternate path: viewed → revoked (estimator)', () => {
    const initial: EstimateShareWorkflowSnapshot = { state: 'sent', state_version: 1, view_count: 0 }
    const viewEvent = { type: 'VIEW' as const, viewed_at: '2026-05-01T10:00:00.000Z' }
    const viewed = transitionEstimateShareWorkflow(initial, viewEvent)
    const revokeEvent = { type: 'REVOKE' as const, revoked_at: '2026-05-01T12:00:00.000Z', revoked_by: 'est-1' }
    const revoked = transitionEstimateShareWorkflow(viewed, revokeEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, viewEvent, viewed), entry(2, revokeEvent, revoked)]
    const result = applyEventLog<EstimateShareWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot).toEqual(revoked)
  })
})

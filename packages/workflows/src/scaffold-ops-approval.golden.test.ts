import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME,
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  transitionScaffoldOpsApprovalWorkflow,
  type ScaffoldOpsApprovalWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME
const SCHEMA = SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000120'

describe('scaffold-ops-approval — applyEventLog replay', () => {
  it('happy path: draft → approved', () => {
    const initial: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    }
    const approved = transitionScaffoldOpsApprovalWorkflow(initial, approveEvent)
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
    const result = applyEventLog<ScaffoldOpsApprovalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('approved')
  })

  it('alternate path: replay detects illegal_transition when log advances from terminal', () => {
    // Scaffold-ops has only one happy path. The alternate fixture
    // exercises the harness's illegal_transition branch by replaying
    // a second APPROVE from approved state.
    const initial: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'approved', state_version: 2 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: {
          type: 'APPROVE',
          approved_at: '2026-05-01T08:00:00.000Z',
          approved_by: 'admin-user',
        },
        snapshot_after: { state: 'approved', state_version: 3 },
      },
    ]
    const result = applyEventLog<ScaffoldOpsApprovalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('illegal_transition')
  })

  it('supersede path: draft → approved → superseded', () => {
    let snap: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    }
    let prev = snap
    snap = transitionScaffoldOpsApprovalWorkflow(snap, approveEvent)
    log.push({
      workflow_name: NAME,
      schema_version: SCHEMA,
      entity_id: ENTITY,
      state_version: prev.state_version,
      event_payload: approveEvent,
      snapshot_after: snap as unknown as WorkflowEventLogEntry['snapshot_after'],
    })

    const supersedeEvent = {
      type: 'SUPERSEDE' as const,
      superseded_at: '2026-05-02T07:00:00.000Z',
      superseded_by: 'admin-user',
      superseded_by_bom_id: '00000000-0000-0000-0000-000000000999',
    }
    prev = snap
    snap = transitionScaffoldOpsApprovalWorkflow(snap, supersedeEvent)
    log.push({
      workflow_name: NAME,
      schema_version: SCHEMA,
      entity_id: ENTITY,
      state_version: prev.state_version,
      event_payload: supersedeEvent,
      snapshot_after: snap as unknown as WorkflowEventLogEntry['snapshot_after'],
    })

    const result = applyEventLog<ScaffoldOpsApprovalWorkflowSnapshot>({ state: 'draft', state_version: 1 }, log)
    expect(result.ok, JSON.stringify(result.issues)).toBe(true)
    expect(result.finalSnapshot?.state).toBe('superseded')
    expect(result.finalSnapshot?.superseded_by_bom_id).toBe('00000000-0000-0000-0000-000000000999')
  })

  it('superseded is terminal — any further event is an illegal transition', () => {
    const initial: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'superseded', state_version: 3 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 3,
        event_payload: {
          type: 'SUPERSEDE',
          superseded_at: '2026-05-03T07:00:00.000Z',
          superseded_by: 'admin-user',
        },
        snapshot_after: { state: 'superseded', state_version: 4 },
      },
    ]
    const result = applyEventLog<ScaffoldOpsApprovalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('illegal_transition')
  })
})

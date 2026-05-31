import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  ASSET_DEPLOYMENT_WORKFLOW_NAME,
  ASSET_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION,
  transitionAssetDeploymentWorkflow,
  type AssetDeploymentWorkflowEvent,
  type AssetDeploymentWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = ASSET_DEPLOYMENT_WORKFLOW_NAME
const SCHEMA = ASSET_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000200'

function entry(
  state_version: number,
  event_payload: AssetDeploymentWorkflowEvent,
  snapshot_after: AssetDeploymentWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version,
    event_payload: event_payload as unknown as WorkflowEventLogEntry['event_payload'],
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('asset_deployment — applyEventLog replay', () => {
  it('happy path: staged → out → overdue → out → returning → returned', () => {
    let snap: AssetDeploymentWorkflowSnapshot = { state: 'staged', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const walk = (event: AssetDeploymentWorkflowEvent) => {
      const prev = snap
      snap = transitionAssetDeploymentWorkflow(prev, event)
      log.push(entry(prev.state_version, event, snap))
    }

    walk({
      type: 'DISPATCH',
      dispatched_at: '2026-04-15T08:00:00.000Z',
      project_id: 'proj-1',
      handoff_worker_id: 'worker-1',
      estimated_return_on: '2026-05-17',
      day_rate_cents: 8500,
    })
    walk({ type: 'MARK_OVERDUE', overdue_since: '2026-05-18T00:00:00.000Z' })
    walk({ type: 'EXTEND', estimated_return_on: '2026-05-31', extension_reason: 'job ran long' })
    walk({ type: 'BEGIN_RETURN', return_started_at: '2026-05-30T16:00:00.000Z' })
    walk({ type: 'COMPLETE_RETURN', returned_at: '2026-05-31T09:00:00.000Z', returned_by: 'yard-user', condition_grade: 'good' })

    const initial: AssetDeploymentWorkflowSnapshot = { state: 'staged', state_version: 1 }
    const result = applyEventLog<AssetDeploymentWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('returned')
    expect(result.finalSnapshot?.state_version).toBe(6)
  })

  it('write-off path: staged → out → written_off', () => {
    const initial: AssetDeploymentWorkflowSnapshot = { state: 'staged', state_version: 1 }
    const out = transitionAssetDeploymentWorkflow(initial, {
      type: 'DISPATCH',
      dispatched_at: '2026-04-15T08:00:00.000Z',
      project_id: 'proj-1',
    })
    const writtenOff = transitionAssetDeploymentWorkflow(out, {
      type: 'WRITE_OFF',
      written_off_at: '2026-05-01T00:00:00.000Z',
      written_off_by: 'admin',
      write_off_reason: 'destroyed on site',
    })
    const log: WorkflowEventLogEntry[] = [
      entry(1, { type: 'DISPATCH', dispatched_at: '2026-04-15T08:00:00.000Z', project_id: 'proj-1' }, out),
      entry(
        2,
        { type: 'WRITE_OFF', written_off_at: '2026-05-01T00:00:00.000Z', written_off_by: 'admin', write_off_reason: 'destroyed on site' },
        writtenOff,
      ),
    ]
    const result = applyEventLog<AssetDeploymentWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('written_off')
  })
})

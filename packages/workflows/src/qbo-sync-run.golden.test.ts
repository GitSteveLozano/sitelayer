import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  QBO_SYNC_RUN_WORKFLOW_NAME,
  QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
  transitionQboSyncRunWorkflow,
  type QboSyncRunWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = QBO_SYNC_RUN_WORKFLOW_NAME
const SCHEMA = QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000090'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: QboSyncRunWorkflowSnapshot,
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

describe('qbo-sync-run — applyEventLog replay', () => {
  it('happy path: pending → syncing → succeeded', () => {
    let snap: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const startEvent = {
      type: 'START_SYNC' as const,
      started_at: '2026-05-01T08:00:00.000Z',
      triggered_by: 'admin-user',
    }
    let prev = snap
    snap = transitionQboSyncRunWorkflow(prev, startEvent)
    log.push(entry(1, startEvent, snap))

    const succeededEvent = {
      type: 'SYNC_SUCCEEDED' as const,
      succeeded_at: '2026-05-01T08:01:00.000Z',
      snapshot: { syncedCustomers: 3 },
    }
    prev = snap
    snap = transitionQboSyncRunWorkflow(prev, succeededEvent)
    log.push(entry(2, succeededEvent, snap))

    const initial: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const result = applyEventLog<QboSyncRunWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('succeeded')
  })

  it('alternate path: syncing → failed → retry → syncing → succeeded', () => {
    let snap: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const startEvent = {
      type: 'START_SYNC' as const,
      started_at: '2026-05-01T08:00:00.000Z',
      triggered_by: 'admin',
    }
    let prev = snap
    snap = transitionQboSyncRunWorkflow(prev, startEvent)
    log.push(entry(1, startEvent, snap))

    const failEvent = {
      type: 'SYNC_FAILED' as const,
      failed_at: '2026-05-01T08:01:00.000Z',
      error: 'token expired',
    }
    prev = snap
    snap = transitionQboSyncRunWorkflow(prev, failEvent)
    log.push(entry(2, failEvent, snap))

    const retryEvent = {
      type: 'RETRY' as const,
      retried_at: '2026-05-01T08:02:00.000Z',
      triggered_by: 'admin',
    }
    prev = snap
    snap = transitionQboSyncRunWorkflow(prev, retryEvent)
    log.push(entry(3, retryEvent, snap))

    const restartEvent = {
      type: 'START_SYNC' as const,
      started_at: '2026-05-01T08:03:00.000Z',
    }
    prev = snap
    snap = transitionQboSyncRunWorkflow(prev, restartEvent)
    log.push(entry(4, restartEvent, snap))

    const succeededEvent = {
      type: 'SYNC_SUCCEEDED' as const,
      succeeded_at: '2026-05-01T08:04:00.000Z',
    }
    prev = snap
    snap = transitionQboSyncRunWorkflow(prev, succeededEvent)
    log.push(entry(5, succeededEvent, snap))

    const initial: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const result = applyEventLog<QboSyncRunWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('succeeded')
  })
})

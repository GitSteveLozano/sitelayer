import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalWorkflow,
  type RentalWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = RENTAL_WORKFLOW_NAME
const SCHEMA = RENTAL_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000100'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: RentalWorkflowSnapshot,
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

describe('rental — applyEventLog replay', () => {
  it('happy path: active → returned → invoiced_pending → returned (cadence) → closed', () => {
    let snap: RentalWorkflowSnapshot = { state: 'active', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const returnEvent = {
      type: 'RETURN' as const,
      returned_at: '2026-04-29T12:00:00.000Z',
      returned_by: 'driver-1',
    }
    let prev = snap
    snap = transitionRentalWorkflow(prev, returnEvent)
    log.push(entry(1, returnEvent, snap))

    prev = snap
    snap = transitionRentalWorkflow(prev, { type: 'INVOICE_QUEUED' })
    log.push(entry(2, { type: 'INVOICE_QUEUED' }, snap))

    prev = snap
    snap = transitionRentalWorkflow(prev, { type: 'INVOICE_POSTED' })
    log.push(entry(3, { type: 'INVOICE_POSTED' }, snap))

    const closeEvent = {
      type: 'CLOSE' as const,
      closed_at: '2026-04-30T12:00:00.000Z',
      closed_by: 'office-user',
    }
    prev = snap
    snap = transitionRentalWorkflow(prev, closeEvent)
    log.push(entry(4, closeEvent, snap))

    const initial: RentalWorkflowSnapshot = { state: 'active', state_version: 1 }
    const result = applyEventLog<RentalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('closed')
  })

  it('alternate path: active → closed (manual close bypassing invoice cycle)', () => {
    const initial: RentalWorkflowSnapshot = { state: 'active', state_version: 1 }
    const closeEvent = {
      type: 'CLOSE' as const,
      closed_at: '2026-04-29T12:00:00.000Z',
      closed_by: 'office-user',
    }
    const closed = transitionRentalWorkflow(initial, closeEvent)
    const log: WorkflowEventLogEntry[] = [entry(1, closeEvent, closed)]
    const result = applyEventLog<RentalWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('closed')
  })
})

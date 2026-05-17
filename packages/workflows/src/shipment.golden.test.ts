import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  SHIPMENT_WORKFLOW_NAME,
  SHIPMENT_WORKFLOW_SCHEMA_VERSION,
  transitionShipmentWorkflow,
  type ShipmentWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = SHIPMENT_WORKFLOW_NAME
const SCHEMA = SHIPMENT_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000060'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: ShipmentWorkflowSnapshot,
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

describe('shipment — applyEventLog replay', () => {
  it('happy path: planned → picking → shipped → delivered → closed', () => {
    let snap: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    let prev = snap
    snap = transitionShipmentWorkflow(prev, { type: 'START_PICKING' })
    log.push(entry(1, { type: 'START_PICKING' }, snap))

    const shipEvent = {
      type: 'SHIP' as const,
      shipped_at: '2026-05-01T09:00:00.000Z',
      driver: 'driver-1',
      ticket_number: 'T-1',
    }
    prev = snap
    snap = transitionShipmentWorkflow(prev, shipEvent)
    log.push(entry(2, shipEvent, snap))

    const deliverEvent = {
      type: 'CONFIRM_DELIVERY' as const,
      delivered_at: '2026-05-01T11:00:00.000Z',
      confirmed_by: 'crew-1',
    }
    prev = snap
    snap = transitionShipmentWorkflow(prev, deliverEvent)
    log.push(entry(3, deliverEvent, snap))

    const closeEvent = { type: 'CLOSE' as const, confirmed_by: 'office-user' }
    prev = snap
    snap = transitionShipmentWorkflow(prev, closeEvent)
    log.push(entry(4, closeEvent, snap))

    const initial: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const result = applyEventLog<ShipmentWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('closed')
  })

  it('alternate path: ends in voided after picking', () => {
    let snap: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    let prev = snap
    snap = transitionShipmentWorkflow(prev, { type: 'START_PICKING' })
    log.push(entry(1, { type: 'START_PICKING' }, snap))

    prev = snap
    snap = transitionShipmentWorkflow(prev, { type: 'VOID' })
    log.push(entry(2, { type: 'VOID' }, snap))

    const initial: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const result = applyEventLog<ShipmentWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('voided')
  })

  it('alternate path: delivered → returning → closed', () => {
    let snap: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const shipEvent = {
      type: 'SHIP' as const,
      shipped_at: '2026-05-01T09:00:00.000Z',
    }
    let prev = snap
    snap = transitionShipmentWorkflow(prev, shipEvent)
    log.push(entry(1, shipEvent, snap))

    const deliverEvent = {
      type: 'CONFIRM_DELIVERY' as const,
      delivered_at: '2026-05-01T11:00:00.000Z',
      confirmed_by: 'crew-1',
    }
    prev = snap
    snap = transitionShipmentWorkflow(prev, deliverEvent)
    log.push(entry(2, deliverEvent, snap))

    prev = snap
    snap = transitionShipmentWorkflow(prev, { type: 'OPEN_RETURN' })
    log.push(entry(3, { type: 'OPEN_RETURN' }, snap))

    const closeEvent = { type: 'CLOSE' as const, confirmed_by: 'office' }
    prev = snap
    snap = transitionShipmentWorkflow(prev, closeEvent)
    log.push(entry(4, closeEvent, snap))

    const initial: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
    const result = applyEventLog<ShipmentWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('closed')
  })
})

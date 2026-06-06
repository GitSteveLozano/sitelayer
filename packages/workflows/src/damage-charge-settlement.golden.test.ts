import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME,
  DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION,
  transitionDamageChargeSettlementWorkflow,
  type DamageChargeSettlementWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME
const SCHEMA = DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000080'

describe('damage-charge-settlement — applyEventLog replay', () => {
  it('happy path: open → invoiced', () => {
    const initial: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
    const invoiceEvent = {
      type: 'INVOICE' as const,
      invoiced_at: '2026-05-01T10:00:00.000Z',
      invoiced_by: 'office-user',
    }
    const invoiced = transitionDamageChargeSettlementWorkflow(initial, invoiceEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: invoiceEvent,
        snapshot_after: invoiced as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<DamageChargeSettlementWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('invoiced')
  })

  it('alternate path: open → waived with reason', () => {
    const initial: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
    const waiveEvent = {
      type: 'WAIVE' as const,
      waived_at: '2026-05-01T10:00:00.000Z',
      waived_by: 'admin-user',
      waive_reason: 'customer paid manually',
    }
    const waived = transitionDamageChargeSettlementWorkflow(initial, waiveEvent)
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: waiveEvent,
        snapshot_after: waived as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<DamageChargeSettlementWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('waived')
    expect(result.finalSnapshot?.waive_reason).toBe('customer paid manually')
  })
})

import { describe, it, expect } from 'vitest'
import {
  DAMAGE_CHARGE_SETTLEMENT_ALL_STATES,
  DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES,
  damageChargeSettlementWorkflow,
  isHumanDamageChargeSettlementEvent,
  nextDamageChargeSettlementEvents,
  parseDamageChargeSettlementEventRequest,
  transitionDamageChargeSettlementWorkflow,
  type DamageChargeSettlementWorkflowSnapshot,
} from './damage-charge-settlement.js'

describe('transitionDamageChargeSettlementWorkflow', () => {
  it('open → invoiced via INVOICE', () => {
    const open: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
    const invoiced = transitionDamageChargeSettlementWorkflow(open, {
      type: 'INVOICE',
      invoiced_at: '2026-05-01T10:00:00.000Z',
      invoiced_by: 'office-user',
    })
    expect(invoiced).toMatchObject({
      state: 'invoiced',
      state_version: 2,
      invoiced_at: '2026-05-01T10:00:00.000Z',
      invoiced_by: 'office-user',
    })
  })

  it('open → waived via WAIVE with reason', () => {
    const open: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
    const waived = transitionDamageChargeSettlementWorkflow(open, {
      type: 'WAIVE',
      waived_at: '2026-05-01T10:00:00.000Z',
      waived_by: 'admin-user',
      waive_reason: 'customer complaint resolved',
    })
    expect(waived).toMatchObject({
      state: 'waived',
      state_version: 2,
      waive_reason: 'customer complaint resolved',
    })
  })

  it('rejects double-invoice', () => {
    expect(() =>
      transitionDamageChargeSettlementWorkflow(
        { state: 'invoiced', state_version: 2 },
        { type: 'INVOICE', invoiced_at: 'x', invoiced_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })

  it('rejects WAIVE from waived', () => {
    expect(() =>
      transitionDamageChargeSettlementWorkflow(
        { state: 'waived', state_version: 2 },
        { type: 'WAIVE', waived_at: 'x', waived_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })
})

describe('damageChargeSettlement registry + helpers', () => {
  it('exposes reducer + metadata', () => {
    expect(damageChargeSettlementWorkflow.name).toBe('damage_charge_settlement')
    expect(damageChargeSettlementWorkflow.initialState).toBe('open')
    expect(damageChargeSettlementWorkflow.terminalStates).toEqual(DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES)
    expect(damageChargeSettlementWorkflow.allStates).toEqual(DAMAGE_CHARGE_SETTLEMENT_ALL_STATES)
  })

  it('nextEvents returns INVOICE+WAIVE on open and nothing on terminals', () => {
    expect(
      nextDamageChargeSettlementEvents('open')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['INVOICE', 'WAIVE'])
    expect(nextDamageChargeSettlementEvents('invoiced')).toEqual([])
    expect(nextDamageChargeSettlementEvents('waived')).toEqual([])
  })

  it('partitions human events', () => {
    expect(isHumanDamageChargeSettlementEvent('INVOICE')).toBe(true)
    expect(isHumanDamageChargeSettlementEvent('WAIVE')).toBe(true)
    expect(isHumanDamageChargeSettlementEvent('FAKE')).toBe(false)
  })

  it('parses well-formed event bodies', () => {
    expect(parseDamageChargeSettlementEventRequest({ event: 'INVOICE', state_version: 1 }).ok).toBe(true)
    expect(parseDamageChargeSettlementEventRequest({ event: 'WAIVE', state_version: 2, waive_reason: 'ok' }).ok).toBe(
      true,
    )
  })

  it('rejects malformed bodies', () => {
    expect(parseDamageChargeSettlementEventRequest({ event: 'FOO', state_version: 1 }).ok).toBe(false)
    expect(parseDamageChargeSettlementEventRequest({ event: 'INVOICE' }).ok).toBe(false)
    expect(parseDamageChargeSettlementEventRequest(null).ok).toBe(false)
  })
})

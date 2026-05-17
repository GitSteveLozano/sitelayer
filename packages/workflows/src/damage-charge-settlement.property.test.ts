import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  DAMAGE_CHARGE_SETTLEMENT_ALL_STATES,
  DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES,
  transitionDamageChargeSettlementWorkflow,
  type DamageChargeSettlementWorkflowEvent,
  type DamageChargeSettlementWorkflowSnapshot,
  type DamageChargeSettlementWorkflowState,
} from './damage-charge-settlement.js'

const STATE_GEN: fc.Arbitrary<DamageChargeSettlementWorkflowState> = fc.constantFrom(
  ...DAMAGE_CHARGE_SETTLEMENT_ALL_STATES,
)

const ANY_EVENT: fc.Arbitrary<DamageChargeSettlementWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('INVOICE' as const),
    invoiced_at: fc.constant('2026-05-01T10:00:00.000Z'),
    invoiced_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('WAIVE' as const),
    waived_at: fc.constant('2026-05-01T10:00:00.000Z'),
    waived_by: fc.string({ minLength: 1, maxLength: 32 }),
    waive_reason: fc.string({ maxLength: 64 }),
  }),
)

function emptySnapshot(
  state: DamageChargeSettlementWorkflowState,
  version: number,
): DamageChargeSettlementWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: DamageChargeSettlementWorkflowSnapshot,
  event: DamageChargeSettlementWorkflowEvent,
): { ok: true; next: DamageChargeSettlementWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionDamageChargeSettlementWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('damage-charge-settlement reducer — property invariants', () => {
  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const r = safeReduce(emptySnapshot(state, version), event)
        if (!r.ok) return
        expect(r.next.state_version).toBe(version + 1)
      }),
      { numRuns: 100 },
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DAMAGE_CHARGE_SETTLEMENT_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionDamageChargeSettlementWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(DAMAGE_CHARGE_SETTLEMENT_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 100 },
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 3)
        const a = safeReduce(snap, event)
        const b = safeReduce(snap, event)
        expect(a.ok).toBe(b.ok)
        if (a.ok && b.ok) expect(a.next).toEqual(b.next)
      }),
      { numRuns: 100 },
    )
  })

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 8 }), (events) => {
        const initial: DamageChargeSettlementWorkflowSnapshot = { state: 'open', state_version: 1 }
        function walk(): DamageChargeSettlementWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionDamageChargeSettlementWorkflow(snap, e)
            } catch {
              // illegal, skip
            }
          }
          return snap
        }
        expect(walk()).toEqual(walk())
      }),
      { numRuns: 100 },
    )
  })
})

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  SHIPMENT_ALL_STATES,
  SHIPMENT_TERMINAL_STATES,
  transitionShipmentWorkflow,
  type ShipmentWorkflowEvent,
  type ShipmentWorkflowSnapshot,
  type ShipmentWorkflowState,
} from './shipment.js'

const STATE_GEN: fc.Arbitrary<ShipmentWorkflowState> = fc.constantFrom(...SHIPMENT_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<ShipmentWorkflowEvent> = fc.oneof(
  fc.constant<ShipmentWorkflowEvent>({ type: 'START_PICKING' }),
  fc.record({
    type: fc.constant('SHIP' as const),
    shipped_at: fc.constant('2026-05-01T09:00:00.000Z'),
    driver: fc.string({ minLength: 1, maxLength: 16 }),
    ticket_number: fc.string({ minLength: 1, maxLength: 16 }),
  }),
  fc.record({
    type: fc.constant('CONFIRM_DELIVERY' as const),
    delivered_at: fc.constant('2026-05-01T11:00:00.000Z'),
    confirmed_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.constant<ShipmentWorkflowEvent>({ type: 'OPEN_RETURN' }),
  fc.record({
    type: fc.constant('CLOSE' as const),
    confirmed_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.constant<ShipmentWorkflowEvent>({ type: 'VOID' }),
)

function emptySnapshot(state: ShipmentWorkflowState, version: number): ShipmentWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: ShipmentWorkflowSnapshot,
  event: ShipmentWorkflowEvent,
): { ok: true; next: ShipmentWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionShipmentWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('shipment reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...SHIPMENT_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionShipmentWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(SHIPMENT_ALL_STATES).toContain(r.next.state)
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
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 12 }), (events) => {
        const initial: ShipmentWorkflowSnapshot = { state: 'planned', state_version: 1 }
        function walk(): ShipmentWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionShipmentWorkflow(snap, e)
            } catch {
              // skip
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

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  RENTAL_ALL_STATES,
  RENTAL_TERMINAL_STATES,
  transitionRentalWorkflow,
  type RentalWorkflowEvent,
  type RentalWorkflowSnapshot,
  type RentalWorkflowState,
} from './rental.js'

const STATE_GEN: fc.Arbitrary<RentalWorkflowState> = fc.constantFrom(...RENTAL_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<RentalWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('RETURN' as const),
    returned_at: fc.constant('2026-05-01T09:00:00.000Z'),
    returned_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.constant<RentalWorkflowEvent>({ type: 'INVOICE_QUEUED' }),
  fc.constant<RentalWorkflowEvent>({ type: 'INVOICE_POSTED' }),
  fc.record({
    type: fc.constant('CLOSE' as const),
    closed_at: fc.constant('2026-05-02T09:00:00.000Z'),
    closed_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
)

function emptySnapshot(state: RentalWorkflowState, version: number): RentalWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: RentalWorkflowSnapshot,
  event: RentalWorkflowEvent,
): { ok: true; next: RentalWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionRentalWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('rental reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...RENTAL_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionRentalWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(RENTAL_ALL_STATES).toContain(r.next.state)
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
        const initial: RentalWorkflowSnapshot = { state: 'active', state_version: 1 }
        function walk(): RentalWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionRentalWorkflow(snap, e)
            } catch {
              // skip illegal transitions
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

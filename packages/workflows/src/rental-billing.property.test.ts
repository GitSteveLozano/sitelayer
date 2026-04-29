import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  RENTAL_BILLING_ALL_STATES,
  RENTAL_BILLING_TERMINAL_STATES,
  rentalBillingWorkflow,
  transitionRentalBillingWorkflow,
  type RentalBillingHumanEventType,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
  type RentalBillingWorkflowState,
} from './rental-billing.js'

/**
 * Property-based regression net for the rental-billing reducer.
 *
 * Hand-written tests cover the obvious paths. These tests assert
 * structural invariants over every reachable (state, event) pair so
 * silent reducer drift fails CI even when no one wrote a corresponding
 * unit test. Locking these in BEFORE first paying customer is the
 * cheapest insurance against business-logic regressions.
 *
 * Invariants checked:
 *   1. state_version strictly increments by 1 per accepted transition.
 *   2. Terminal states ('posted', 'voided') accept no further events.
 *   3. Reducer never produces a state outside the declared state set.
 *   4. APPROVE preserves approved metadata across the next transition.
 *   5. Human-event filter and worker-event filter partition the event set.
 *   6. Re-applying the same event from the same input yields the same
 *      output (determinism / idempotency at the reducer layer).
 */

const HUMAN_EVENT_GENERATORS: Array<fc.Arbitrary<RentalBillingWorkflowEvent>> = [
  fc.record({
    type: fc.constant('APPROVE' as const),
    approved_at: fc.constant('2026-04-29T00:00:00.000Z'),
    approved_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.constant<RentalBillingWorkflowEvent>({ type: 'POST_REQUESTED' }),
  fc.constant<RentalBillingWorkflowEvent>({ type: 'RETRY_POST' }),
  fc.constant<RentalBillingWorkflowEvent>({ type: 'VOID' }),
]

const WORKER_EVENT_GENERATORS: Array<fc.Arbitrary<RentalBillingWorkflowEvent>> = [
  fc.record({
    type: fc.constant('POST_SUCCEEDED' as const),
    posted_at: fc.constant('2026-04-29T00:01:00.000Z'),
    qbo_invoice_id: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('POST_FAILED' as const),
    failed_at: fc.constant('2026-04-29T00:01:00.000Z'),
    error: fc.string({ maxLength: 64 }),
  }),
]

const ANY_EVENT = fc.oneof(...HUMAN_EVENT_GENERATORS, ...WORKER_EVENT_GENERATORS)

const STATE_GEN: fc.Arbitrary<RentalBillingWorkflowState> = fc.constantFrom(...RENTAL_BILLING_ALL_STATES)

function emptySnapshot(state: RentalBillingWorkflowState, version: number): RentalBillingWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: RentalBillingWorkflowSnapshot,
  event: RentalBillingWorkflowEvent,
): { ok: true; next: RentalBillingWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionRentalBillingWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('rental-billing reducer — property invariants', () => {
  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const snap = emptySnapshot(state, version)
        const result = safeReduce(snap, event)
        if (!result.ok) return // illegal transitions are not under test here
        expect(result.next.state_version).toBe(version + 1)
      }),
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RENTAL_BILLING_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 1)
        expect(() => transitionRentalBillingWorkflow(snap, event)).toThrow()
      }),
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const result = safeReduce(emptySnapshot(state, 1), event)
        if (!result.ok) return
        expect(RENTAL_BILLING_ALL_STATES).toContain(result.next.state)
      }),
    )
  })

  it('APPROVE → POST_REQUESTED preserves approved_by and approved_at', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 32 }), (approver) => {
        const generated = emptySnapshot('generated', 1)
        const approved = transitionRentalBillingWorkflow(generated, {
          type: 'APPROVE',
          approved_at: '2026-04-29T00:00:00.000Z',
          approved_by: approver,
        })
        const posting = transitionRentalBillingWorkflow(approved, { type: 'POST_REQUESTED' })
        expect(posting.approved_by).toBe(approver)
        expect(posting.approved_at).toBe('2026-04-29T00:00:00.000Z')
      }),
    )
  })

  it('isHumanEvent and worker-only events partition the event set', () => {
    const allEventTypes: RentalBillingHumanEventType[] = ['APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'VOID']
    const workerOnly = ['POST_SUCCEEDED', 'POST_FAILED']
    for (const t of allEventTypes) expect(rentalBillingWorkflow.isHumanEvent(t)).toBe(true)
    for (const t of workerOnly) expect(rentalBillingWorkflow.isHumanEvent(t)).toBe(false)
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 7)
        const a = safeReduce(snap, event)
        const b = safeReduce(snap, event)
        expect(a.ok).toBe(b.ok)
        if (a.ok && b.ok) {
          expect(a.next).toEqual(b.next)
        }
      }),
    )
  })

  it('every non-terminal state offers at least one human event', () => {
    for (const state of RENTAL_BILLING_ALL_STATES) {
      const events = rentalBillingWorkflow.nextEvents(state)
      if (RENTAL_BILLING_TERMINAL_STATES.includes(state) || state === 'posting') {
        expect(events).toEqual([])
      } else {
        expect(events.length).toBeGreaterThan(0)
      }
    }
  })

  it('nextEvents only returns events the reducer accepts from that state', () => {
    for (const state of RENTAL_BILLING_ALL_STATES) {
      const events = rentalBillingWorkflow.nextEvents(state)
      for (const next of events) {
        const snap = emptySnapshot(state, 1)
        const event: RentalBillingWorkflowEvent =
          next.type === 'APPROVE'
            ? { type: 'APPROVE', approved_at: '2026-04-29T00:00:00.000Z', approved_by: 'tester' }
            : { type: next.type }
        expect(() => transitionRentalBillingWorkflow(snap, event)).not.toThrow()
      }
    }
  })
})

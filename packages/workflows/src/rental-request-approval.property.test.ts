import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  RENTAL_REQUEST_APPROVAL_ALL_STATES,
  RENTAL_REQUEST_APPROVAL_TERMINAL_STATES,
  transitionRentalRequestApprovalWorkflow,
  type RentalRequestApprovalWorkflowEvent,
  type RentalRequestApprovalWorkflowSnapshot,
  type RentalRequestApprovalWorkflowState,
} from './rental-request-approval.js'

const STATE_GEN: fc.Arbitrary<RentalRequestApprovalWorkflowState> = fc.constantFrom(
  ...RENTAL_REQUEST_APPROVAL_ALL_STATES,
)

const ANY_EVENT: fc.Arbitrary<RentalRequestApprovalWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('APPROVE' as const),
    approved_at: fc.constant('2026-05-01T09:00:00.000Z'),
    approved_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('DECLINE' as const),
    declined_at: fc.constant('2026-05-01T09:00:00.000Z'),
    declined_by: fc.string({ minLength: 1, maxLength: 32 }),
    decline_reason: fc.string({ maxLength: 64 }),
  }),
)

function emptySnapshot(
  state: RentalRequestApprovalWorkflowState,
  version: number,
): RentalRequestApprovalWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: RentalRequestApprovalWorkflowSnapshot,
  event: RentalRequestApprovalWorkflowEvent,
): { ok: true; next: RentalRequestApprovalWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionRentalRequestApprovalWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('rental-request-approval reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...RENTAL_REQUEST_APPROVAL_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionRentalRequestApprovalWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(RENTAL_REQUEST_APPROVAL_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 100 },
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 2)
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
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 6 }), (events) => {
        const initial: RentalRequestApprovalWorkflowSnapshot = { state: 'pending', state_version: 1 }
        function walk(): RentalRequestApprovalWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionRentalRequestApprovalWorkflow(snap, e)
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

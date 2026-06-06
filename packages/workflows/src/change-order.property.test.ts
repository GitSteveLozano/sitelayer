import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  CHANGE_ORDER_ALL_STATES,
  CHANGE_ORDER_TERMINAL_STATES,
  nextChangeOrderEvents,
  transitionChangeOrderWorkflow,
  type ChangeOrderWorkflowEvent,
  type ChangeOrderWorkflowSnapshot,
  type ChangeOrderWorkflowState,
} from './change-order.js'

// The reducer is pure, so a constant ISO clock value is correct under property
// testing — no clock/random is read inside the transition.
const OCCURRED_AT = '2026-05-28T12:00:00.000Z'

const STATE_GEN: fc.Arbitrary<ChangeOrderWorkflowState> = fc.constantFrom(...CHANGE_ORDER_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<ChangeOrderWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('SEND' as const),
    occurred_at: fc.constant(OCCURRED_AT),
    actor_user_id: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('ACCEPT' as const),
    occurred_at: fc.constant(OCCURRED_AT),
    actor_user_id: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('REJECT' as const),
    occurred_at: fc.constant(OCCURRED_AT),
    actor_user_id: fc.string({ minLength: 1, maxLength: 32 }),
    reason: fc.string({ maxLength: 64 }),
  }),
  fc.record({
    type: fc.constant('VOID' as const),
    occurred_at: fc.constant(OCCURRED_AT),
    actor_user_id: fc.string({ minLength: 1, maxLength: 32 }),
  }),
)

function emptySnapshot(state: ChangeOrderWorkflowState, version: number): ChangeOrderWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: ChangeOrderWorkflowSnapshot,
  event: ChangeOrderWorkflowEvent,
): { ok: true; next: ChangeOrderWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionChangeOrderWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('change-order reducer — property invariants', () => {
  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const r = safeReduce(emptySnapshot(state, version), event)
        if (!r.ok) return
        expect(r.next.state_version).toBe(version + 1)
      }),
      { numRuns: 200 },
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CHANGE_ORDER_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionChangeOrderWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 200 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(CHANGE_ORDER_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 200 },
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
      { numRuns: 200 },
    )
  })

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 6 }), (events) => {
        const initial: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
        function walk(): ChangeOrderWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionChangeOrderWorkflow(snap, e)
            } catch {
              // illegal transition for the current state — skip, as the route would 422
            }
          }
          return snap
        }
        expect(walk()).toEqual(walk())
      }),
      { numRuns: 200 },
    )
  })

  it('stamped metadata is monotonically preserved across a random walk (never cleared)', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 8 }), (events) => {
        let snap: ChangeOrderWorkflowSnapshot = { state: 'draft', state_version: 1 }
        const seen: Partial<Record<keyof ChangeOrderWorkflowSnapshot, unknown>> = {}
        const stampedKeys: (keyof ChangeOrderWorkflowSnapshot)[] = [
          'sent_at',
          'accepted_at',
          'rejected_at',
          'voided_at',
          'reject_reason',
          'approved_by',
        ]
        for (const e of events) {
          try {
            snap = transitionChangeOrderWorkflow(snap, e)
          } catch {
            continue
          }
          for (const k of stampedKeys) {
            const v = snap[k]
            if (v != null) {
              if (k in seen) {
                // a stamped value, once present, must never be overwritten away
                expect(snap[k]).toBe(seen[k])
              } else {
                seen[k] = v
              }
            } else if (k in seen) {
              // a previously-stamped value must never be cleared back to null
              throw new Error(`stamped ${String(k)} was cleared`)
            }
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  it('nextEvents(state) is exactly the set of events that reduce without throwing', () => {
    const ALL_TYPES: ChangeOrderWorkflowEvent['type'][] = ['SEND', 'ACCEPT', 'REJECT', 'VOID']
    for (const state of CHANGE_ORDER_ALL_STATES) {
      const allowed = new Set(nextChangeOrderEvents(state).map((e) => e.type))
      for (const type of ALL_TYPES) {
        const event = { type, occurred_at: OCCURRED_AT } as ChangeOrderWorkflowEvent
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (allowed.has(type)) {
          expect(r.ok, `${type} should be accepted from ${state}`).toBe(true)
        } else {
          expect(r.ok, `${type} should be rejected from ${state}`).toBe(false)
        }
      }
    }
  })
})

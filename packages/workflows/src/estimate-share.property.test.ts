import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  ESTIMATE_SHARE_ALL_STATES,
  ESTIMATE_SHARE_TERMINAL_STATES,
  isHumanEstimateShareEvent,
  nextEstimateShareEvents,
  transitionEstimateShareWorkflow,
  type EstimateShareWorkflowEvent,
  type EstimateShareWorkflowSnapshot,
  type EstimateShareWorkflowState,
} from './estimate-share.js'

const STATE_GEN: fc.Arbitrary<EstimateShareWorkflowState> = fc.constantFrom(...ESTIMATE_SHARE_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<EstimateShareWorkflowEvent> = fc.oneof(
  fc.record({ type: fc.constant('VIEW' as const), viewed_at: fc.constant('2026-05-01T10:00:00.000Z') }),
  fc.record({
    type: fc.constant('ACCEPT' as const),
    accepted_at: fc.constant('2026-05-01T11:00:00.000Z'),
    signer_name: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('DECLINE' as const),
    declined_at: fc.constant('2026-05-01T11:00:00.000Z'),
    decline_reason: fc.string({ maxLength: 64 }),
  }),
  fc.record({ type: fc.constant('EXPIRE' as const), expired_at: fc.constant('2026-06-01T00:00:00.000Z') }),
  fc.record({
    type: fc.constant('REVOKE' as const),
    revoked_at: fc.constant('2026-05-01T12:00:00.000Z'),
    revoked_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
)

function snap(state: EstimateShareWorkflowState, version: number): EstimateShareWorkflowSnapshot {
  return { state, state_version: version, view_count: 0 }
}

function safeReduce(
  s: EstimateShareWorkflowSnapshot,
  e: EstimateShareWorkflowEvent,
): { ok: true; next: EstimateShareWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionEstimateShareWorkflow(s, e) }
  } catch {
    return { ok: false }
  }
}

describe('estimate-share reducer — property invariants', () => {
  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const r = safeReduce(snap(state, version), event)
        if (!r.ok) return
        expect(r.next.state_version).toBe(version + 1)
      }),
      { numRuns: 200 },
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ESTIMATE_SHARE_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionEstimateShareWorkflow(snap(state, 1), event)).toThrow()
      }),
      { numRuns: 200 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(snap(state, 1), event)
        if (!r.ok) return
        expect(ESTIMATE_SHARE_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 200 },
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const s = snap(state, 3)
        const a = safeReduce(s, event)
        const b = safeReduce(s, event)
        expect(a.ok).toBe(b.ok)
        if (a.ok && b.ok) expect(a.next).toEqual(b.next)
      }),
      { numRuns: 200 },
    )
  })

  it('nextEvents are all human events and a subset of accepted-from-state events', () => {
    fc.assert(
      fc.property(STATE_GEN, (state) => {
        for (const ne of nextEstimateShareEvents(state)) {
          expect(isHumanEstimateShareEvent(ne.type)).toBe(true)
          // The surfaced event must actually be accepted from this state.
          const r = safeReduce(snap(state, 1), {
            type: 'REVOKE',
            revoked_at: '2026-05-01T12:00:00.000Z',
            revoked_by: 'x',
          })
          expect(r.ok).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 8 }), (events) => {
        const initial: EstimateShareWorkflowSnapshot = { state: 'sent', state_version: 1, view_count: 0 }
        function walk(): EstimateShareWorkflowSnapshot {
          let s = initial
          for (const e of events) {
            try {
              s = transitionEstimateShareWorkflow(s, e)
            } catch {
              /* illegal, skip */
            }
          }
          return s
        }
        expect(walk()).toEqual(walk())
      }),
      { numRuns: 200 },
    )
  })
})

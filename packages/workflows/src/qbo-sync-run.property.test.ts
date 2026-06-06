import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  QBO_SYNC_RUN_ALL_STATES,
  QBO_SYNC_RUN_TERMINAL_STATES,
  transitionQboSyncRunWorkflow,
  type QboSyncRunWorkflowEvent,
  type QboSyncRunWorkflowSnapshot,
  type QboSyncRunWorkflowState,
} from './qbo-sync-run.js'

const STATE_GEN: fc.Arbitrary<QboSyncRunWorkflowState> = fc.constantFrom(...QBO_SYNC_RUN_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<QboSyncRunWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('START_SYNC' as const),
    started_at: fc.constant('2026-05-01T08:00:00.000Z'),
    triggered_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('SYNC_SUCCEEDED' as const),
    succeeded_at: fc.constant('2026-05-01T08:01:00.000Z'),
  }),
  fc.record({
    type: fc.constant('SYNC_FAILED' as const),
    failed_at: fc.constant('2026-05-01T08:01:00.000Z'),
    error: fc.string({ maxLength: 64 }),
  }),
  fc.record({
    type: fc.constant('RETRY' as const),
    retried_at: fc.constant('2026-05-01T08:02:00.000Z'),
    triggered_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
)

function emptySnapshot(state: QboSyncRunWorkflowState, version: number): QboSyncRunWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: QboSyncRunWorkflowSnapshot,
  event: QboSyncRunWorkflowEvent,
): { ok: true; next: QboSyncRunWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionQboSyncRunWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('qbo-sync-run reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...QBO_SYNC_RUN_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionQboSyncRunWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(QBO_SYNC_RUN_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 100 },
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 4)
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
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 10 }), (events) => {
        const initial: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
        function walk(): QboSyncRunWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionQboSyncRunWorkflow(snap, e)
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

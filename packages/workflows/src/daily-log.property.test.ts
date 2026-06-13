import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  DAILY_LOG_ALL_STATES,
  DAILY_LOG_TERMINAL_STATES,
  nextDailyLogEvents,
  transitionDailyLogWorkflow,
  type DailyLogWorkflowEvent,
  type DailyLogWorkflowSnapshot,
  type DailyLogWorkflowState,
} from './daily-log.js'

const STATE_GEN: fc.Arbitrary<DailyLogWorkflowState> = fc.constantFrom(...DAILY_LOG_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<DailyLogWorkflowEvent> = fc.record({
  type: fc.constant('SUBMIT' as const),
  submitted_at: fc.constant('2026-05-01T17:00:00.000Z'),
  submitted_by: fc.string({ minLength: 1, maxLength: 32 }),
})

function emptySnapshot(state: DailyLogWorkflowState, version: number): DailyLogWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: DailyLogWorkflowSnapshot,
  event: DailyLogWorkflowEvent,
): { ok: true; next: DailyLogWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionDailyLogWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('daily-log reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...DAILY_LOG_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionDailyLogWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(DAILY_LOG_ALL_STATES).toContain(r.next.state)
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

  it('nextEvents(state) only lists events the reducer actually accepts from that state', () => {
    fc.assert(
      fc.property(STATE_GEN, (state) => {
        for (const affordance of nextDailyLogEvents(state)) {
          // SUBMIT is the only affordance; build a valid one and confirm
          // the reducer accepts it from the advertising state.
          expect(affordance.type).toBe('SUBMIT')
          const r = safeReduce(emptySnapshot(state, 1), {
            type: 'SUBMIT',
            submitted_at: '2026-05-01T17:00:00.000Z',
            submitted_by: 'foreman-1',
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
        const initial: DailyLogWorkflowSnapshot = { state: 'draft', state_version: 1 }
        function walk(): DailyLogWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionDailyLogWorkflow(snap, e)
            } catch {
              // skip illegal transitions (SUBMIT from submitted)
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

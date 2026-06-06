import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  LABOR_PAYROLL_ALL_STATES,
  LABOR_PAYROLL_EVENT_TYPES,
  LABOR_PAYROLL_TERMINAL_STATES,
  LaborPayrollEventRequestSchema,
  isHumanLaborPayrollEvent,
  transitionLaborPayrollWorkflow,
  type LaborPayrollWorkflowEvent,
  type LaborPayrollWorkflowSnapshot,
  type LaborPayrollWorkflowState,
} from './labor-payroll.js'

/**
 * Property-based regression net for the labor-payroll reducer.
 * Mirrors the rental-billing property test shape.
 */

const STATE_GEN: fc.Arbitrary<LaborPayrollWorkflowState> = fc.constantFrom(...LABOR_PAYROLL_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<LaborPayrollWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('APPROVE' as const),
    approved_at: fc.constant('2026-04-29T00:00:00.000Z'),
    approved_by: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.constant<LaborPayrollWorkflowEvent>({ type: 'POST_REQUESTED' }),
  fc.constant<LaborPayrollWorkflowEvent>({ type: 'RETRY_POST' }),
  fc.constant<LaborPayrollWorkflowEvent>({ type: 'VOID' }),
  fc.record({
    type: fc.constant('POST_SUCCEEDED' as const),
    posted_at: fc.constant('2026-04-29T00:01:00.000Z'),
    qbo_timeactivity_ids: fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
      minLength: 1,
      maxLength: 4,
    }),
  }),
  fc.record({
    type: fc.constant('POST_FAILED' as const),
    failed_at: fc.constant('2026-04-29T00:01:00.000Z'),
    error: fc.string({ maxLength: 64 }),
  }),
)

function emptySnapshot(state: LaborPayrollWorkflowState, version: number): LaborPayrollWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: LaborPayrollWorkflowSnapshot,
  event: LaborPayrollWorkflowEvent,
): { ok: true; next: LaborPayrollWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionLaborPayrollWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('labor-payroll reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...LABOR_PAYROLL_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionLaborPayrollWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(LABOR_PAYROLL_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 100 },
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 5)
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
        const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
        function walk(): LaborPayrollWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionLaborPayrollWorkflow(snap, e)
            } catch {
              // skip illegal events
            }
          }
          return snap
        }
        expect(walk()).toEqual(walk())
      }),
      { numRuns: 100 },
    )
  })

  it('isHumanLaborPayrollEvent(t) iff the human-endpoint Zod enum accepts t', () => {
    // The human/worker split must stay coherent: every event the human
    // endpoint accepts is exactly the set of human events, and worker-only
    // events (POST_SUCCEEDED / POST_FAILED — and any future AUTO_* event)
    // are rejected at POST /events. This catches a future event leaking
    // into the human path.
    fc.assert(
      fc.property(fc.constantFrom(...LABOR_PAYROLL_EVENT_TYPES), (eventType) => {
        const parsed = LaborPayrollEventRequestSchema.safeParse({ event: eventType, state_version: 1 })
        expect(parsed.success).toBe(isHumanLaborPayrollEvent(eventType))
      }),
      { numRuns: 100 },
    )
  })
})

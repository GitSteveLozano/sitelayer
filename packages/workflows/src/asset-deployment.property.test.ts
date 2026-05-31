import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  ASSET_DEPLOYMENT_ALL_STATES,
  ASSET_DEPLOYMENT_TERMINAL_STATES,
  transitionAssetDeploymentWorkflow,
  type AssetDeploymentWorkflowEvent,
  type AssetDeploymentWorkflowSnapshot,
  type AssetDeploymentWorkflowState,
} from './asset-deployment.js'

const STATE_GEN: fc.Arbitrary<AssetDeploymentWorkflowState> = fc.constantFrom(...ASSET_DEPLOYMENT_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<AssetDeploymentWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('DISPATCH' as const),
    dispatched_at: fc.constant('2026-04-15T08:00:00.000Z'),
    project_id: fc.constant('proj-1'),
    handoff_worker_id: fc.string({ minLength: 1, maxLength: 16 }),
    estimated_return_on: fc.constant('2026-05-17'),
    day_rate_cents: fc.integer({ min: 0, max: 100_000 }),
  }),
  fc.record({
    type: fc.constant('CONFIRM_HANDOFF' as const),
    handoff_confirmed_at: fc.constant('2026-04-15T09:00:00.000Z'),
    handoff_confirmed_by: fc.string({ minLength: 1, maxLength: 16 }),
  }),
  fc.record({
    type: fc.constant('MARK_OVERDUE' as const),
    overdue_since: fc.constant('2026-05-18T00:00:00.000Z'),
  }),
  fc.record({
    type: fc.constant('EXTEND' as const),
    estimated_return_on: fc.constant('2026-05-31'),
    extension_reason: fc.string({ maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('BEGIN_RETURN' as const),
    return_started_at: fc.constant('2026-05-30T16:00:00.000Z'),
  }),
  fc.record({
    type: fc.constant('COMPLETE_RETURN' as const),
    returned_at: fc.constant('2026-05-31T09:00:00.000Z'),
    returned_by: fc.string({ minLength: 1, maxLength: 16 }),
    condition_grade: fc.constantFrom('good', 'wear', 'damage'),
  }),
  fc.record({
    type: fc.constant('WRITE_OFF' as const),
    written_off_at: fc.constant('2026-05-01T00:00:00.000Z'),
    written_off_by: fc.string({ minLength: 1, maxLength: 16 }),
    write_off_reason: fc.string({ maxLength: 32 }),
  }),
)

function snap(state: AssetDeploymentWorkflowState, version: number): AssetDeploymentWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  s: AssetDeploymentWorkflowSnapshot,
  event: AssetDeploymentWorkflowEvent,
): { ok: true; next: AssetDeploymentWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionAssetDeploymentWorkflow(s, event) }
  } catch {
    return { ok: false }
  }
}

describe('asset_deployment reducer — property invariants', () => {
  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const r = safeReduce(snap(state, version), event)
        if (!r.ok) return
        expect(r.next.state_version).toBe(version + 1)
      }),
      { numRuns: 100 },
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ASSET_DEPLOYMENT_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionAssetDeploymentWorkflow(snap(state, 6), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(snap(state, 1), event)
        if (!r.ok) return
        expect(ASSET_DEPLOYMENT_ALL_STATES).toContain(r.next.state)
      }),
      { numRuns: 100 },
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
      { numRuns: 100 },
    )
  })

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 12 }), (events) => {
        const initial: AssetDeploymentWorkflowSnapshot = { state: 'staged', state_version: 1 }
        function walk(): AssetDeploymentWorkflowSnapshot {
          let s = initial
          for (const e of events) {
            try {
              s = transitionAssetDeploymentWorkflow(s, e)
            } catch {
              // skip illegal transitions
            }
          }
          return s
        }
        expect(walk()).toEqual(walk())
      }),
      { numRuns: 100 },
    )
  })
})

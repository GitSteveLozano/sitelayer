import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  TENANT_PROVISION_ALL_STATES,
  TENANT_PROVISION_TERMINAL_STATES,
  transitionTenantProvisionWorkflow,
  type TenantProvisionWorkflowEvent,
  type TenantProvisionWorkflowSnapshot,
  type TenantProvisionWorkflowState,
} from './tenant-provision.js'

const STATE_GEN: fc.Arbitrary<TenantProvisionWorkflowState> = fc.constantFrom(...TENANT_PROVISION_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<TenantProvisionWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('CREATE_COMPANY' as const),
    slug: fc.string({ minLength: 1, maxLength: 16 }),
    name: fc.string({ minLength: 1, maxLength: 16 }),
  }),
  fc.record({ type: fc.constant('COMPANY_CREATED' as const), company_id: fc.string({ minLength: 1, maxLength: 16 }) }),
  fc.record({
    type: fc.constant('COMPANY_REJECTED' as const),
    error: fc.string({ minLength: 1, maxLength: 16 }),
    suggested_slug: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: null }),
  }),
  fc.record({
    type: fc.constant('INVITE_MEMBER' as const),
    clerk_user_id: fc.string({ minLength: 1, maxLength: 16 }),
    role: fc.constantFrom('admin', 'foreman', 'office', 'member'),
  }),
  fc.record({ type: fc.constant('MEMBER_INVITED' as const), clerk_user_id: fc.string({ minLength: 1, maxLength: 16 }) }),
  fc.record({ type: fc.constant('SEED_REQUESTED' as const), seed_request: fc.constant({ yard_name: 'Main' }) }),
  fc.record({ type: fc.constant('SEED_PARTIAL' as const), failed_seeds: fc.array(fc.string(), { maxLength: 4 }) }),
  fc.constant({ type: 'SEED_COMPLETED' as const }),
  fc.constant({ type: 'SKIP_SEED' as const }),
  fc.constant({ type: 'FINISH' as const }),
  fc.constant({ type: 'ABANDON' as const }),
)

function snap(state: TenantProvisionWorkflowState, version: number): TenantProvisionWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  s: TenantProvisionWorkflowSnapshot,
  event: TenantProvisionWorkflowEvent,
): { ok: true; next: TenantProvisionWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionTenantProvisionWorkflow(s, event) }
  } catch {
    return { ok: false }
  }
}

describe('tenant-provision reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...TENANT_PROVISION_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionTenantProvisionWorkflow(snap(state, 1), event)).toThrow()
      }),
      { numRuns: 200 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(snap(state, 1), event)
        if (!r.ok) return
        expect(TENANT_PROVISION_ALL_STATES).toContain(r.next.state)
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

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 8 }), (events) => {
        const initial: TenantProvisionWorkflowSnapshot = { state: 'company_pending', state_version: 1 }
        function walk(): TenantProvisionWorkflowSnapshot {
          let s = initial
          for (const e of events) {
            try {
              s = transitionTenantProvisionWorkflow(s, e)
            } catch {
              // illegal — skip, matching the route's reject-and-stay behaviour
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

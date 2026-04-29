import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  ESTIMATE_PUSH_ALL_STATES,
  ESTIMATE_PUSH_TERMINAL_STATES,
  estimatePushWorkflow,
  isHumanEstimatePushEvent,
  nextEstimatePushEvents,
  parseEstimatePushEventRequest,
  transitionEstimatePushWorkflow,
  type EstimatePushWorkflowEvent,
  type EstimatePushWorkflowSnapshot,
  type EstimatePushWorkflowState,
} from './estimate-push.js'

describe('transitionEstimatePushWorkflow — happy path', () => {
  it('drafted → reviewed → approved → posting → posted', () => {
    const drafted: EstimatePushWorkflowSnapshot = { state: 'drafted', state_version: 1 }
    const reviewed = transitionEstimatePushWorkflow(drafted, {
      type: 'REVIEW',
      reviewed_at: '2026-04-29T09:00:00.000Z',
      reviewed_by: 'office-user',
    })
    expect(reviewed).toMatchObject({ state: 'reviewed', state_version: 2, reviewed_by: 'office-user' })

    const approved = transitionEstimatePushWorkflow(reviewed, {
      type: 'APPROVE',
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'admin-user',
    })
    expect(approved).toMatchObject({ state: 'approved', state_version: 3, approved_by: 'admin-user' })

    const posting = transitionEstimatePushWorkflow(approved, { type: 'POST_REQUESTED' })
    expect(posting).toMatchObject({ state: 'posting', state_version: 4 })

    const posted = transitionEstimatePushWorkflow(posting, {
      type: 'POST_SUCCEEDED',
      posted_at: '2026-04-29T10:01:00.000Z',
      qbo_estimate_id: 'qbo-est-123',
    })
    expect(posted).toMatchObject({ state: 'posted', state_version: 5, qbo_estimate_id: 'qbo-est-123' })
  })

  it('failed → RETRY_POST returns to approved without losing review/approve metadata', () => {
    const approved: EstimatePushWorkflowSnapshot = {
      state: 'approved',
      state_version: 3,
      reviewed_at: '2026-04-29T09:00:00.000Z',
      reviewed_by: 'office-user',
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'admin-user',
    }
    const posting = transitionEstimatePushWorkflow(approved, { type: 'POST_REQUESTED' })
    const failed = transitionEstimatePushWorkflow(posting, {
      type: 'POST_FAILED',
      failed_at: '2026-04-29T10:01:00.000Z',
      error: 'rate limited',
    })
    const retry = transitionEstimatePushWorkflow(failed, { type: 'RETRY_POST' })
    expect(retry).toMatchObject({
      state: 'approved',
      reviewed_by: 'office-user',
      approved_by: 'admin-user',
      error: null,
      failed_at: null,
    })
  })

  it('rejects illegal transitions', () => {
    expect(() =>
      transitionEstimatePushWorkflow({ state: 'posted', state_version: 5 }, { type: 'POST_REQUESTED' }),
    ).toThrow(/not allowed/)
    expect(() =>
      transitionEstimatePushWorkflow({ state: 'drafted', state_version: 1 }, { type: 'POST_REQUESTED' }),
    ).toThrow(/not allowed/)
    expect(() =>
      transitionEstimatePushWorkflow(
        { state: 'voided', state_version: 2 },
        { type: 'APPROVE', approved_at: '2026-04-29', approved_by: 'x' },
      ),
    ).toThrow(/not allowed/)
  })
})

describe('estimate-push reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<EstimatePushWorkflowState> = fc.constantFrom(...ESTIMATE_PUSH_ALL_STATES)
  const ANY_EVENT: fc.Arbitrary<EstimatePushWorkflowEvent> = fc.oneof(
    fc.record({
      type: fc.constant('REVIEW' as const),
      reviewed_at: fc.constant('2026-04-29T09:00:00.000Z'),
      reviewed_by: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      type: fc.constant('APPROVE' as const),
      approved_at: fc.constant('2026-04-29T10:00:00.000Z'),
      approved_by: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.constant<EstimatePushWorkflowEvent>({ type: 'POST_REQUESTED' }),
    fc.constant<EstimatePushWorkflowEvent>({ type: 'RETRY_POST' }),
    fc.constant<EstimatePushWorkflowEvent>({ type: 'VOID' }),
    fc.record({
      type: fc.constant('POST_SUCCEEDED' as const),
      posted_at: fc.constant('2026-04-29T10:01:00.000Z'),
      qbo_estimate_id: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      type: fc.constant('POST_FAILED' as const),
      failed_at: fc.constant('2026-04-29T10:01:00.000Z'),
      error: fc.string({ maxLength: 64 }),
    }),
  )

  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), ANY_EVENT, (state, version, event) => {
        const snap: EstimatePushWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionEstimatePushWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transitions are not under test here
        }
      }),
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ESTIMATE_PUSH_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() =>
          transitionEstimatePushWorkflow({ state, state_version: 1 }, event),
        ).toThrow(/not allowed/)
      }),
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        try {
          const next = transitionEstimatePushWorkflow({ state, state_version: 1 }, event)
          expect(ESTIMATE_PUSH_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents only returns events the reducer accepts from that state', () => {
    for (const state of ESTIMATE_PUSH_ALL_STATES) {
      const events = nextEstimatePushEvents(state)
      for (const next of events) {
        const snap: EstimatePushWorkflowSnapshot = { state, state_version: 1 }
        const event: EstimatePushWorkflowEvent =
          next.type === 'REVIEW'
            ? { type: 'REVIEW', reviewed_at: '2026-04-29T09:00:00.000Z', reviewed_by: 't' }
            : next.type === 'APPROVE'
              ? { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 't' }
              : { type: next.type }
        expect(() => transitionEstimatePushWorkflow(snap, event)).not.toThrow()
      }
    }
  })
})

describe('isHumanEstimatePushEvent', () => {
  it('partitions human and worker-only events', () => {
    for (const t of ['REVIEW', 'APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'VOID']) {
      expect(isHumanEstimatePushEvent(t)).toBe(true)
    }
    for (const t of ['POST_SUCCEEDED', 'POST_FAILED', 'BOGUS']) {
      expect(isHumanEstimatePushEvent(t)).toBe(false)
    }
  })
})

describe('parseEstimatePushEventRequest', () => {
  it('accepts well-formed requests', () => {
    const r = parseEstimatePushEventRequest({ event: 'REVIEW', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('accepts numeric-string state_version from offline replay', () => {
    const r = parseEstimatePushEventRequest({ event: 'APPROVE', state_version: '4' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(4)
  })
  it('rejects worker-only events', () => {
    expect(parseEstimatePushEventRequest({ event: 'POST_SUCCEEDED', state_version: 1 }).ok).toBe(false)
    expect(parseEstimatePushEventRequest({ event: 'POST_FAILED', state_version: 1 }).ok).toBe(false)
  })
  it('rejects garbage', () => {
    expect(parseEstimatePushEventRequest({ event: 'NOPE', state_version: 1 }).ok).toBe(false)
    expect(parseEstimatePushEventRequest({}).ok).toBe(false)
    expect(parseEstimatePushEventRequest(null).ok).toBe(false)
  })
})

describe('estimatePushWorkflow registry registration', () => {
  it('exposes reducer + metadata via the registry definition', () => {
    expect(estimatePushWorkflow.name).toBe('estimate_push')
    expect(estimatePushWorkflow.schemaVersion).toBe(1)
    expect(estimatePushWorkflow.initialState).toBe('drafted')
    expect(estimatePushWorkflow.terminalStates).toEqual(['posted', 'voided'])
    expect(estimatePushWorkflow.sideEffectTypes).toEqual(['post_qbo_estimate'])
  })
})

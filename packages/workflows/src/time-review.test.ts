import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  TIME_REVIEW_ALL_STATES,
  isHumanTimeReviewEvent,
  nextTimeReviewEvents,
  parseTimeReviewEventRequest,
  timeReviewWorkflow,
  transitionTimeReviewWorkflow,
  type TimeReviewWorkflowEvent,
  type TimeReviewWorkflowSnapshot,
  type TimeReviewWorkflowState,
} from './time-review.js'

const APPROVE: TimeReviewWorkflowEvent = {
  type: 'APPROVE',
  approved_at: '2026-05-01T17:30:00.000Z',
  reviewer_user_id: 'office-user',
}
const REJECT: TimeReviewWorkflowEvent = {
  type: 'REJECT',
  rejected_at: '2026-05-01T17:31:00.000Z',
  reviewer_user_id: 'office-user',
  reason: 'Carlos flagged for unverified OT — please confirm with foreman before resubmitting.',
}
const REOPEN: TimeReviewWorkflowEvent = {
  type: 'REOPEN',
  reopened_at: '2026-05-02T09:00:00.000Z',
  reviewer_user_id: 'admin-user',
  reason: 'Reopening — payroll caught a missing entry.',
}

describe('transitionTimeReviewWorkflow — happy paths', () => {
  it('pending → approved persists timestamp + reviewer and clears rejection trail', () => {
    const start: TimeReviewWorkflowSnapshot = {
      state: 'pending',
      state_version: 1,
      rejected_at: '2026-05-01T15:00:00.000Z',
      rejection_reason: 'previous reject reason',
    }
    const next = transitionTimeReviewWorkflow(start, APPROVE)
    expect(next).toMatchObject({
      state: 'approved',
      state_version: 2,
      approved_at: APPROVE.approved_at,
      reviewer_user_id: APPROVE.reviewer_user_id,
      rejected_at: null,
      rejection_reason: null,
    })
  })

  it('pending → rejected captures reason + reviewer and clears prior approval trail', () => {
    const start: TimeReviewWorkflowSnapshot = {
      state: 'pending',
      state_version: 4,
      approved_at: '2026-04-30T17:00:00.000Z',
    }
    const next = transitionTimeReviewWorkflow(start, REJECT)
    expect(next).toMatchObject({
      state: 'rejected',
      state_version: 5,
      rejected_at: REJECT.rejected_at,
      rejection_reason: REJECT.reason,
      reviewer_user_id: REJECT.reviewer_user_id,
      approved_at: null,
    })
  })

  it('approved → REOPEN moves back to pending with reopened_at recorded and approved_at cleared', () => {
    const approved = transitionTimeReviewWorkflow({ state: 'pending', state_version: 1 }, APPROVE)
    expect(approved.approved_at).toBe(APPROVE.approved_at)

    const reopened = transitionTimeReviewWorkflow(approved, REOPEN)
    expect(reopened.state).toBe('pending')
    expect(reopened.state_version).toBe(approved.state_version + 1)
    expect(reopened.reopened_at).toBe(REOPEN.reopened_at)
    expect(reopened.reviewer_user_id).toBe(REOPEN.reviewer_user_id)
    // Migration 027's time_review_runs_decision_chk requires approved_at /
    // rejected_at / rejection_reason all NULL when state='pending'.
    // Without these clears the persisted UPDATE would violate the
    // constraint on the very next REOPEN that lands in production.
    expect(reopened.approved_at).toBeNull()
    expect(reopened.rejected_at).toBeNull()
    expect(reopened.rejection_reason).toBeNull()
  })

  it('rejected → REOPEN moves back to pending and clears the rejection trail', () => {
    const rejected = transitionTimeReviewWorkflow({ state: 'pending', state_version: 1 }, REJECT)
    expect(rejected.rejected_at).toBe(REJECT.rejected_at)
    expect(rejected.rejection_reason).toBe(REJECT.reason)

    const reopened = transitionTimeReviewWorkflow(rejected, REOPEN)
    expect(reopened.state).toBe('pending')
    expect(reopened.state_version).toBe(rejected.state_version + 1)
    expect(reopened.approved_at).toBeNull()
    expect(reopened.rejected_at).toBeNull()
    expect(reopened.rejection_reason).toBeNull()
  })
})

describe('transitionTimeReviewWorkflow — illegal transitions', () => {
  it('rejects APPROVE from approved', () => {
    const approved: TimeReviewWorkflowSnapshot = {
      state: 'approved',
      state_version: 2,
      approved_at: APPROVE.approved_at,
    }
    expect(() => transitionTimeReviewWorkflow(approved, APPROVE)).toThrow(/not allowed/)
  })

  it('rejects APPROVE from rejected', () => {
    const rejected: TimeReviewWorkflowSnapshot = {
      state: 'rejected',
      state_version: 2,
      rejected_at: REJECT.rejected_at,
      rejection_reason: REJECT.reason,
    }
    expect(() => transitionTimeReviewWorkflow(rejected, APPROVE)).toThrow(/not allowed/)
  })

  it('rejects REOPEN from pending', () => {
    expect(() => transitionTimeReviewWorkflow({ state: 'pending', state_version: 1 }, REOPEN)).toThrow(/not allowed/)
  })

  it('rejects REJECT from approved', () => {
    expect(() =>
      transitionTimeReviewWorkflow({ state: 'approved', state_version: 2, approved_at: APPROVE.approved_at }, REJECT),
    ).toThrow(/not allowed/)
  })
})

describe('time review reducer — property invariants', () => {
  const STATE_GEN: fc.Arbitrary<TimeReviewWorkflowState> = fc.constantFrom(...TIME_REVIEW_ALL_STATES)
  const EVENT_GEN: fc.Arbitrary<TimeReviewWorkflowEvent> = fc.oneof(
    fc.record({
      type: fc.constant('APPROVE' as const),
      approved_at: fc.constant('2026-05-01T17:30:00.000Z'),
      reviewer_user_id: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      type: fc.constant('REJECT' as const),
      rejected_at: fc.constant('2026-05-01T17:31:00.000Z'),
      reviewer_user_id: fc.string({ minLength: 1, maxLength: 32 }),
      reason: fc.string({ minLength: 1, maxLength: 500 }),
    }),
    fc.record({
      type: fc.constant('REOPEN' as const),
      reopened_at: fc.constant('2026-05-02T09:00:00.000Z'),
      reviewer_user_id: fc.string({ minLength: 1, maxLength: 32 }),
      reason: fc.string({ minLength: 1, maxLength: 500 }),
    }),
  )

  it('state_version increments by exactly 1 on every accepted transition', () => {
    fc.assert(
      fc.property(STATE_GEN, fc.integer({ min: 1, max: 1_000_000 }), EVENT_GEN, (state, version, event) => {
        const snap: TimeReviewWorkflowSnapshot = { state, state_version: version }
        try {
          const next = transitionTimeReviewWorkflow(snap, event)
          expect(next.state_version).toBe(version + 1)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, EVENT_GEN, (state, event) => {
        try {
          const next = transitionTimeReviewWorkflow({ state, state_version: 1 }, event)
          expect(TIME_REVIEW_ALL_STATES).toContain(next.state)
        } catch {
          // illegal transition — skip
        }
      }),
    )
  })

  it('nextEvents returns only events the reducer accepts', () => {
    for (const state of TIME_REVIEW_ALL_STATES) {
      const events = nextTimeReviewEvents(state)
      for (const next of events) {
        const event: TimeReviewWorkflowEvent =
          next.type === 'APPROVE' ? APPROVE : next.type === 'REJECT' ? REJECT : REOPEN
        expect(() => transitionTimeReviewWorkflow({ state, state_version: 1 }, event)).not.toThrow()
      }
    }
  })

  it('REJECT always sets a non-empty reason', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (reason) => {
        const next = transitionTimeReviewWorkflow(
          { state: 'pending', state_version: 1 },
          { type: 'REJECT', rejected_at: REJECT.rejected_at, reviewer_user_id: 'r', reason },
        )
        expect(next.rejection_reason).toBe(reason)
      }),
    )
  })
})

describe('isHumanTimeReviewEvent', () => {
  it('partitions human-driven events from worker-only', () => {
    expect(isHumanTimeReviewEvent('APPROVE')).toBe(true)
    expect(isHumanTimeReviewEvent('REJECT')).toBe(true)
    expect(isHumanTimeReviewEvent('REOPEN')).toBe(true)
    expect(isHumanTimeReviewEvent('LOCK_ENTRIES')).toBe(false)
  })
})

describe('parseTimeReviewEventRequest', () => {
  it('accepts APPROVE without reason', () => {
    const r = parseTimeReviewEventRequest({ event: 'APPROVE', state_version: 1 })
    expect(r.ok).toBe(true)
  })
  it('requires reason for REJECT', () => {
    expect(parseTimeReviewEventRequest({ event: 'REJECT', state_version: 1 }).ok).toBe(false)
    expect(parseTimeReviewEventRequest({ event: 'REJECT', state_version: 1, reason: 'see notes' }).ok).toBe(true)
  })
  it('requires reason for REOPEN', () => {
    expect(parseTimeReviewEventRequest({ event: 'REOPEN', state_version: 1 }).ok).toBe(false)
    expect(parseTimeReviewEventRequest({ event: 'REOPEN', state_version: 1, reason: 'payroll fix' }).ok).toBe(true)
  })
  it('coerces stringified state_version (offline-replay path)', () => {
    const r = parseTimeReviewEventRequest({ event: 'APPROVE', state_version: '7' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(7)
  })
  it('rejects unknown event types', () => {
    expect(parseTimeReviewEventRequest({ event: 'LOCK_ENTRIES', state_version: 1 }).ok).toBe(false)
  })
})

describe('timeReviewWorkflow registry', () => {
  it('exposes reducer + metadata', () => {
    expect(timeReviewWorkflow.name).toBe('time_review_run')
    expect(timeReviewWorkflow.initialState).toBe('pending')
    expect(timeReviewWorkflow.terminalStates).toEqual([])
    expect(timeReviewWorkflow.sideEffectTypes).toEqual(['lock_labor_entries'])
  })
})

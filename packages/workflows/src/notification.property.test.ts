import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  NOTIFICATION_ALL_STATES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FAILURE_KINDS,
  NOTIFICATION_TERMINAL_STATES,
  nextNotificationEvents,
  transitionNotificationWorkflow,
  type NotificationWorkflowEvent,
  type NotificationWorkflowSnapshot,
  type NotificationWorkflowState,
} from './notification.js'

const STATE_GEN: fc.Arbitrary<NotificationWorkflowState> = fc.constantFrom(...NOTIFICATION_ALL_STATES)

const ANY_EVENT: fc.Arbitrary<NotificationWorkflowEvent> = fc.oneof(
  fc.record({
    type: fc.constant('HYDRATE' as const),
    hydrated_at: fc.constant('2026-05-01T09:00:00.000Z'),
    recipient_email: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    type: fc.constant('SEND_REQUESTED' as const),
    requested_at: fc.constant('2026-05-01T09:01:00.000Z'),
  }),
  fc.record({
    type: fc.constant('SEND_SUCCEEDED' as const),
    sent_at: fc.constant('2026-05-01T09:02:00.000Z'),
    channel: fc.constantFrom(...NOTIFICATION_CHANNELS),
  }),
  fc.record({
    type: fc.constant('SEND_FAILED' as const),
    failed_at: fc.constant('2026-05-01T09:02:00.000Z'),
    error: fc.string({ maxLength: 64 }),
    kind: fc.constantFrom(...NOTIFICATION_FAILURE_KINDS),
  }),
  fc.record({
    type: fc.constant('RETRY' as const),
    retried_at: fc.constant('2026-05-01T09:03:00.000Z'),
  }),
  fc.record({
    type: fc.constant('VOID' as const),
    voided_at: fc.constant('2026-05-01T09:04:00.000Z'),
    reason: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
  }),
)

function emptySnapshot(state: NotificationWorkflowState, version: number): NotificationWorkflowSnapshot {
  return { state, state_version: version }
}

function safeReduce(
  snap: NotificationWorkflowSnapshot,
  event: NotificationWorkflowEvent,
): { ok: true; next: NotificationWorkflowSnapshot } | { ok: false } {
  try {
    return { ok: true, next: transitionNotificationWorkflow(snap, event) }
  } catch {
    return { ok: false }
  }
}

describe('notification reducer — property invariants', () => {
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
      fc.property(fc.constantFrom(...NOTIFICATION_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        expect(() => transitionNotificationWorkflow(emptySnapshot(state, 1), event)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const r = safeReduce(emptySnapshot(state, 1), event)
        if (!r.ok) return
        expect(NOTIFICATION_ALL_STATES).toContain(r.next.state)
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

  it('nextEvents(state) only lists human events the reducer actually accepts from that state', () => {
    fc.assert(
      fc.property(STATE_GEN, (state) => {
        for (const affordance of nextNotificationEvents(state)) {
          // Construct a minimal, valid event of the advertised human type
          // and confirm the reducer accepts it from this state.
          const event: NotificationWorkflowEvent =
            affordance.type === 'RETRY'
              ? { type: 'RETRY', retried_at: '2026-05-01T09:03:00.000Z' }
              : { type: 'VOID', voided_at: '2026-05-01T09:04:00.000Z' }
          const r = safeReduce(emptySnapshot(state, 1), event)
          expect(r.ok).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('replaying a random walk twice produces identical snapshots', () => {
    fc.assert(
      fc.property(fc.array(ANY_EVENT, { minLength: 1, maxLength: 12 }), (events) => {
        const initial: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }
        function walk(): NotificationWorkflowSnapshot {
          let snap = initial
          for (const e of events) {
            try {
              snap = transitionNotificationWorkflow(snap, e)
            } catch {
              // skip illegal transitions
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

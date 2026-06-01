import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  isHumanNotificationEvent,
  nextNotificationEvents,
  NOTIFICATION_ALL_STATES,
  NOTIFICATION_TERMINAL_STATES,
  notificationStateToLegacyStatus,
  notificationWorkflow,
  parseNotificationEventRequest,
  transitionNotificationWorkflow,
  type NotificationFailureKind,
  type NotificationWorkflowEvent,
  type NotificationWorkflowSnapshot,
  type NotificationWorkflowState,
} from './notification.js'
import { applyEventLog, type WorkflowEventLogEntry } from './replay.js'

/**
 * Unit tests for the notification workflow reducer.
 *
 * Mirrors the rental-billing test layout:
 *   - happy-path walk through each canonical transition
 *   - terminal-state rejection
 *   - illegal transitions
 *   - parse helper coverage for the wire-format schema
 *   - one applyEventLog replay fixture
 *   - property test (terminal closure + replay determinism + version
 *     monotonicity)
 */

const T0 = '2026-05-10T12:00:00.000Z'
const T1 = '2026-05-10T12:00:01.000Z'
const T2 = '2026-05-10T12:00:02.000Z'
const T3 = '2026-05-10T12:00:03.000Z'

const pendingSnap = (version = 1): NotificationWorkflowSnapshot => ({
  state: 'pending',
  state_version: version,
})

describe('transitionNotificationWorkflow — happy paths', () => {
  it('walks pending → hydrating via HYDRATE', () => {
    const next = transitionNotificationWorkflow(pendingSnap(), {
      type: 'HYDRATE',
      hydrated_at: T0,
      recipient_email: 'alice@example.com',
    })
    expect(next).toMatchObject({
      state: 'hydrating',
      state_version: 2,
      hydrated_at: T0,
      recipient_email: 'alice@example.com',
    })
  })

  it('walks hydrating → sending via SEND_REQUESTED', () => {
    const hydrating = transitionNotificationWorkflow(pendingSnap(), {
      type: 'HYDRATE',
      hydrated_at: T0,
      recipient_email: 'alice@example.com',
    })
    const sending = transitionNotificationWorkflow(hydrating, { type: 'SEND_REQUESTED', requested_at: T1 })
    expect(sending.state).toBe('sending')
    expect(sending.state_version).toBe(3)
    expect(sending.requested_at).toBe(T1)
    expect(sending.recipient_email).toBe('alice@example.com')
  })

  it('walks sending → sent via SEND_SUCCEEDED, recording channel', () => {
    const sending: NotificationWorkflowSnapshot = { state: 'sending', state_version: 3 }
    const sent = transitionNotificationWorkflow(sending, {
      type: 'SEND_SUCCEEDED',
      sent_at: T2,
      channel: 'email',
    })
    expect(sent).toMatchObject({ state: 'sent', state_version: 4, sent_at: T2, channel: 'email' })
  })

  it('walks pending → sending without HYDRATE when recipient_email already set', () => {
    const sending = transitionNotificationWorkflow(pendingSnap(), { type: 'SEND_REQUESTED', requested_at: T0 })
    expect(sending.state).toBe('sending')
    expect(sending.state_version).toBe(2)
  })

  it('walks sending → failed_clerk_not_found on SEND_FAILED kind=clerk_not_found', () => {
    const sending: NotificationWorkflowSnapshot = { state: 'sending', state_version: 2 }
    const next = transitionNotificationWorkflow(sending, {
      type: 'SEND_FAILED',
      failed_at: T1,
      error: 'user deleted',
      kind: 'clerk_not_found',
    })
    expect(next).toMatchObject({
      state: 'failed_clerk_not_found',
      state_version: 3,
      error: 'user deleted',
      failure_kind: 'clerk_not_found',
    })
  })

  it('walks sending → failed_clerk_unreachable on SEND_FAILED kind=clerk_unreachable', () => {
    const sending: NotificationWorkflowSnapshot = { state: 'sending', state_version: 2 }
    const next = transitionNotificationWorkflow(sending, {
      type: 'SEND_FAILED',
      failed_at: T1,
      error: 'ECONNRESET',
      kind: 'clerk_unreachable',
    })
    expect(next.state).toBe('failed_clerk_unreachable')
    expect(next.failure_kind).toBe('clerk_unreachable')
  })

  it('walks sending → failed_provider on SEND_FAILED kind=provider', () => {
    const sending: NotificationWorkflowSnapshot = { state: 'sending', state_version: 2 }
    const next = transitionNotificationWorkflow(sending, {
      type: 'SEND_FAILED',
      failed_at: T1,
      error: 'smtp 5xx',
      kind: 'provider',
    })
    expect(next.state).toBe('failed_provider')
    expect(next.failure_kind).toBe('provider')
  })

  it('walks hydrating → failed_* on SEND_FAILED (Clerk classifies here)', () => {
    const hydrating: NotificationWorkflowSnapshot = { state: 'hydrating', state_version: 2 }
    const next = transitionNotificationWorkflow(hydrating, {
      type: 'SEND_FAILED',
      failed_at: T1,
      error: 'user not found',
      kind: 'clerk_not_found',
    })
    expect(next.state).toBe('failed_clerk_not_found')
  })

  it('walks failed_provider → pending via RETRY, clearing failure metadata', () => {
    const failed: NotificationWorkflowSnapshot = {
      state: 'failed_provider',
      state_version: 3,
      error: 'smtp 5xx',
      failure_kind: 'provider',
    }
    const retried = transitionNotificationWorkflow(failed, { type: 'RETRY', retried_at: T2 })
    expect(retried).toMatchObject({
      state: 'pending',
      state_version: 4,
      retried_at: T2,
      error: null,
      failure_kind: null,
    })
  })

  it('walks failed_clerk_unreachable → pending via RETRY', () => {
    const failed: NotificationWorkflowSnapshot = {
      state: 'failed_clerk_unreachable',
      state_version: 3,
      error: 'ECONNRESET',
      failure_kind: 'clerk_unreachable',
    }
    const retried = transitionNotificationWorkflow(failed, { type: 'RETRY', retried_at: T2 })
    expect(retried.state).toBe('pending')
  })

  it('voids a pending row via VOID', () => {
    const next = transitionNotificationWorkflow(pendingSnap(), {
      type: 'VOID',
      voided_at: T0,
      reason: 'operator cancelled',
    })
    expect(next).toMatchObject({ state: 'voided', state_version: 2, voided_at: T0, error: 'operator cancelled' })
  })

  it('voids a failed_provider row via VOID', () => {
    const failed: NotificationWorkflowSnapshot = { state: 'failed_provider', state_version: 3 }
    const next = transitionNotificationWorkflow(failed, { type: 'VOID', voided_at: T0 })
    expect(next.state).toBe('voided')
  })
})

describe('transitionNotificationWorkflow — illegal transitions', () => {
  it('rejects HYDRATE from sent (terminal)', () => {
    expect(() =>
      transitionNotificationWorkflow(
        { state: 'sent', state_version: 4 },
        { type: 'HYDRATE', hydrated_at: T0, recipient_email: 'x@example.com' },
      ),
    ).toThrow(/not allowed/)
  })

  it('rejects HYDRATE from hydrating (already hydrating)', () => {
    expect(() =>
      transitionNotificationWorkflow(
        { state: 'hydrating', state_version: 2 },
        { type: 'HYDRATE', hydrated_at: T0, recipient_email: 'x@example.com' },
      ),
    ).toThrow(/not allowed/)
  })

  it('rejects SEND_SUCCEEDED from pending (must go through sending)', () => {
    expect(() =>
      transitionNotificationWorkflow(pendingSnap(), {
        type: 'SEND_SUCCEEDED',
        sent_at: T0,
        channel: 'email',
      }),
    ).toThrow(/not allowed/)
  })

  it('rejects RETRY from failed_clerk_not_found (terminal-only failure)', () => {
    expect(() =>
      transitionNotificationWorkflow(
        { state: 'failed_clerk_not_found', state_version: 3 },
        { type: 'RETRY', retried_at: T1 },
      ),
    ).toThrow(/not allowed/)
  })

  it('rejects RETRY from pending', () => {
    expect(() => transitionNotificationWorkflow(pendingSnap(), { type: 'RETRY', retried_at: T0 })).toThrow(
      /not allowed/,
    )
  })

  it('rejects VOID from sending (in-flight protection)', () => {
    expect(() =>
      transitionNotificationWorkflow({ state: 'sending', state_version: 3 }, { type: 'VOID', voided_at: T0 }),
    ).toThrow(/not allowed/)
  })

  it('rejects VOID from sent', () => {
    expect(() =>
      transitionNotificationWorkflow({ state: 'sent', state_version: 4 }, { type: 'VOID', voided_at: T0 }),
    ).toThrow(/not allowed/)
  })

  it('rejects VOID from voided (no double-terminal)', () => {
    expect(() =>
      transitionNotificationWorkflow({ state: 'voided', state_version: 4 }, { type: 'VOID', voided_at: T0 }),
    ).toThrow(/not allowed/)
  })

  it('accepts SEND_FAILED from pending (Clerk failed before HYDRATE could run)', () => {
    // The runner needs to land a row in failed_clerk_unreachable /
    // failed_clerk_not_found even when the Clerk call exhausted the
    // attempt cap before it transitioned through `hydrating` — see
    // the SEND_FAILED comment in the reducer for the rationale.
    const next = transitionNotificationWorkflow(pendingSnap(), {
      type: 'SEND_FAILED',
      failed_at: T0,
      error: 'ECONNRESET',
      kind: 'clerk_unreachable',
    })
    expect(next.state).toBe('failed_clerk_unreachable')
  })
})

describe('nextNotificationEvents', () => {
  it('exposes VOID from pending and hydrating', () => {
    expect(
      nextNotificationEvents('pending')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['VOID'])
    expect(
      nextNotificationEvents('hydrating')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['VOID'])
  })
  it('exposes RETRY and VOID from retryable failures', () => {
    expect(
      nextNotificationEvents('failed_provider')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['RETRY', 'VOID'])
    expect(
      nextNotificationEvents('failed_clerk_unreachable')
        .map((e) => e.type)
        .sort(),
    ).toEqual(['RETRY', 'VOID'])
  })
  it('exposes nothing from sending (worker is acting)', () => {
    expect(nextNotificationEvents('sending')).toEqual([])
  })
  it('exposes nothing from terminal states', () => {
    expect(nextNotificationEvents('sent')).toEqual([])
    expect(nextNotificationEvents('failed_clerk_not_found')).toEqual([])
    expect(nextNotificationEvents('voided')).toEqual([])
  })
})

describe('isHumanNotificationEvent', () => {
  it('accepts every human event', () => {
    expect(isHumanNotificationEvent('RETRY')).toBe(true)
    expect(isHumanNotificationEvent('VOID')).toBe(true)
  })
  it('rejects worker-only events', () => {
    expect(isHumanNotificationEvent('HYDRATE')).toBe(false)
    expect(isHumanNotificationEvent('SEND_REQUESTED')).toBe(false)
    expect(isHumanNotificationEvent('SEND_SUCCEEDED')).toBe(false)
    expect(isHumanNotificationEvent('SEND_FAILED')).toBe(false)
  })
  it('rejects garbage', () => {
    expect(isHumanNotificationEvent('garbage')).toBe(false)
  })
})

describe('parseNotificationEventRequest', () => {
  it('accepts a well-formed RETRY request', () => {
    const result = parseNotificationEventRequest({ event: 'RETRY', state_version: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ event: 'RETRY', state_version: 3 })
  })

  it('accepts VOID with an optional reason', () => {
    const result = parseNotificationEventRequest({ event: 'VOID', state_version: 2, reason: 'duplicate' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toMatchObject({ event: 'VOID', reason: 'duplicate' })
  })

  it('accepts VOID without a reason', () => {
    const result = parseNotificationEventRequest({ event: 'VOID', state_version: 1 })
    expect(result.ok).toBe(true)
  })

  it('accepts state_version as a numeric string (offline-replay path)', () => {
    const result = parseNotificationEventRequest({ event: 'RETRY', state_version: '7' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.state_version).toBe(7)
  })

  it('rejects worker-only events at the API boundary', () => {
    for (const evt of ['HYDRATE', 'SEND_REQUESTED', 'SEND_SUCCEEDED', 'SEND_FAILED']) {
      const result = parseNotificationEventRequest({ event: evt, state_version: 1 })
      expect(result.ok).toBe(false)
    }
  })

  it('rejects unknown event types', () => {
    expect(parseNotificationEventRequest({ event: 'BOGUS', state_version: 1 }).ok).toBe(false)
  })

  it('rejects zero / negative / non-integer state_version', () => {
    expect(parseNotificationEventRequest({ event: 'RETRY', state_version: 0 }).ok).toBe(false)
    expect(parseNotificationEventRequest({ event: 'RETRY', state_version: -1 }).ok).toBe(false)
    expect(parseNotificationEventRequest({ event: 'RETRY', state_version: 1.5 }).ok).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(parseNotificationEventRequest({ event: 'RETRY' }).ok).toBe(false)
    expect(parseNotificationEventRequest({ state_version: 1 }).ok).toBe(false)
    expect(parseNotificationEventRequest({}).ok).toBe(false)
  })

  it('handles non-object bodies safely', () => {
    expect(parseNotificationEventRequest(null).ok).toBe(false)
    expect(parseNotificationEventRequest(undefined).ok).toBe(false)
    expect(parseNotificationEventRequest('not an object').ok).toBe(false)
    expect(parseNotificationEventRequest(['array']).ok).toBe(false)
  })
})

describe('applyEventLog replay fixture', () => {
  it('replays a full hydrate → send → fail → retry → send fixture', () => {
    // Walk a single row through the canonical recovery path:
    //   pending → HYDRATE → hydrating → SEND_REQUESTED → sending
    //           → SEND_FAILED(provider) → failed_provider
    //           → RETRY → pending → SEND_REQUESTED → sending
    //           → SEND_SUCCEEDED → sent
    // Build the log by walking the reducer, then feed it back through
    // applyEventLog and confirm the final snapshot matches the
    // hand-walked one.
    const initial = pendingSnap(0)
    const events: NotificationWorkflowEvent[] = [
      { type: 'HYDRATE', hydrated_at: T0, recipient_email: 'alice@example.com' },
      { type: 'SEND_REQUESTED', requested_at: T1 },
      { type: 'SEND_FAILED', failed_at: T1, error: 'smtp 5xx', kind: 'provider' },
      { type: 'RETRY', retried_at: T2 },
      { type: 'SEND_REQUESTED', requested_at: T2 },
      { type: 'SEND_SUCCEEDED', sent_at: T3, channel: 'email' },
    ]

    const log: WorkflowEventLogEntry[] = []
    let cur: NotificationWorkflowSnapshot = initial
    for (const event of events) {
      const stateVersionBefore = cur.state_version
      const next = transitionNotificationWorkflow(cur, event)
      log.push({
        workflow_name: 'notification',
        schema_version: 1,
        entity_id: 'notif-fixture-1',
        state_version: stateVersionBefore,
        event_payload: event as unknown as { type: string; [k: string]: unknown },
        snapshot_after: next as unknown as { state: string; state_version: number; [k: string]: unknown },
      })
      cur = next
    }

    const replay = applyEventLog<NotificationWorkflowSnapshot>(initial, log)
    expect(replay.ok).toBe(true)
    expect(replay.issues).toEqual([])
    expect(replay.finalSnapshot?.state).toBe('sent')
    expect(replay.finalSnapshot?.state_version).toBe(6)
    expect(replay.finalSnapshot?.channel).toBe('email')
    expect(replay.finalSnapshot?.recipient_email).toBe('alice@example.com')
  })

  it('flags a tampered log row as snapshot_divergence', () => {
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: 'notification',
        schema_version: 1,
        entity_id: 'notif-fixture-2',
        state_version: 0,
        event_payload: { type: 'HYDRATE', hydrated_at: T0, recipient_email: 'alice@example.com' },
        // Tampered: the persisted snapshot claims `sent` after one HYDRATE.
        snapshot_after: { state: 'sent', state_version: 1 },
      },
    ]
    const replay = applyEventLog<NotificationWorkflowSnapshot>(pendingSnap(0), log)
    expect(replay.ok).toBe(false)
    expect(replay.issues[0]?.reason).toBe('snapshot_divergence')
  })
})

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

const FAILURE_KIND_GEN: fc.Arbitrary<NotificationFailureKind> = fc.constantFrom(
  'clerk_not_found',
  'clerk_unreachable',
  'provider',
)

const WORKER_EVENT_GENERATORS: Array<fc.Arbitrary<NotificationWorkflowEvent>> = [
  fc.record({
    type: fc.constant('HYDRATE' as const),
    hydrated_at: fc.constant(T0),
    recipient_email: fc.string({ minLength: 1, maxLength: 32 }).map((s) => `${s}@example.com`),
  }),
  fc.record({ type: fc.constant('SEND_REQUESTED' as const), requested_at: fc.constant(T0) }),
  fc.record({
    type: fc.constant('SEND_SUCCEEDED' as const),
    sent_at: fc.constant(T0),
    channel: fc.constantFrom(
      'push' as const,
      'sms' as const,
      'email' as const,
      'console' as const,
      'broadcast' as const,
    ),
  }),
  fc.record({
    type: fc.constant('SEND_FAILED' as const),
    failed_at: fc.constant(T0),
    error: fc.string({ maxLength: 64 }),
    kind: FAILURE_KIND_GEN,
  }),
]

const HUMAN_EVENT_GENERATORS: Array<fc.Arbitrary<NotificationWorkflowEvent>> = [
  fc.record({ type: fc.constant('RETRY' as const), retried_at: fc.constant(T0) }),
  fc.record({ type: fc.constant('VOID' as const), voided_at: fc.constant(T0) }),
]

const ANY_EVENT = fc.oneof(...WORKER_EVENT_GENERATORS, ...HUMAN_EVENT_GENERATORS)
const STATE_GEN: fc.Arbitrary<NotificationWorkflowState> = fc.constantFrom(...NOTIFICATION_ALL_STATES)

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
        const snap = emptySnapshot(state, version)
        const result = safeReduce(snap, event)
        if (!result.ok) return
        expect(result.next.state_version).toBe(version + 1)
      }),
    )
  })

  it('terminal states reject every event', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NOTIFICATION_TERMINAL_STATES), ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 1)
        expect(() => transitionNotificationWorkflow(snap, event)).toThrow()
      }),
    )
  })

  it('reducer output state is always within the declared state set', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const result = safeReduce(emptySnapshot(state, 1), event)
        if (!result.ok) return
        expect(NOTIFICATION_ALL_STATES).toContain(result.next.state)
      }),
    )
  })

  it('reducer is deterministic — same input twice yields equal output', () => {
    fc.assert(
      fc.property(STATE_GEN, ANY_EVENT, (state, event) => {
        const snap = emptySnapshot(state, 7)
        const a = safeReduce(snap, event)
        const b = safeReduce(snap, event)
        expect(a.ok).toBe(b.ok)
        if (a.ok && b.ok) expect(a.next).toEqual(b.next)
      }),
    )
  })

  it('every state nextEvents references is actually accepted by the reducer', () => {
    for (const state of NOTIFICATION_ALL_STATES) {
      const events = nextNotificationEvents(state)
      for (const next of events) {
        const snap = emptySnapshot(state, 1)
        const event: NotificationWorkflowEvent =
          next.type === 'RETRY' ? { type: 'RETRY', retried_at: T0 } : { type: 'VOID', voided_at: T0 }
        expect(() => transitionNotificationWorkflow(snap, event)).not.toThrow()
      }
    }
  })

  it('isHumanEvent and worker-only events partition the event set', () => {
    const human = ['RETRY', 'VOID']
    const worker = ['HYDRATE', 'SEND_REQUESTED', 'SEND_SUCCEEDED', 'SEND_FAILED']
    for (const t of human) expect(notificationWorkflow.isHumanEvent(t)).toBe(true)
    for (const t of worker) expect(notificationWorkflow.isHumanEvent(t)).toBe(false)
  })

  it('replay determinism: rebuilt log replays to the same final snapshot every time', () => {
    // Walk the reducer through a known sequence; the property asserts
    // that running the same event list through applyEventLog twice
    // yields identical snapshots. Catches non-deterministic reducer
    // drift (e.g. accidental Date.now() / Math.random() insertion).
    const events: NotificationWorkflowEvent[] = [
      { type: 'HYDRATE', hydrated_at: T0, recipient_email: 'a@example.com' },
      { type: 'SEND_REQUESTED', requested_at: T1 },
      { type: 'SEND_SUCCEEDED', sent_at: T2, channel: 'email' },
    ]
    const buildLog = (): WorkflowEventLogEntry[] => {
      let cur: NotificationWorkflowSnapshot = pendingSnap(0)
      const out: WorkflowEventLogEntry[] = []
      for (const event of events) {
        const stateVersionBefore = cur.state_version
        const next = transitionNotificationWorkflow(cur, event)
        out.push({
          workflow_name: 'notification',
          schema_version: 1,
          entity_id: 'n-replay',
          state_version: stateVersionBefore,
          event_payload: event as unknown as { type: string; [k: string]: unknown },
          snapshot_after: next as unknown as { state: string; state_version: number; [k: string]: unknown },
        })
        cur = next
      }
      return out
    }
    const a = applyEventLog<NotificationWorkflowSnapshot>(pendingSnap(0), buildLog())
    const b = applyEventLog<NotificationWorkflowSnapshot>(pendingSnap(0), buildLog())
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.finalSnapshot).toEqual(b.finalSnapshot)
  })
})

describe('notificationStateToLegacyStatus collapse map', () => {
  it('collapses all eight canonical states to the legacy five-value vocabulary', () => {
    const collapsed = Object.fromEntries(NOTIFICATION_ALL_STATES.map((s) => [s, notificationStateToLegacyStatus(s)]))
    expect(collapsed).toEqual({
      pending: 'pending',
      hydrating: 'pending',
      sending: 'sending',
      sent: 'sent',
      failed_clerk_not_found: 'failed',
      failed_clerk_unreachable: 'failed',
      failed_provider: 'failed',
      voided: 'voided',
    })
  })

  it('only ever produces a value from the legacy five-value vocabulary', () => {
    const legacyVocab = new Set(['pending', 'sending', 'sent', 'failed', 'voided'])
    for (const state of NOTIFICATION_ALL_STATES) {
      expect(legacyVocab.has(notificationStateToLegacyStatus(state))).toBe(true)
    }
  })
})

import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Notification delivery workflow — lifts the implicit status flips in
 * `apps/worker/src/runners/notification.ts` (and the batch drain in
 * `apps/worker/src/notifications.ts`) into a deterministic reducer
 * with full workflow_event_log audit support.
 *
 * Prior to this workflow the row lifecycle lived in scattered
 * `update notifications set status = 'failed'` / `set status = 'sent'`
 * SQL fragments that overloaded a single `status` text column with ~20
 * implicit states (clerk-not-found, clerk-rate-limited, provider-error,
 * deferred, etc.). This reducer is the canonical transition table; the
 * runner is a thin wrapper that reads the row, applies the reducer,
 * writes the new state + state_version, and persists the event payload
 * through `recordWorkflowEvent`.
 *
 * States:
 *   pending                   — initial; row queued, no work done yet
 *   hydrating                 — resolving recipient_clerk_user_id → email
 *                               via the Clerk resolver
 *   sending                   — dispatcher is actively pushing to a channel
 *                               (push / sms / email / console)
 *   sent                      — terminal success; row delivered
 *   failed_clerk_not_found    — terminal; Clerk reports user not found,
 *                               no further attempts will help
 *   failed_clerk_unreachable  — retryable; Clerk threw or returned an
 *                               unreachable code, retry after backoff
 *   failed_provider           — retryable; the channel send itself failed
 *                               (smtp 5xx, twilio error, etc.)
 *   voided                    — terminal; operator/system cancelled this row
 *
 * Events:
 *   HYDRATE          { hydrated_at, recipient_email }
 *                    pending → hydrating
 *                    Worker began the Clerk lookup. recipient_email is
 *                    the persisted email column AFTER hydration (the
 *                    runner writes this back to the row so subsequent
 *                    retries skip the Clerk call).
 *   SEND_REQUESTED   { requested_at }
 *                    pending | hydrating | failed_provider |
 *                    failed_clerk_unreachable → sending
 *                    The dispatcher is being invoked. From a fresh row
 *                    with a literal recipient_email this skips the
 *                    hydrating state. From the failed_* states this is
 *                    the retry path.
 *   SEND_SUCCEEDED   { sent_at, channel }
 *                    sending → sent. Terminal.
 *   SEND_FAILED      { failed_at, error, kind }
 *                    sending | hydrating → failed_clerk_not_found |
 *                                          failed_clerk_unreachable |
 *                                          failed_provider
 *                    `kind` discriminates which failure terminal we
 *                    land in. Kept as a single event type rather than
 *                    three so the dispatcher → reducer surface stays
 *                    narrow (the runner classifies once).
 *   RETRY            { retried_at }
 *                    failed_provider | failed_clerk_unreachable → pending
 *                    Operator or worker queued a retry. Re-enters the
 *                    `pending` state so the runner's normal claim path
 *                    picks it up under FOR UPDATE SKIP LOCKED.
 *   VOID             { voided_at, reason? }
 *                    pending | hydrating | failed_provider |
 *                    failed_clerk_unreachable → voided. Terminal.
 *                    Cannot void a row that's actively `sending` (the
 *                    dispatcher is in-flight — wait for SEND_SUCCEEDED
 *                    or SEND_FAILED) and cannot void a `sent` row.
 *                    `failed_clerk_not_found` is already terminal so
 *                    voiding it is a no-op surface; we keep it out of
 *                    the allow list to avoid double-terminal confusion.
 *
 * Side effects: none from the reducer. The runner's rate-limit /
 * backoff bookkeeping (next_attempt_at, delivery_attempts) stays
 * procedural in `apps/worker/src/notifications.ts` — those are
 * scheduling concerns, not workflow states, and modelling them as
 * states would explode the transition table without making the audit
 * trail any cleaner.
 *
 * Every `*_at` timestamp travels on the event itself. The reducer
 * never reads `Date.now()` / `new Date()` / `Math.random()`, mirroring
 * the discipline of every other workflow in this package.
 */

export type NotificationWorkflowState =
  | 'pending'
  | 'hydrating'
  | 'sending'
  | 'sent'
  | 'failed_clerk_not_found'
  | 'failed_clerk_unreachable'
  | 'failed_provider'
  | 'voided'

export const NOTIFICATION_WORKFLOW_NAME = 'notification'
export const NOTIFICATION_WORKFLOW_SCHEMA_VERSION = 1
export const NOTIFICATION_ALL_STATES: readonly NotificationWorkflowState[] = [
  'pending',
  'hydrating',
  'sending',
  'sent',
  'failed_clerk_not_found',
  'failed_clerk_unreachable',
  'failed_provider',
  'voided',
]
export const NOTIFICATION_TERMINAL_STATES: readonly NotificationWorkflowState[] = [
  'sent',
  'failed_clerk_not_found',
  'voided',
]
export const NOTIFICATION_EVENT_TYPES = [
  'HYDRATE',
  'SEND_REQUESTED',
  'SEND_SUCCEEDED',
  'SEND_FAILED',
  'RETRY',
  'VOID',
] as const

export const NOTIFICATION_FAILURE_KINDS = ['clerk_not_found', 'clerk_unreachable', 'provider'] as const
export type NotificationFailureKind = (typeof NOTIFICATION_FAILURE_KINDS)[number]

export const NOTIFICATION_CHANNELS = ['push', 'sms', 'email', 'console', 'broadcast'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type NotificationWorkflowEvent =
  | { type: 'HYDRATE'; hydrated_at: string; recipient_email: string }
  | { type: 'SEND_REQUESTED'; requested_at: string }
  | { type: 'SEND_SUCCEEDED'; sent_at: string; channel: NotificationChannel }
  | { type: 'SEND_FAILED'; failed_at: string; error: string; kind: NotificationFailureKind }
  | { type: 'RETRY'; retried_at: string }
  | { type: 'VOID'; voided_at: string; reason?: string | null }

export interface NotificationWorkflowSnapshot {
  state: NotificationWorkflowState
  state_version: number
  /** Persisted email AFTER a successful HYDRATE. Null until then. */
  recipient_email?: string | null
  hydrated_at?: string | null
  requested_at?: string | null
  sent_at?: string | null
  failed_at?: string | null
  retried_at?: string | null
  voided_at?: string | null
  /** Channel that delivered the row on SEND_SUCCEEDED. */
  channel?: NotificationChannel | null
  /** Last error string from the most recent SEND_FAILED, truncated by
   *  the runner. Cleared on RETRY / VOID. */
  error?: string | null
  /** Discriminator for the failure terminal. Cleared on RETRY / VOID. */
  failure_kind?: NotificationFailureKind | null
}

function assertNotificationTransition(
  state: NotificationWorkflowState,
  allowed: readonly NotificationWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from notification state ${state}`)
  }
}

/**
 * Pure transition reducer for notification delivery. No wall-clock
 * reads, no random ids, no IO — same contract as every other reducer
 * in this package. The runner owns next_attempt_at / delivery_attempts
 * bookkeeping; this function only owns the (state, state_version,
 * audit-field) triple.
 */
export function transitionNotificationWorkflow(
  snapshot: NotificationWorkflowSnapshot,
  event: NotificationWorkflowEvent,
): NotificationWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'HYDRATE') {
    assertNotificationTransition(snapshot.state, ['pending'], event.type)
    return {
      ...snapshot,
      state: 'hydrating',
      state_version: nextVersion,
      hydrated_at: event.hydrated_at,
      recipient_email: event.recipient_email,
      error: null,
      failure_kind: null,
    }
  }
  if (event.type === 'SEND_REQUESTED') {
    assertNotificationTransition(
      snapshot.state,
      ['pending', 'hydrating', 'failed_provider', 'failed_clerk_unreachable'],
      event.type,
    )
    return {
      ...snapshot,
      state: 'sending',
      state_version: nextVersion,
      requested_at: event.requested_at,
      error: null,
      failure_kind: null,
    }
  }
  if (event.type === 'SEND_SUCCEEDED') {
    assertNotificationTransition(snapshot.state, ['sending'], event.type)
    return {
      ...snapshot,
      state: 'sent',
      state_version: nextVersion,
      sent_at: event.sent_at,
      channel: event.channel,
      error: null,
      failure_kind: null,
    }
  }
  if (event.type === 'SEND_FAILED') {
    // SEND_FAILED can land from:
    //   `sending`   — dispatcher / provider error
    //   `hydrating` — a Clerk call that started under HYDRATE failed
    //   `pending`   — a Clerk call that hadn't reached HYDRATE yet
    //                 failed (e.g. resolver threw or returned
    //                 `unreachable` before the email was hydrated and
    //                 the row's delivery cap was already exhausted)
    // Keeping all three sources on a single event type avoids growing
    // a parallel HYDRATE_FAILED → failed_clerk_* branch with the same
    // downstream shape.
    assertNotificationTransition(snapshot.state, ['pending', 'sending', 'hydrating'], event.type)
    const nextState: NotificationWorkflowState =
      event.kind === 'clerk_not_found'
        ? 'failed_clerk_not_found'
        : event.kind === 'clerk_unreachable'
          ? 'failed_clerk_unreachable'
          : 'failed_provider'
    return {
      ...snapshot,
      state: nextState,
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
      failure_kind: event.kind,
    }
  }
  if (event.type === 'RETRY') {
    assertNotificationTransition(snapshot.state, ['failed_provider', 'failed_clerk_unreachable'], event.type)
    return {
      ...snapshot,
      state: 'pending',
      state_version: nextVersion,
      retried_at: event.retried_at,
      error: null,
      failure_kind: null,
    }
  }
  if (event.type === 'VOID') {
    // VOID — terminal. Allowed from any non-terminal, non-sending state.
    // Excluding `sending` keeps in-flight dispatches from being voided
    // out from under the runner; excluding the terminal states (`sent`,
    // `failed_clerk_not_found`, `voided`) preserves the no-double-
    // terminal invariant.
    assertNotificationTransition(
      snapshot.state,
      ['pending', 'hydrating', 'failed_provider', 'failed_clerk_unreachable'],
      event.type,
    )
    return {
      ...snapshot,
      state: 'voided',
      state_version: nextVersion,
      voided_at: event.voided_at,
      error: event.reason ?? null,
      failure_kind: null,
    }
  }
  // Exhaustiveness guard: every member of NotificationWorkflowEvent is
  // handled above, so `event` narrows to `never`. A new event type added to
  // the union without a branch is a compile error — it can no longer
  // silently misroute into the old VOID catch-all and void a live row.
  const exhaustive: never = event
  throw new Error(`unhandled notification event ${JSON.stringify(exhaustive)}`)
}

export type NotificationHumanEventType = 'RETRY' | 'VOID'

/**
 * Human-dispatchable events from a given state. The send path
 * (HYDRATE / SEND_REQUESTED / SEND_SUCCEEDED / SEND_FAILED) is
 * worker-only — the runner emits those automatically as it walks a
 * row through the pipeline. Humans can RETRY a retryable failure or
 * VOID a row that hasn't shipped yet.
 */
export function nextNotificationEvents(
  state: NotificationWorkflowState,
): Array<WorkflowNextEvent<NotificationHumanEventType>> {
  switch (state) {
    case 'pending':
    case 'hydrating':
      return [{ type: 'VOID', label: 'Cancel notification' }]
    case 'failed_provider':
    case 'failed_clerk_unreachable':
      return [
        { type: 'RETRY', label: 'Retry delivery' },
        { type: 'VOID', label: 'Cancel notification' },
      ]
    case 'sending':
    case 'sent':
    case 'failed_clerk_not_found':
    case 'voided':
      return []
  }
}

export function isHumanNotificationEvent(eventType: string): eventType is NotificationHumanEventType {
  return eventType === 'RETRY' || eventType === 'VOID'
}

/**
 * Collapse the reducer's eight canonical states down to the legacy
 * five-value `notifications.status` vocabulary
 * (`pending | sending | sent | failed | voided`).
 *
 * The canonical state vocabulary lives on `workflow_event_log` and is
 * replayable; `notifications.status` is a derived cache kept for legacy
 * per-recipient reads. This is the SINGLE source for the collapse so the
 * worker (which writes the column as it drives a row through the
 * pipeline) and the API route (which writes it on the human RETRY/VOID
 * path) can never drift. Exhaustive `switch` over `NotificationWorkflowState`
 * so adding a new reducer state forces a compile error here.
 *
 * The `failed_*` triplet collapses to a single `failed` — the lost
 * `failure_kind` is recoverable from the event log; the legacy column is
 * intentionally lossy.
 */
export function notificationStateToLegacyStatus(state: NotificationWorkflowState): string {
  switch (state) {
    case 'pending':
    case 'hydrating':
      return 'pending'
    case 'sending':
      return 'sending'
    case 'sent':
      return 'sent'
    case 'failed_clerk_not_found':
    case 'failed_clerk_unreachable':
    case 'failed_provider':
      return 'failed'
    case 'voided':
      return 'voided'
  }
}

export const notificationWorkflow = registerWorkflow<
  NotificationWorkflowState,
  NotificationWorkflowEvent,
  NotificationHumanEventType,
  NotificationWorkflowSnapshot
>({
  name: NOTIFICATION_WORKFLOW_NAME,
  schemaVersion: NOTIFICATION_WORKFLOW_SCHEMA_VERSION,
  initialState: 'pending',
  terminalStates: NOTIFICATION_TERMINAL_STATES,
  allStates: NOTIFICATION_ALL_STATES,
  allEventTypes: NOTIFICATION_EVENT_TYPES,
  reduce: transitionNotificationWorkflow,
  nextEvents: nextNotificationEvents,
  isHumanEvent: isHumanNotificationEvent,
  // Reducer is side-effect-free; the runner's rate-limit / backoff
  // logic lives outside the workflow boundary and doesn't route
  // through mutation_outbox.
  sideEffectTypes: [] as const,
})

// Wire-format request schema for POST /api/notifications/:id/events.
// Mirrors the rental-billing / time-review convention:
//   { event, state_version, ... }
// Only the human-dispatchable subset (RETRY / VOID) is accepted at
// the API boundary; worker-only events (HYDRATE / SEND_REQUESTED /
// SEND_SUCCEEDED / SEND_FAILED) are rejected here so the dispatcher
// stays the only thing that can transition through `sending`.

const RetryBodySchema = z.object({
  event: z.literal('RETRY'),
  state_version: z.number().int().positive(),
})

const VoidBodySchema = z.object({
  event: z.literal('VOID'),
  state_version: z.number().int().positive(),
  reason: z.string().max(2000).optional(),
})

export const NotificationEventRequestSchema = z.discriminatedUnion('event', [RetryBodySchema, VoidBodySchema])

export type NotificationEventRequest = z.infer<typeof NotificationEventRequestSchema>

export type NotificationEventParseResult = { ok: true; value: NotificationEventRequest } | { ok: false; error: string }

/**
 * Parse a JSON-body Record<string, unknown> as a notification event
 * request. Mirrors `parseRentalBillingEventRequest`: returns a
 * discriminated result so route handlers can render a 400 with the
 * human-readable error without throwing.
 *
 * Numeric `state_version` is accepted as either a number or a numeric
 * string (offline-replay paths sometimes stringify integers).
 */
export function parseNotificationEventRequest(body: unknown): NotificationEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = NotificationEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}

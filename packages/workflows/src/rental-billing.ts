import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

export type RentalBillingWorkflowState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'

export const RENTAL_BILLING_WORKFLOW_NAME = 'rental_billing_run'
export const RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION = 1
export const RENTAL_BILLING_ALL_STATES: readonly RentalBillingWorkflowState[] = [
  'generated',
  'approved',
  'posting',
  'posted',
  'failed',
  'voided',
]
export const RENTAL_BILLING_TERMINAL_STATES: readonly RentalBillingWorkflowState[] = ['posted', 'voided']
export const RENTAL_BILLING_EVENT_TYPES = [
  'APPROVE',
  'POST_REQUESTED',
  'POST_SUCCEEDED',
  'POST_FAILED',
  'RETRY_POST',
  'CANCEL_POST',
  'VOID',
] as const

export type RentalBillingWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | { type: 'POST_REQUESTED' }
  | { type: 'POST_SUCCEEDED'; posted_at: string; qbo_invoice_id: string }
  | { type: 'POST_FAILED'; failed_at: string; error: string }
  | { type: 'RETRY_POST' }
  // Human escape hatch from a wedged 'posting' run (e.g. a permanently
  // failing QBO push that never emits a terminal worker event). Lands the
  // run in 'failed' — NOT 'voided' — so the operator can inspect, then
  // RETRY_POST (replays the same idempotency-keyed outbox row, which the
  // worker's qbo_invoice_id check makes safe) or VOID. Deliberately distinct
  // from VOID so we never create a "void a live push" path that could orphan
  // a real QBO invoice mid-creation.
  | { type: 'CANCEL_POST'; failed_at: string; error: string }
  | { type: 'VOID' }

export interface RentalBillingWorkflowSnapshot {
  state: RentalBillingWorkflowState
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
  posted_at?: string | null
  failed_at?: string | null
  error?: string | null
  qbo_invoice_id?: string | null
}

/**
 * The persisted-row shape the reducer needs. Both the API route and the
 * queue worker map their `rental_billing_runs` DB rows through this single
 * helper so the row→snapshot map is shared, not duplicated. The persisted
 * column is `status`; the reducer calls it `state`.
 */
export type RentalBillingRowLike = {
  status: string
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
  posted_at?: string | null
  failed_at?: string | null
  error?: string | null
  qbo_invoice_id?: string | null
}

export function rentalBillingRowToSnapshot(row: RentalBillingRowLike): RentalBillingWorkflowSnapshot {
  return {
    state: row.status as RentalBillingWorkflowState,
    state_version: row.state_version,
    approved_at: row.approved_at ?? null,
    approved_by: row.approved_by ?? null,
    posted_at: row.posted_at ?? null,
    failed_at: row.failed_at ?? null,
    error: row.error ?? null,
    qbo_invoice_id: row.qbo_invoice_id ?? null,
  }
}

function assertRentalBillingTransition(
  state: RentalBillingWorkflowState,
  allowed: readonly RentalBillingWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from rental billing state ${state}`)
  }
}

/**
 * Pure transition reducer for rental billing runs. Intentionally has no
 * wall-clock reads, random ids, network calls, or DB access so the same
 * transition table can be used from an API handler, XState machine, or
 * Temporal workflow activity boundary.
 */
export function transitionRentalBillingWorkflow(
  snapshot: RentalBillingWorkflowSnapshot,
  event: RentalBillingWorkflowEvent,
): RentalBillingWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'APPROVE') {
    assertRentalBillingTransition(snapshot.state, ['generated'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      approved_at: event.approved_at,
      approved_by: event.approved_by,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_REQUESTED') {
    assertRentalBillingTransition(snapshot.state, ['approved', 'failed'], event.type)
    return {
      ...snapshot,
      state: 'posting',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_SUCCEEDED') {
    assertRentalBillingTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'posted',
      state_version: nextVersion,
      posted_at: event.posted_at,
      qbo_invoice_id: event.qbo_invoice_id,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'POST_FAILED') {
    assertRentalBillingTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'failed',
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
    }
  }
  if (event.type === 'RETRY_POST') {
    assertRentalBillingTransition(snapshot.state, ['failed'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      error: null,
      failed_at: null,
    }
  }
  if (event.type === 'CANCEL_POST') {
    // Operator-acknowledged escape from a stuck push. Only legal from
    // 'posting'; lands in 'failed' with the operator-supplied marker so the
    // existing failed → RETRY_POST | VOID affordances apply. Emits no
    // outbox row (it is the absence of a push). The worker's
    // status !== 'posting' early-return cedes any later push result to this
    // human event; the row lock serializes the race.
    assertRentalBillingTransition(snapshot.state, ['posting'], event.type)
    return {
      ...snapshot,
      state: 'failed',
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
    }
  }
  if (event.type === 'VOID') {
    assertRentalBillingTransition(snapshot.state, ['generated', 'approved', 'failed'], event.type)
    return {
      ...snapshot,
      state: 'voided',
      state_version: nextVersion,
    }
  }
  // Exhaustiveness guard: every member of RentalBillingWorkflowEvent is handled
  // above, so `event` narrows to `never`. A new event type without a branch is
  // a compile error — it can no longer silently misroute into the old VOID
  // catch-all.
  const exhaustive: never = event
  throw new Error(`unhandled rental_billing_run event ${JSON.stringify(exhaustive)}`)
}

export type RentalBillingHumanEventType = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'CANCEL_POST' | 'VOID'

export function nextRentalBillingEvents(
  state: RentalBillingWorkflowState,
): Array<WorkflowNextEvent<RentalBillingHumanEventType>> {
  switch (state) {
    case 'generated':
      return [
        { type: 'APPROVE', label: 'Approve billing run' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'approved':
      return [
        { type: 'POST_REQUESTED', label: 'Post invoice to QuickBooks' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'failed':
      return [
        { type: 'RETRY_POST', label: 'Retry QuickBooks post' },
        { type: 'VOID', label: 'Void' },
      ]
    case 'posting':
      return [{ type: 'CANCEL_POST', label: 'Cancel stuck QuickBooks post' }]
    case 'posted':
    case 'voided':
      return []
  }
}

export function isHumanRentalBillingEvent(eventType: string): eventType is RentalBillingHumanEventType {
  return (
    eventType === 'APPROVE' ||
    eventType === 'POST_REQUESTED' ||
    eventType === 'RETRY_POST' ||
    eventType === 'CANCEL_POST' ||
    eventType === 'VOID'
  )
}

// Wire-format request schema for POST /api/rental-billing-runs/:id/events.
// Workflow event endpoints across the codebase should adopt this same shape:
//   { event: <human-event-type>, state_version: <positive integer> }
// and use Zod to parse so the route never sees an unvalidated body.
export const RentalBillingEventRequestSchema = z.object({
  event: z.enum(['APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'CANCEL_POST', 'VOID']),
  state_version: z.number().int().positive(),
})

export type RentalBillingEventRequest = z.infer<typeof RentalBillingEventRequestSchema>

export type RentalBillingEventParseResult =
  | { ok: true; value: RentalBillingEventRequest }
  | { ok: false; error: string }

/**
 * Parse a JSON-body Record<string, unknown> as a rental-billing event
 * request. Returns a discriminated result so route handlers can render a
 * 400 with the human-readable error without throwing.
 *
 * Numeric `state_version` is accepted as either a number or a numeric
 * string (browsers serialize integers as JSON numbers but offline-replay
 * paths can stringify) — Zod's coerce isn't used because we want to
 * reject non-numeric strings explicitly rather than silently coercing.
 */
export const rentalBillingWorkflow = registerWorkflow<
  RentalBillingWorkflowState,
  RentalBillingWorkflowEvent,
  RentalBillingHumanEventType,
  RentalBillingWorkflowSnapshot
>({
  name: RENTAL_BILLING_WORKFLOW_NAME,
  schemaVersion: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  initialState: 'generated',
  terminalStates: RENTAL_BILLING_TERMINAL_STATES,
  allStates: RENTAL_BILLING_ALL_STATES,
  allEventTypes: RENTAL_BILLING_EVENT_TYPES,
  reduce: transitionRentalBillingWorkflow,
  nextEvents: nextRentalBillingEvents,
  isHumanEvent: isHumanRentalBillingEvent,
  sideEffectTypes: ['post_qbo_invoice'] as const,
})

export function parseRentalBillingEventRequest(body: unknown): RentalBillingEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = RentalBillingEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}

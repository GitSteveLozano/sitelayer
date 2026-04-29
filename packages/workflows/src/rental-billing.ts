import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'

export type RentalBillingWorkflowState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'

export type RentalBillingWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | { type: 'POST_REQUESTED' }
  | { type: 'POST_SUCCEEDED'; posted_at: string; qbo_invoice_id: string }
  | { type: 'POST_FAILED'; failed_at: string; error: string }
  | { type: 'RETRY_POST' }
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
  assertRentalBillingTransition(snapshot.state, ['generated', 'approved', 'failed'], event.type)
  return {
    ...snapshot,
    state: 'voided',
    state_version: nextVersion,
  }
}

export type RentalBillingHumanEventType = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

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
    case 'posted':
    case 'voided':
      return []
  }
}

export function isHumanRentalBillingEvent(eventType: string): eventType is RentalBillingHumanEventType {
  return eventType === 'APPROVE' || eventType === 'POST_REQUESTED' || eventType === 'RETRY_POST' || eventType === 'VOID'
}

// Wire-format request schema for POST /api/rental-billing-runs/:id/events.
// Workflow event endpoints across the codebase should adopt this same shape:
//   { event: <human-event-type>, state_version: <positive integer> }
// and use Zod to parse so the route never sees an unvalidated body.
export const RentalBillingEventRequestSchema = z.object({
  event: z.enum(['APPROVE', 'POST_REQUESTED', 'RETRY_POST', 'VOID']),
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

import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Rental request approval workflow.
 *
 * Lifts the implicit state machine in `rental_requests.status`
 * (pending → approved | declined) into a registered deterministic
 * workflow so the operator approval queue carries the same audit
 * trail (workflow_event_log + replay sweep coverage) as the rental
 * billing pipeline.
 *
 * The reducer is "approval-shaped":
 *
 *   pending   — portal submission awaiting operator review
 *   approved  — operator approved; the route creates one or more
 *               `rentals` rows in the same tx. Reducer emits a
 *               `create_rental_from_request` side effect intent (an
 *               outbox row scoped to this request id) so a future
 *               worker can fan out to additional notifications /
 *               webhooks without revisiting the route.
 *   declined  — operator declined with optional reason; no rental is
 *               created.
 *
 * Terminal states are `approved` and `declined`. Re-approving an
 * already-approved or already-declined request is rejected at the
 * reducer level (the route's existing idempotent re-approve path
 * short-circuits before dispatching).
 *
 * Side effects: `create_rental_from_request` — emitted in the API tx
 * as an outbox row keyed on the rental_request id. Today the route
 * itself creates the rental rows (so the side effect is a no-op for
 * the worker); the outbox row exists as the audit anchor for "this
 * approval resulted in rentals" without coupling the worker drain to
 * the route's behaviour. Bumping the worker to take over rental
 * creation in a follow-up is a pure side-effect change.
 */

export type RentalRequestApprovalWorkflowState = 'pending' | 'approved' | 'declined'

export const RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME = 'rental_request_approval'
export const RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION = 1
export const RENTAL_REQUEST_APPROVAL_ALL_STATES: readonly RentalRequestApprovalWorkflowState[] = [
  'pending',
  'approved',
  'declined',
]
export const RENTAL_REQUEST_APPROVAL_TERMINAL_STATES: readonly RentalRequestApprovalWorkflowState[] = [
  'approved',
  'declined',
]
export const RENTAL_REQUEST_APPROVAL_EVENT_TYPES = ['APPROVE', 'DECLINE'] as const

export type RentalRequestApprovalHumanEventType = (typeof RENTAL_REQUEST_APPROVAL_EVENT_TYPES)[number]

export type RentalRequestApprovalWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | { type: 'DECLINE'; declined_at: string; declined_by: string; decline_reason?: string | null }

export interface RentalRequestApprovalWorkflowSnapshot {
  state: RentalRequestApprovalWorkflowState
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
  declined_at?: string | null
  declined_by?: string | null
  decline_reason?: string | null
}

function assertTransition(
  state: RentalRequestApprovalWorkflowState,
  allowed: readonly RentalRequestApprovalWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`rental_request_approval: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionRentalRequestApprovalWorkflow(
  snapshot: RentalRequestApprovalWorkflowSnapshot,
  event: RentalRequestApprovalWorkflowEvent,
): RentalRequestApprovalWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'APPROVE') {
    assertTransition(snapshot.state, ['pending'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: nextVersion,
      approved_at: event.approved_at,
      approved_by: event.approved_by,
    }
  }
  if (event.type === 'DECLINE') {
    assertTransition(snapshot.state, ['pending'], event.type)
    return {
      ...snapshot,
      state: 'declined',
      state_version: nextVersion,
      declined_at: event.declined_at,
      declined_by: event.declined_by,
      decline_reason: event.decline_reason ?? null,
    }
  }
  // Exhaustive
  const exhaustive: never = event
  throw new Error(`unhandled rental_request_approval event ${JSON.stringify(exhaustive)}`)
}

export function nextRentalRequestApprovalEvents(
  state: RentalRequestApprovalWorkflowState,
): Array<WorkflowNextEvent<RentalRequestApprovalHumanEventType>> {
  switch (state) {
    case 'pending':
      return [
        { type: 'APPROVE', label: 'Approve request' },
        { type: 'DECLINE', label: 'Decline request' },
      ]
    case 'approved':
    case 'declined':
      return []
  }
}

export function isHumanRentalRequestApprovalEvent(eventType: string): eventType is RentalRequestApprovalHumanEventType {
  return eventType === 'APPROVE' || eventType === 'DECLINE'
}

export const rentalRequestApprovalWorkflow = registerWorkflow<
  RentalRequestApprovalWorkflowState,
  RentalRequestApprovalWorkflowEvent,
  RentalRequestApprovalHumanEventType,
  RentalRequestApprovalWorkflowSnapshot
>({
  name: RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
  schemaVersion: RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  initialState: 'pending',
  terminalStates: RENTAL_REQUEST_APPROVAL_TERMINAL_STATES,
  allStates: RENTAL_REQUEST_APPROVAL_ALL_STATES,
  allEventTypes: RENTAL_REQUEST_APPROVAL_EVENT_TYPES,
  reduce: transitionRentalRequestApprovalWorkflow,
  nextEvents: nextRentalRequestApprovalEvents,
  isHumanEvent: isHumanRentalRequestApprovalEvent,
  // APPROVE enqueues a `create_rental_from_request` outbox row in the
  // API tx so the audit trail records "this approval → this rental".
  // The route is the actual creator today; the outbox row is the side-
  // effect anchor.
  sideEffectTypes: ['create_rental_from_request'] as const,
})

export const RentalRequestApprovalEventRequestSchema = z.object({
  event: z.enum(RENTAL_REQUEST_APPROVAL_EVENT_TYPES),
  state_version: z.number().int().positive(),
  decline_reason: z.string().max(2000).optional().nullable(),
})

export type RentalRequestApprovalEventRequest = z.infer<typeof RentalRequestApprovalEventRequestSchema>
export type RentalRequestApprovalEventParseResult =
  | { ok: true; value: RentalRequestApprovalEventRequest }
  | { ok: false; error: string }

export function parseRentalRequestApprovalEventRequest(body: unknown): RentalRequestApprovalEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = RentalRequestApprovalEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}

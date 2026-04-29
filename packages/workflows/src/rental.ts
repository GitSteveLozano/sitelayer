import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Rental workflow — fourth deterministic workflow registration.
 *
 * Phase 1: register the reducer + types so the replay sweep timer
 * covers rentals. Routes (`apps/api/src/routes/rentals.ts`) are NOT
 * yet wired through this reducer — PATCH /api/rentals/:id continues
 * to set status directly, the worker's `processRentalInvoice` flow
 * continues to drive cadence-based transitions. Phase 2 (route
 * rewrite) lands in a follow-up PR.
 *
 * States: active → returned → invoiced_pending → closed.
 *
 * The flow:
 *   active            equipment is on the customer's site
 *     RETURN           → returned (delivery picked back up)
 *     CLOSE            → closed  (manual close without invoice cycle)
 *   returned          back at the yard, awaiting invoice cadence
 *     INVOICE_QUEUED   → invoiced_pending (worker started invoice creation)
 *     CLOSE            → closed
 *   invoiced_pending  invoice posted to customer, awaiting payment / cycle
 *     INVOICE_POSTED   → returned (next cadence cycle starts)
 *     CLOSE            → closed
 *   closed            terminal
 *
 * Cadence-based transitions (RETURN by date, INVOICE_QUEUED by
 * worker tick) emit reducer events from the same code paths the
 * worker already runs. INVOICE_POSTED is emitted after the QBO
 * invoice idempotency key is committed.
 *
 * Phase 2 will introduce a CANCEL/VOID transition once the UI
 * surfaces it; for now CLOSE acts as the catch-all way out.
 */

export type RentalWorkflowState = 'active' | 'returned' | 'invoiced_pending' | 'closed'

export const RENTAL_WORKFLOW_NAME = 'rental'
export const RENTAL_WORKFLOW_SCHEMA_VERSION = 1
export const RENTAL_ALL_STATES: readonly RentalWorkflowState[] = ['active', 'returned', 'invoiced_pending', 'closed']
export const RENTAL_TERMINAL_STATES: readonly RentalWorkflowState[] = ['closed']
export const RENTAL_EVENT_TYPES = ['RETURN', 'INVOICE_QUEUED', 'INVOICE_POSTED', 'CLOSE'] as const

export type RentalWorkflowEvent =
  | { type: 'RETURN'; returned_at: string; returned_by: string }
  | { type: 'INVOICE_QUEUED' }
  | { type: 'INVOICE_POSTED' }
  | { type: 'CLOSE'; closed_at: string; closed_by: string }

export interface RentalWorkflowSnapshot {
  state: RentalWorkflowState
  state_version: number
  returned_at?: string | null
  returned_by?: string | null
  closed_at?: string | null
  closed_by?: string | null
}

function assertRentalTransition(
  state: RentalWorkflowState,
  allowed: readonly RentalWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`event ${eventType} is not allowed from rental state ${state}`)
  }
}

export function transitionRentalWorkflow(
  snapshot: RentalWorkflowSnapshot,
  event: RentalWorkflowEvent,
): RentalWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'RETURN') {
    assertRentalTransition(snapshot.state, ['active'], event.type)
    return {
      ...snapshot,
      state: 'returned',
      state_version: nextVersion,
      returned_at: event.returned_at,
      returned_by: event.returned_by,
    }
  }
  if (event.type === 'INVOICE_QUEUED') {
    assertRentalTransition(snapshot.state, ['returned'], event.type)
    return { ...snapshot, state: 'invoiced_pending', state_version: nextVersion }
  }
  if (event.type === 'INVOICE_POSTED') {
    assertRentalTransition(snapshot.state, ['invoiced_pending'], event.type)
    // Cadence cycle: posted invoices return to 'returned' to wait for
    // the next billing window. CLOSE is the explicit exit.
    return { ...snapshot, state: 'returned', state_version: nextVersion }
  }
  // CLOSE
  assertRentalTransition(snapshot.state, ['active', 'returned', 'invoiced_pending'], event.type)
  return {
    ...snapshot,
    state: 'closed',
    state_version: nextVersion,
    closed_at: event.closed_at,
    closed_by: event.closed_by,
  }
}

export type RentalHumanEventType = 'RETURN' | 'CLOSE'

export function nextRentalEvents(state: RentalWorkflowState): Array<WorkflowNextEvent<RentalHumanEventType>> {
  switch (state) {
    case 'active':
      return [
        { type: 'RETURN', label: 'Mark returned' },
        { type: 'CLOSE', label: 'Close rental' },
      ]
    case 'returned':
      return [{ type: 'CLOSE', label: 'Close rental' }]
    case 'invoiced_pending':
      return [{ type: 'CLOSE', label: 'Close rental' }]
    case 'closed':
      return []
  }
}

export function isHumanRentalEvent(eventType: string): eventType is RentalHumanEventType {
  return eventType === 'RETURN' || eventType === 'CLOSE'
}

export const rentalWorkflow = registerWorkflow<
  RentalWorkflowState,
  RentalWorkflowEvent,
  RentalHumanEventType,
  RentalWorkflowSnapshot
>({
  name: RENTAL_WORKFLOW_NAME,
  schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
  initialState: 'active',
  terminalStates: RENTAL_TERMINAL_STATES,
  allStates: RENTAL_ALL_STATES,
  allEventTypes: RENTAL_EVENT_TYPES,
  reduce: transitionRentalWorkflow,
  nextEvents: nextRentalEvents,
  isHumanEvent: isHumanRentalEvent,
  // INVOICE_QUEUED / INVOICE_POSTED come from the worker's cadence
  // tick; the existing material_bill creation already has its own
  // idempotency key, no separate outbox row needed.
  sideEffectTypes: [] as const,
})

export const RentalEventRequestSchema = z.object({
  event: z.enum(['RETURN', 'CLOSE']),
  state_version: z.number().int().positive(),
})

export type RentalEventRequest = z.infer<typeof RentalEventRequestSchema>
export type RentalEventParseResult = { ok: true; value: RentalEventRequest } | { ok: false; error: string }

export function parseRentalEventRequest(body: unknown): RentalEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = RentalEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}

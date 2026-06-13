import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Rental workflow — deterministic reducer for the rental lifecycle.
 *
 * Phase 1 (LIVE): `apps/api/src/routes/rentals.ts` dispatches the human
 * RETURN and CLOSE transitions through this reducer +
 * `workflow_event_log` (via `applyRentalWorkflowTransition`). PATCH no
 * longer sets `status` / `returned_on` directly — those are owned by the
 * workflow surface (POST /return, /transfer).
 *
 * Phase 2 (LIVE): the worker cadence path. `apps/worker/src/runners/
 * rental-invoice.ts` bills a due RETURNED rental and enqueues a
 * `post_rental_invoice` mutation_outbox row; the dedicated pusher
 * (`apps/worker/src/runners/rental-invoice-push.ts` →
 * `processRentalInvoicePush`) runs the GATED QBO invoice push (real
 * invoice when `QBO_LIVE_RENTAL_INVOICE=1` + the company flag, else a
 * deterministic stub id) and dispatches the INVOICE_QUEUED →
 * INVOICE_POSTED cadence transitions through THIS reducer. This mirrors
 * rental_billing_run's POST_REQUESTED → worker-apply loop.
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
 * INVOICE_QUEUED / INVOICE_POSTED are worker-only cadence events emitted
 * from the dedicated pusher after the QBO invoice id is resolved (real or
 * stub). A CANCEL/VOID transition may follow once the UI surfaces it; for
 * now CLOSE acts as the catch-all way out.
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
  if (event.type === 'CLOSE') {
    assertRentalTransition(snapshot.state, ['active', 'returned', 'invoiced_pending'], event.type)
    return {
      ...snapshot,
      state: 'closed',
      state_version: nextVersion,
      closed_at: event.closed_at,
      closed_by: event.closed_by,
    }
  }
  // Exhaustiveness guard: every member of RentalWorkflowEvent is handled
  // above, so `event` narrows to `never` here. Adding a new event type to
  // the union without a branch is a compile error — it can no longer
  // silently misroute into the old CLOSE catch-all.
  const exhaustive: never = event
  throw new Error(`unhandled rental event ${JSON.stringify(exhaustive)}`)
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
  // The cadence INVOICE_QUEUED / INVOICE_POSTED transitions are emitted by the
  // worker's dedicated rental-invoice pusher, NOT by a reducer-declared side
  // effect: the worker tick (runners/rental-invoice.ts) enqueues its own
  // `post_rental_invoice` outbox row directly (it is the producer of the
  // billing event, not a consumer of a human-dispatched transition). So this
  // workflow declares no reducer-owned sideEffectTypes — the registry's
  // side-effect machinery is for human-event-driven outbox emission, which
  // rentals don't have. See apps/worker/src/runners/rental-invoice-push.ts.
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

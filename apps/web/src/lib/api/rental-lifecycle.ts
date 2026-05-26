// Rental lifecycle workflow — headless snapshot + state-transition events.
//
// Wraps the deterministic `rental` workflow surface in
// `apps/api/src/routes/rental-events.ts`:
//
//   GET  /api/rentals/:id          → WorkflowSnapshot
//                                    { state, state_version, context, next_events }
//   POST /api/rentals/:id/events   → { event, state_version }
//
// This is distinct from `rentals.ts` (inventory catalog + the legacy
// CRUD `POST /api/rentals/:id/return` reconciliation path). The human
// events are RETURN and CLOSE; INVOICE_QUEUED / INVOICE_POSTED stay
// worker-only and are rejected at the event endpoint.
//
// The canonical state/event unions live in @sitelayer/workflows so the
// reducer and the client agree.

import type { RentalHumanEventType, RentalWorkflowState } from '@sitelayer/workflows'
import { request } from './client'

export type RentalLifecycleState = RentalWorkflowState
export type RentalLifecycleHumanEvent = RentalHumanEventType

/**
 * The rental row carried verbatim in the snapshot `context`. The API
 * preserves `status` alongside the canonical `state` for SPA back-compat
 * (see `snapshotResponse` in rental-events.ts), and threads the lifecycle
 * columns added by the workflow migration.
 */
export interface RentalLifecycleContext {
  id: string
  company_id: string
  project_id: string | null
  customer_id: string | null
  item_description: string
  daily_rate: string
  delivered_on: string
  returned_on: string | null
  next_invoice_at: string | null
  invoice_cadence_days: number
  last_invoice_amount: string | null
  last_invoiced_through: string | null
  status: RentalLifecycleState
  notes: string | null
  version: number
  returned_at: string | null
  returned_by: string | null
  closed_at: string | null
  closed_by: string | null
  created_at?: string
  updated_at?: string
}

export interface RentalLifecycleSnapshot {
  state: RentalLifecycleState
  state_version: number
  context: RentalLifecycleContext
  next_events: Array<{ type: RentalLifecycleHumanEvent; label: string; disabled_reason?: string }>
}

/** Imperative snapshot fetcher for the headless workflow XState actor. */
export function fetchRentalLifecycle(rentalId: string, companySlug?: string): Promise<RentalLifecycleSnapshot> {
  return request<RentalLifecycleSnapshot>(
    `/api/rentals/${encodeURIComponent(rentalId)}`,
    companySlug !== undefined ? { companySlug } : {},
  )
}

/**
 * Imperative event dispatcher for the headless workflow XState actor.
 * Throws on non-2xx; the factory detects 409s heuristically (status
 * text / message) and reloads the snapshot instead of surfacing an
 * opaque error.
 */
export function dispatchRentalLifecycleEvent(
  rentalId: string,
  event: RentalLifecycleHumanEvent,
  stateVersion: number,
  companySlug?: string,
): Promise<RentalLifecycleSnapshot> {
  return request<RentalLifecycleSnapshot>(`/api/rentals/${encodeURIComponent(rentalId)}/events`, {
    method: 'POST',
    json: { event, state_version: stateVersion },
    ...(companySlug !== undefined ? { companySlug } : {}),
  })
}

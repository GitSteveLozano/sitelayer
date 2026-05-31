/**
 * TanStack Query hooks for the operator-side rental requests queue.
 *
 * Counterpart to apps/api/src/routes/rental-requests.ts. The customer
 * portal is the *create* path (see lib/api/portal-rentals.ts); this
 * file is read-only list + approve/decline mutations for admins/office.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  RentalRequestApprovalHumanEventType,
  RentalRequestApprovalWorkflowState,
} from '@sitelayer/workflows'
import { request } from './client'

export type RentalRequestStatus = 'pending' | 'approved' | 'declined' | 'all'

export interface RentalRequestItem {
  inventory_item_id: string | null
  qty: number
  start: string | null
  end: string | null
  delivery: string
  description?: string | null
  daily_rate?: number | null
}

export interface RentalRequest {
  id: string
  company_id: string
  share_link_id: string | null
  customer_id: string | null
  items: RentalRequestItem[]
  requested_start: string | null
  requested_end: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  status: 'pending' | 'approved' | 'declined'
  approved_at: string | null
  approved_by: string | null
  approved_by_user_id: string | null
  rejected_at: string | null
  declined_at: string | null
  decline_reason: string | null
  converted_rental_id: string | null
  created_at: string
  updated_at: string
  customer_name: string | null
  customer_external_id: string | null
}

export interface RentalRequestListResponse {
  rentalRequests: RentalRequest[]
}

export interface ApproveRentalRequestResponse {
  rentalRequest: RentalRequest
  rental_id: string | null
  rentals?: unknown[]
  idempotent?: boolean
}

export interface DeclineRentalRequestResponse {
  rentalRequest: RentalRequest
  idempotent?: boolean
}

export interface ApproveRentalRequestInput {
  // Operator overrides for line items where the original portal payload
  // lacked an inventory_item_id or needed a description/rate fix.
  items?: RentalRequestItem[]
}

export interface DeclineRentalRequestInput {
  decline_reason?: string | null
}

const RENTAL_REQUESTS_BASE = '/api/rental-requests'

export function useRentalRequests(status: RentalRequestStatus = 'pending', limit = 20) {
  const search = new URLSearchParams({ status, limit: String(limit) })
  return useQuery<RentalRequestListResponse>({
    queryKey: ['rental-requests', status, limit],
    queryFn: () => request<RentalRequestListResponse>(`${RENTAL_REQUESTS_BASE}?${search}`),
  })
}

export function useApproveRentalRequest() {
  const qc = useQueryClient()
  return useMutation<ApproveRentalRequestResponse, Error, { id: string; input?: ApproveRentalRequestInput }>({
    mutationFn: ({ id, input }) =>
      request<ApproveRentalRequestResponse>(`${RENTAL_REQUESTS_BASE}/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        json: input ?? {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rental-requests'] })
      qc.invalidateQueries({ queryKey: ['rentals'] })
    },
  })
}

export function useDeclineRentalRequest() {
  const qc = useQueryClient()
  return useMutation<DeclineRentalRequestResponse, Error, { id: string; input?: DeclineRentalRequestInput }>({
    mutationFn: ({ id, input }) =>
      request<DeclineRentalRequestResponse>(`${RENTAL_REQUESTS_BASE}/${encodeURIComponent(id)}/decline`, {
        method: 'POST',
        json: input ?? {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rental-requests'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Headless rental_request_approval workflow surface.
//
// Counterpart to GET /api/rental-requests/:id (snapshot) and
// POST /api/rental-requests/:id/events (versioned dispatch) added to
// apps/api/src/routes/rental-requests.ts. The queue renders
// snapshot.next_events straight from the reducer and threads
// state_version on every dispatch — same shape as
// lib/api/damage-charge-settlement.ts. The legacy approve/decline hooks
// above stay for back-compat but the queue now uses these.
// ---------------------------------------------------------------------------

export type RentalRequestApprovalState = RentalRequestApprovalWorkflowState
export type RentalRequestApprovalEvent = RentalRequestApprovalHumanEventType

export interface RentalRequestSnapshot {
  state: RentalRequestApprovalState
  state_version: number
  next_events: Array<{ type: RentalRequestApprovalEvent; label: string }>
  context: RentalRequest
}

export function fetchRentalRequestSnapshot(id: string): Promise<RentalRequestSnapshot> {
  return request<RentalRequestSnapshot>(`${RENTAL_REQUESTS_BASE}/${encodeURIComponent(id)}`)
}

export function dispatchRentalRequestEvent(
  id: string,
  event: RentalRequestApprovalEvent,
  stateVersion: number,
  declineReason?: string | null,
): Promise<RentalRequestSnapshot> {
  return request<RentalRequestSnapshot>(`${RENTAL_REQUESTS_BASE}/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json:
      declineReason != null && declineReason !== ''
        ? { event, state_version: stateVersion, decline_reason: declineReason }
        : { event, state_version: stateVersion },
  })
}

export function useRentalRequestSnapshot(id: string | null | undefined) {
  return useQuery<RentalRequestSnapshot>({
    queryKey: ['rental-request-snapshot', id ?? ''],
    queryFn: () => fetchRentalRequestSnapshot(id!),
    enabled: Boolean(id),
  })
}

export function useDispatchRentalRequestEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<
    RentalRequestSnapshot,
    Error,
    { event: RentalRequestApprovalEvent; state_version: number; decline_reason?: string | null }
  >({
    mutationFn: ({ event, state_version, decline_reason }) =>
      dispatchRentalRequestEvent(id, event, state_version, decline_reason ?? null),
    onSuccess: (data) => {
      qc.setQueryData(['rental-request-snapshot', id], data)
      qc.invalidateQueries({ queryKey: ['rental-requests'] })
      qc.invalidateQueries({ queryKey: ['rentals'] })
    },
  })
}

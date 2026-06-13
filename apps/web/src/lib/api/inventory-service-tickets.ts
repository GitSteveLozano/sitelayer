// Inventory service tickets (103_inventory_service_tickets.sql) — types +
// hooks. Wraps the routes in apps/api/src/routes/inventory-service-tickets.ts.
// A service ticket is the first-class maintenance log for a rental inventory
// item: open → in_service → done. Surfaced by the owner rentals asset-detail
// ("Flag for service") and utilization ("Service log" + "+ LOG") screens.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type ServiceTicketStatus = 'open' | 'in_service' | 'done'

export interface ServiceTicket {
  id: string
  company_id: string
  inventory_item_id: string
  status: ServiceTicketStatus
  opened_at: string
  opened_by: string | null
  completed_at: string | null
  notes: string | null
  /** Short maintenance type (migration 019), e.g. "Oil change". Null on older rows. */
  service_type?: string | null
  /** Maintenance cost in integer cents (migration 019) — sums into SPENT·YTD. Null = not recorded. */
  cost_cents?: number | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

export interface ServiceTicketListResponse {
  service_tickets: ServiceTicket[]
}

export interface ServiceTicketResponse {
  service_ticket: ServiceTicket
}

export interface OpenServiceTicketInput {
  inventory_item_id: string
  notes?: string | null
  /** Short maintenance type (migration 019). */
  service_type?: string | null
  /** Maintenance cost in integer cents (migration 019). */
  cost_cents?: number | null
}

export interface PatchServiceTicketInput {
  id: string
  status: ServiceTicketStatus
}

export interface ServiceTicketListParams {
  itemId?: string
  status?: ServiceTicketStatus
}

/**
 * List service tickets for the active company, optionally scoped to one
 * inventory item and/or status. Omit both filters for the company-wide
 * service log; pass `itemId` for a per-asset history.
 */
export function useServiceTickets(params: ServiceTicketListParams = {}) {
  const search = new URLSearchParams()
  if (params.itemId) search.set('item_id', params.itemId)
  if (params.status) search.set('status', params.status)
  const qs = search.toString() ? `?${search}` : ''
  return useQuery<ServiceTicketListResponse>({
    queryKey: ['inventory', 'service-tickets', params],
    queryFn: () => request<ServiceTicketListResponse>(`/api/inventory/service-tickets${qs}`),
  })
}

/** Open a service ticket against an inventory item (status starts `open`). */
export function useOpenServiceTicket() {
  const qc = useQueryClient()
  return useMutation<ServiceTicketResponse, Error, OpenServiceTicketInput>({
    mutationFn: (input) =>
      request<ServiceTicketResponse>('/api/inventory/service-tickets', { method: 'POST', json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

/**
 * Advance a service ticket's status (open → in_service → done). The ticket
 * `id` is passed in the mutation variables (not at hook construction) so a
 * single hook instance can drive any row in a list.
 */
export function usePatchServiceTicket() {
  const qc = useQueryClient()
  return useMutation<ServiceTicketResponse, Error, PatchServiceTicketInput>({
    mutationFn: ({ id, status }) =>
      request<ServiceTicketResponse>(`/api/inventory/service-tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: { status },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

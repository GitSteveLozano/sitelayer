// Rental billing runs — workflow detail view + state-transition events.
// Wraps /api/rental-billing-runs and /api/rental-billing-runs/:id/events
// in apps/api/src/routes/rental-billing-state.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type RentalBillingState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
export type RentalBillingHumanEvent = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export interface RentalBillingRunRow {
  id: string
  contract_id: string
  project_id: string
  customer_id: string | null
  period_start: string
  period_end: string
  status: RentalBillingState
  state_version: number
  subtotal: string
  qbo_invoice_id: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface RentalBillingRunLine {
  id: string
  billing_run_id: string
  contract_line_id: string
  inventory_item_id: string
  quantity: string
  agreed_rate: string
  rate_unit: string
  billable_days: number
  period_start: string
  period_end: string
  amount: string
  taxable: boolean
  description: string | null
  created_at: string
}

export interface RentalBillingSnapshot {
  state: RentalBillingState
  state_version: number
  next_events: Array<{ type: RentalBillingHumanEvent; label: string }>
  context: {
    id: string
    contract_id: string
    project_id: string
    customer_id: string | null
    period_start: string
    period_end: string
    subtotal: string
    qbo_invoice_id: string | null
    approved_at: string | null
    posted_at: string | null
    failed_at: string | null
    error: string | null
    workflow_engine: string
    workflow_run_id: string | null
    lines: RentalBillingRunLine[]
  }
}

export interface BillingRunListParams {
  state?: RentalBillingState
}

export interface BillingRunListResponse {
  billingRuns: RentalBillingRunRow[]
}

const KEYS = {
  all: () => ['billing-runs'] as const,
  list: (params: BillingRunListParams) => [...KEYS.all(), 'list', params] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const billingRunQueryKeys = KEYS

export function fetchBillingRuns(params: BillingRunListParams = {}): Promise<BillingRunListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  const qs = search.toString()
  return request<BillingRunListResponse>(`/api/rental-billing-runs${qs ? `?${qs}` : ''}`)
}

export function fetchBillingRun(id: string): Promise<RentalBillingSnapshot> {
  return request<RentalBillingSnapshot>(`/api/rental-billing-runs/${encodeURIComponent(id)}`)
}

export function useBillingRuns(params: BillingRunListParams = {}) {
  return useQuery<BillingRunListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchBillingRuns(params),
  })
}

export function useBillingRun(id: string | null | undefined) {
  return useQuery<RentalBillingSnapshot>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchBillingRun(id!),
    enabled: Boolean(id),
  })
}

export function useDispatchBillingRunEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<RentalBillingSnapshot, Error, { event: RentalBillingHumanEvent; state_version: number }>({
    mutationFn: (input) =>
      request<RentalBillingSnapshot>(`/api/rental-billing-runs/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

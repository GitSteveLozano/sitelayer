// Estimate pushes — financial workflow that drives QBO estimate sync.
// Wraps /api/estimate-pushes and /api/estimate-pushes/:id/events in
// apps/api/src/routes/estimate-pushes.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type EstimatePushState = 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
export type EstimatePushHumanEvent = 'REVIEW' | 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export interface EstimatePushRow {
  id: string
  project_id: string
  customer_id: string | null
  subtotal: string
  status: EstimatePushState
  state_version: number
  qbo_estimate_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  created_at: string
  updated_at: string
}

export interface EstimatePushLine {
  id: string
  estimate_push_id: string
  description: string
  quantity: string
  unit: string
  rate: string
  amount: string
  service_item_code: string | null
  sort_order: number
}

export interface EstimatePushSnapshot {
  state: EstimatePushState
  state_version: number
  next_events: Array<{ type: EstimatePushHumanEvent; label: string }>
  context: {
    id: string
    project_id: string
    customer_id: string | null
    subtotal: string
    qbo_estimate_id: string | null
    reviewed_at: string | null
    reviewed_by: string | null
    approved_at: string | null
    approved_by: string | null
    posted_at: string | null
    failed_at: string | null
    error: string | null
    workflow_engine: string
    workflow_run_id: string | null
    lines: EstimatePushLine[]
  }
}

export interface EstimatePushListParams {
  state?: EstimatePushState
}

export interface EstimatePushListResponse {
  estimatePushes: EstimatePushRow[]
}

const KEYS = {
  all: () => ['estimate-pushes'] as const,
  list: (params: EstimatePushListParams) => [...KEYS.all(), 'list', params] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const estimatePushQueryKeys = KEYS

export function fetchEstimatePushes(params: EstimatePushListParams = {}): Promise<EstimatePushListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  const qs = search.toString()
  return request<EstimatePushListResponse>(`/api/estimate-pushes${qs ? `?${qs}` : ''}`)
}

export function fetchEstimatePush(id: string): Promise<EstimatePushSnapshot> {
  return request<EstimatePushSnapshot>(`/api/estimate-pushes/${encodeURIComponent(id)}`)
}

export function useEstimatePushes(params: EstimatePushListParams = {}) {
  return useQuery<EstimatePushListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchEstimatePushes(params),
  })
}

export function useEstimatePush(id: string | null | undefined) {
  return useQuery<EstimatePushSnapshot>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchEstimatePush(id!),
    enabled: Boolean(id),
  })
}

export function useDispatchEstimatePushEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<EstimatePushSnapshot, Error, { event: EstimatePushHumanEvent; state_version: number }>({
    mutationFn: (input) =>
      request<EstimatePushSnapshot>(`/api/estimate-pushes/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

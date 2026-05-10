// Labor payroll runs — workflow detail view + state-transition events.
// Wraps /api/labor-payroll-runs and /api/labor-payroll-runs/:id/events
// in apps/api/src/routes/labor-payroll-runs.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type LaborPayrollState = 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
export type LaborPayrollHumanEvent = 'APPROVE' | 'POST_REQUESTED' | 'RETRY_POST' | 'VOID'

export interface LaborPayrollRunRow {
  id: string
  company_id: string
  period_start: string
  period_end: string
  state: LaborPayrollState
  state_version: number
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  qbo_payroll_batch_ref: string[] | null
  covered_labor_entry_ids: string[]
  total_hours: string
  total_cents: string
  time_review_run_id: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  origin: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface LaborPayrollSnapshot {
  state: LaborPayrollState
  state_version: number
  next_events: Array<{ type: LaborPayrollHumanEvent; label: string }>
  context: {
    id: string
    company_id: string
    period_start: string
    period_end: string
    approved_at: string | null
    approved_by_user_id: string | null
    posted_at: string | null
    failed_at: string | null
    error_message: string | null
    qbo_payroll_batch_ref: string[] | null
    covered_labor_entry_ids: string[]
    total_hours: string
    total_cents: string
    time_review_run_id: string | null
    workflow_engine: string
    workflow_run_id: string | null
    created_at: string
    updated_at: string
  }
}

export interface LaborPayrollRunListParams {
  state?: LaborPayrollState
  period_start?: string
}

export interface LaborPayrollRunListResponse {
  laborPayrollRuns: LaborPayrollRunRow[]
}

export interface LaborPayrollPreviewResponse {
  period_start: string
  period_end: string
  covered_labor_entry_ids: string[]
  total_entries: number
  total_hours: string
  total_cents: string
  labor_entries: Array<{
    id: string
    worker_id: string | null
    hours: string
    occurred_on: string
  }>
}

const KEYS = {
  all: () => ['labor-payroll-runs'] as const,
  list: (params: LaborPayrollRunListParams) => [...KEYS.all(), 'list', params] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const laborPayrollRunQueryKeys = KEYS

export function fetchLaborPayrollRuns(params: LaborPayrollRunListParams = {}): Promise<LaborPayrollRunListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  if (params.period_start) search.set('period_start', params.period_start)
  const qs = search.toString()
  return request<LaborPayrollRunListResponse>(`/api/labor-payroll-runs${qs ? `?${qs}` : ''}`)
}

export function fetchLaborPayrollRun(id: string): Promise<LaborPayrollSnapshot> {
  return request<LaborPayrollSnapshot>(`/api/labor-payroll-runs/${encodeURIComponent(id)}`)
}

export function previewLaborPayrollCoverage(
  periodStart: string,
  periodEnd: string,
): Promise<LaborPayrollPreviewResponse> {
  const search = new URLSearchParams({ period_start: periodStart, period_end: periodEnd })
  return request<LaborPayrollPreviewResponse>(`/api/labor-payroll-runs/preview?${search.toString()}`, {
    method: 'POST',
  })
}

export function createLaborPayrollRun(input: {
  period_start: string
  period_end: string
  time_review_run_id?: string | null
}): Promise<LaborPayrollSnapshot> {
  return request<LaborPayrollSnapshot>(`/api/labor-payroll-runs`, {
    method: 'POST',
    json: input,
  })
}

export function useLaborPayrollRuns(params: LaborPayrollRunListParams = {}) {
  return useQuery<LaborPayrollRunListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchLaborPayrollRuns(params),
  })
}

export function useLaborPayrollRun(id: string | null | undefined) {
  return useQuery<LaborPayrollSnapshot>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchLaborPayrollRun(id!),
    enabled: Boolean(id),
  })
}

export function useDispatchLaborPayrollRunEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<LaborPayrollSnapshot, Error, { event: LaborPayrollHumanEvent; state_version: number }>({
    mutationFn: (input) =>
      request<LaborPayrollSnapshot>(`/api/labor-payroll-runs/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(KEYS.detail(id), data)
      qc.invalidateQueries({ queryKey: KEYS.all() })
    },
  })
}

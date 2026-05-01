// Labor burden — types + hook for the fm-today-v2 dark card.
// Wraps GET /api/labor-burden/today.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface LaborBurdenWorkerResult {
  worker_id: string
  straight_hours: number
  ot_hours: number
  loaded_hourly_cents: number
  ot_loaded_hourly_cents: number
  straight_cents: number
  ot_cents: number
  total_cents: number
}

export interface LaborBurdenSummaryResponse {
  total_cents: number
  total_straight_hours: number
  total_ot_hours: number
  total_hours: number
  blended_loaded_hourly_cents: number
  per_worker: LaborBurdenWorkerResult[]
  total_budget_cents: number
  burden_pct_of_budget: number
}

export interface LaborBurdenParams {
  /** YYYY-MM-DD; defaults to today on the server. */
  date?: string
  projectId?: string
}

const KEYS = {
  all: () => ['labor-burden'] as const,
  today: (params: LaborBurdenParams = {}) => [...KEYS.all(), 'today', params] as const,
}

export const laborBurdenQueryKeys = KEYS

export function fetchLaborBurdenToday(params: LaborBurdenParams = {}): Promise<LaborBurdenSummaryResponse> {
  const search = new URLSearchParams()
  if (params.date) search.set('date', params.date)
  if (params.projectId) search.set('project_id', params.projectId)
  const qs = search.toString()
  return request<LaborBurdenSummaryResponse>(`/api/labor-burden/today${qs ? `?${qs}` : ''}`)
}

export function useLaborBurdenToday(
  params: LaborBurdenParams = {},
  options?: Partial<UseQueryOptions<LaborBurdenSummaryResponse>>,
) {
  return useQuery<LaborBurdenSummaryResponse>({
    queryKey: KEYS.today(params),
    queryFn: () => fetchLaborBurdenToday(params),
    refetchInterval: 60_000,
    ...options,
  })
}

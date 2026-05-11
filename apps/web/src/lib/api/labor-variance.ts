// Labor variance — types + hook for the Budget-tab variance panel on
// the mobile project detail screen. Wraps GET /api/projects/:id/labor-variance.
//
// Shape contract matches apps/api/src/routes/projects.ts. Numbers come
// through as JS numbers (the server normalizes the SUM-derived numerics
// before responding) so the consumer doesn't need to parse strings.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface LaborVarianceRow {
  service_item_code: string
  division_code: string | null
  unit: string
  estimated_quantity: number
  actual_quantity: number
  estimated_hours: number
  actual_hours: number
  quantity_variance_pct: number
  hours_variance_pct: number
}

export interface LaborVarianceResponse {
  variance: LaborVarianceRow[]
}

const KEYS = {
  all: () => ['labor-variance'] as const,
  byProject: (projectId: string) => [...KEYS.all(), projectId] as const,
}

export const laborVarianceQueryKeys = KEYS

export function fetchProjectLaborVariance(projectId: string): Promise<LaborVarianceResponse> {
  return request<LaborVarianceResponse>(`/api/projects/${encodeURIComponent(projectId)}/labor-variance`)
}

export function useProjectLaborVariance(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<LaborVarianceResponse>>,
) {
  return useQuery<LaborVarianceResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectLaborVariance(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

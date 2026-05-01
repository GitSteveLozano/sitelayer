// Divisions — read-only reference data seeded at company creation.
// Wraps GET /api/divisions in apps/api/src/routes/system.ts.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface Division {
  code: string
  name: string
  sort_order: number
}

export interface DivisionListResponse {
  divisions: Division[]
}

const KEYS = {
  all: () => ['divisions'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const divisionQueryKeys = KEYS

export function fetchDivisions(): Promise<DivisionListResponse> {
  return request<DivisionListResponse>('/api/divisions')
}

export function useDivisions(options?: Partial<UseQueryOptions<DivisionListResponse>>) {
  return useQuery<DivisionListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchDivisions,
    staleTime: 30 * 60_000,
    ...options,
  })
}

// Crew schedules — types + hooks for the company-wide schedule list.
// Wraps GET /api/schedules in apps/api/src/routes/schedules.ts.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface CrewScheduleRow {
  id: string
  project_id: string
  scheduled_for: string
  crew: unknown
  status: 'draft' | 'confirmed'
  version: number
  deleted_at: string | null
  created_at: string
  /** Joined from projects.name in the company-wide list. */
  project_name?: string | null
}

export interface ScheduleListParams {
  /** YYYY-MM-DD inclusive. */
  from?: string
  /** YYYY-MM-DD inclusive. */
  to?: string
}

export interface ScheduleListResponse {
  schedules: CrewScheduleRow[]
}

const KEYS = {
  all: () => ['schedules'] as const,
  list: (params?: ScheduleListParams) => [...KEYS.all(), 'list', params ?? {}] as const,
}

export const scheduleQueryKeys = KEYS

export function fetchSchedules(params: ScheduleListParams = {}): Promise<ScheduleListResponse> {
  const search = new URLSearchParams()
  if (params.from) search.set('from', params.from)
  if (params.to) search.set('to', params.to)
  const qs = search.toString()
  return request<ScheduleListResponse>(`/api/schedules${qs ? `?${qs}` : ''}`)
}

export function useSchedules(
  params: ScheduleListParams = {},
  options?: Partial<UseQueryOptions<ScheduleListResponse>>,
) {
  return useQuery<ScheduleListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchSchedules(params),
    staleTime: 60_000,
    ...options,
  })
}

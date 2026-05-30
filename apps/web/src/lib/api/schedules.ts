// Crew schedules — types + hooks for the company-wide schedule list.
// Wraps GET /api/schedules in apps/api/src/routes/schedules.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
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
  /** HH:MM[:SS] wall-clock; null when the assignment hasn't been timed yet. */
  start_time?: string | null
  /** HH:MM[:SS] wall-clock; nullability matches start_time (both-or-neither). */
  end_time?: string | null
  /** Optional FK into takeoff_measurements; the next four fields are denormalized for display. */
  takeoff_measurement_id?: string | null
  takeoff_service_item_code?: string | null
  takeoff_elevation?: string | null
  /** Numeric strings — pg numeric round-trips through JSON as text. */
  takeoff_quantity?: string | null
  takeoff_unit?: string | null
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

/**
 * Request body for POST /api/schedules. Mirrors the wire-format the API
 * validates (apps/api/src/routes/schedules.ts): `project_id` is a UUID,
 * `scheduled_for` is YYYY-MM-DD, and `crew` is an optional jsonb array
 * (defaults to `[]` server-side when omitted).
 */
export interface CreateScheduleRequest {
  project_id: string
  scheduled_for: string
  crew?: unknown[]
}

export function createSchedule(input: CreateScheduleRequest): Promise<CrewScheduleRow> {
  return request<CrewScheduleRow>('/api/schedules', { method: 'POST', json: input })
}

/**
 * Creates a single crew assignment (draft schedule row). On success we
 * invalidate every schedule list query AND any bootstrap query — the owner
 * schedule grid derives its week from the bootstrap `schedules` ledger, so
 * both caches need refreshing for the new assignment to appear.
 */
export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation<CrewScheduleRow, Error, CreateScheduleRequest>({
    mutationFn: createSchedule,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all() })
      void qc.invalidateQueries({ queryKey: ['bootstrap'] })
    },
  })
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

/** Request body for POST /api/schedules/copy-week. Both are YYYY-MM-DD Mondays. */
export interface CopyScheduleWeekRequest {
  /** Source week's Monday — every assignment in [from_monday, +6d] is cloned. */
  from_monday: string
  /** Target week's Monday — clones land at the matching offset day. */
  to_monday: string
}

export interface CopyScheduleWeekResponse {
  /** Rows actually cloned into the target week. */
  copied: number
  /** Source rows skipped because the target day already had that project. */
  skipped: number
  /** Total source rows considered in the from-week range. */
  total: number
  /** The freshly-created draft rows. */
  schedules: CrewScheduleRow[]
}

export function copyScheduleWeek(input: CopyScheduleWeekRequest): Promise<CopyScheduleWeekResponse> {
  return request<CopyScheduleWeekResponse>('/api/schedules/copy-week', {
    method: 'POST',
    json: input,
  })
}

/**
 * Clones an entire week of crew assignments to another week (server
 * returns the new rows as `draft` so the foreman re-confirms). On
 * success we invalidate every schedule list query so the copied
 * assignments appear in whichever range is currently mounted.
 */
export function useCopyScheduleWeek() {
  const qc = useQueryClient()
  return useMutation<CopyScheduleWeekResponse, Error, CopyScheduleWeekRequest>({
    mutationFn: copyScheduleWeek,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all() })
    },
  })
}

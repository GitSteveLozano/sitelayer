// Crew schedule workflow — types, request functions, and TanStack hooks.
// Wraps apps/api/src/routes/crew-schedule-events.ts. Mirrors the workflow
// snapshot envelope from packages/workflows (see docs/DETERMINISTIC_WORKFLOWS.md).
//
// The list/create surface lives in ./schedules.ts. This module is
// dedicated to the per-row workflow snapshot + event dispatch surface.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { ApiError, request } from './client'

export type CrewScheduleState = 'draft' | 'confirmed' | 'declined'
// Widened to match the reducer's human-event set (Gap 5). The XState
// machine is event-name agnostic, so DISPATCH accepts any of these.
export type CrewScheduleHumanEvent = 'CONFIRM' | 'DECLINE' | 'REASSIGN'

/** One per-worker labor entry to materialize on CONFIRM (side-effect data). */
export interface CrewScheduleLaborEntryInput {
  worker_id?: string | null
  service_item_code: string
  hours: number
  sqft_done?: number | null
  occurred_on: string
}

/** Wire-format snapshot returned by GET /api/schedules/:id and POST .../events. */
export interface CrewScheduleSnapshot {
  state: CrewScheduleState
  state_version: number
  context: {
    id: string
    project_id: string
    scheduled_for: string
    crew: unknown
    status: CrewScheduleState
    confirmed_at: string | null
    confirmed_by: string | null
    created_by?: string | null
    declined_at?: string | null
    declined_by?: string | null
    decline_reason?: string | null
    version: number
    created_at: string
    start_time: string | null
    end_time: string | null
    takeoff_measurement_id: string | null
  }
  next_events: Array<{ type: string; label: string }>
}

export interface CrewScheduleEventRequest {
  event: CrewScheduleHumanEvent
  state_version: number
  /** Optional ISO timestamp; server defaults to now() when omitted. */
  confirmed_at?: string
  /** Optional actor user id; server defaults to current user when omitted. */
  confirmed_by?: string
  /** CONFIRM only — per-worker labor entries materialized via the outbox. */
  entries?: CrewScheduleLaborEntryInput[]
  /** DECLINE only — the worker's decline reason. */
  reason?: string
}

export interface CrewSchedulePatchRequest {
  /** YYYY-MM-DD; sent on drag-to-reschedule. */
  scheduled_for?: string
  /** Optional optimistic-concurrency check. */
  expected_version?: number
}

const KEYS = {
  all: () => ['crew-schedules'] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const crewScheduleQueryKeys = KEYS

export function fetchCrewScheduleSnapshot(id: string): Promise<CrewScheduleSnapshot> {
  return request<CrewScheduleSnapshot>(`/api/schedules/${encodeURIComponent(id)}`)
}

export function dispatchCrewScheduleEvent(id: string, input: CrewScheduleEventRequest): Promise<CrewScheduleSnapshot> {
  return request<CrewScheduleSnapshot>(`/api/schedules/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: input,
  })
}

export function patchCrewSchedule(id: string, input: CrewSchedulePatchRequest): Promise<unknown> {
  return request<unknown>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: input,
  })
}

export function useCrewScheduleSnapshot(
  id: string | null | undefined,
  options?: Partial<UseQueryOptions<CrewScheduleSnapshot>>,
) {
  return useQuery<CrewScheduleSnapshot>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchCrewScheduleSnapshot(id!),
    enabled: Boolean(id),
    ...options,
  })
}

/**
 * Mutation hook for the workflow event endpoint. Mirrors
 * useDispatchTimeReviewEvent — on 409 the server returns
 * `{ error, snapshot }` so the cache can be primed with the
 * authoritative server-truth state without an extra round-trip.
 */
export function useDispatchCrewScheduleEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<CrewScheduleSnapshot, ApiError, CrewScheduleEventRequest>({
    mutationFn: (input) => dispatchCrewScheduleEvent(id, input),
    onSuccess: (snapshot) => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
      qc.setQueryData(KEYS.detail(id), snapshot)
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === 'object' &&
        'snapshot' in err.body
      ) {
        const snapshot = (err.body as { snapshot?: CrewScheduleSnapshot }).snapshot
        if (snapshot) qc.setQueryData(KEYS.detail(id), snapshot)
      }
    },
  })
}

/**
 * Reschedule (drag-to-move) mutation hook. Reschedule is a FIELD EDIT,
 * not a workflow state transition (it does not change draft/confirmed),
 * so it correctly lives on PATCH /api/schedules/:id rather than /events
 * (Gap 4). Invalidates the schedule list + bootstrap caches; on a 409
 * (stale version) the server returns the authoritative snapshot which we
 * prime into the detail cache so the UI can reconcile.
 */
export function useRescheduleCrewSchedule(id: string) {
  const qc = useQueryClient()
  return useMutation<unknown, ApiError, CrewSchedulePatchRequest>({
    mutationFn: (input) => patchCrewSchedule(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
      void qc.invalidateQueries({ queryKey: ['bootstrap'] })
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === 'object' &&
        'snapshot' in err.body
      ) {
        const snapshot = (err.body as { snapshot?: CrewScheduleSnapshot }).snapshot
        if (snapshot) qc.setQueryData(KEYS.detail(id), snapshot)
      }
    },
  })
}

// Clock — types, request functions, and TanStack hooks.
// Wraps the routes in apps/api/src/routes/clock.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'

export type ClockEventType = 'in' | 'out' | 'auto_out_geo' | 'auto_out_idle'
export type ClockEventSource = 'manual' | 'auto_geofence' | 'foreman_override'

export interface ClockEvent {
  id: string
  company_id: string
  worker_id: string | null
  project_id: string | null
  clerk_user_id: string | null
  event_type: ClockEventType
  occurred_at: string
  lat: string | null
  lng: string | null
  accuracy_m: string | null
  inside_geofence: boolean | null
  notes: string | null
  source: ClockEventSource
  /** ISO timestamp; null when source='manual' or no project resolved. */
  correctible_until: string | null
  /** Set by POST /api/clock/events/:id/void; null otherwise. */
  voided_at?: string | null
  voided_by?: string | null
  /** Joined from projects.name in the timeline endpoint. */
  project_name?: string | null
  created_at: string
}

export interface ClockEventVoidRequest {
  /** Optional explanation, appended to notes for the audit trail. */
  reason?: string | null
}

export interface ClockEventVoidResponse {
  clockEvent: ClockEvent
}

export interface ClockInRequest {
  lat: number
  lng: number
  accuracy_m?: number | null
  notes?: string | null
  source?: ClockEventSource
  /** When set, server resolves the project explicitly instead of auto-matching the geofence. */
  project_id?: string | null
  /**
   * Required when source='foreman_override'. The worker the event is
   * FOR; the row's clerk_user_id stays the actor's id so the audit
   * trail attributes the trigger to the foreman.
   */
  worker_id?: string | null
}

export interface ClockOutRequest extends Omit<ClockInRequest, 'project_id'> {
  /** project_id is intentionally absent — out pairs with the open in. */
}

export interface ClockInResponse {
  clockEvent: ClockEvent
}

export interface ClockOutResponse {
  clockEvent: ClockEvent
  laborEntry?: Record<string, unknown> | null
}

export interface ClockTimelineParams {
  workerId?: string
  /** YYYY-MM-DD */
  date?: string
}

export interface ClockTimelineResponse {
  events: ClockEvent[]
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export function clockIn(input: ClockInRequest): Promise<ClockInResponse> {
  return request<ClockInResponse>('/api/clock/in', { method: 'POST', json: input })
}

export function clockOut(input: ClockOutRequest): Promise<ClockOutResponse> {
  return request<ClockOutResponse>('/api/clock/out', { method: 'POST', json: input })
}

export function fetchClockTimeline(params: ClockTimelineParams = {}): Promise<ClockTimelineResponse> {
  const search = new URLSearchParams()
  if (params.workerId) search.set('worker_id', params.workerId)
  if (params.date) search.set('date', params.date)
  const qs = search.toString()
  return request<ClockTimelineResponse>(`/api/clock/timeline${qs ? `?${qs}` : ''}`)
}

export function voidClockEvent(id: string, input: ClockEventVoidRequest = {}): Promise<ClockEventVoidResponse> {
  return request<ClockEventVoidResponse>(`/api/clock/events/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    json: input,
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useClockTimeline(
  params: ClockTimelineParams = {},
  options?: Partial<UseQueryOptions<ClockTimelineResponse>>,
) {
  return useQuery<ClockTimelineResponse>({
    queryKey: queryKeys.clock.timeline(params),
    queryFn: () => fetchClockTimeline(params),
    ...options,
  })
}

import { NetworkError } from './client'

export type ClockMutationResult<T> = T | { queued: true }

async function liveOrQueueClockIn(input: ClockInRequest): Promise<ClockMutationResult<ClockInResponse>> {
  try {
    return await clockIn(input)
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('clock_in', input as unknown as Record<string, unknown>)
      return { queued: true }
    }
    throw err
  }
}

async function liveOrQueueClockOut(input: ClockOutRequest): Promise<ClockMutationResult<ClockOutResponse>> {
  try {
    return await clockOut(input)
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('clock_out', input as unknown as Record<string, unknown>)
      return { queued: true }
    }
    throw err
  }
}

/**
 * Mutation hook for clock-in. The geofence hook composes this with
 * `source='auto_geofence'` to fire passive events; the manual UI path
 * leaves source default ('manual').
 *
 * Offline behaviour: a NetworkError (no response — caller is offline
 * or the API is unreachable) enqueues the call into IndexedDB; the
 * mutation resolves with `{ queued: true }` so the UI stays
 * responsive. The replay engine drains the queue on `online` event +
 * 15s heartbeat. 4xx responses (e.g. 'no_geofence_match') still
 * surface to the caller — only network failure triggers the queue.
 */
export function useClockIn() {
  const qc = useQueryClient()
  return useMutation<ClockMutationResult<ClockInResponse>, Error, ClockInRequest>({
    mutationFn: liveOrQueueClockIn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.clock.all() })
    },
  })
}

export function useClockOut() {
  const qc = useQueryClient()
  return useMutation<ClockMutationResult<ClockOutResponse>, Error, ClockOutRequest>({
    mutationFn: liveOrQueueClockOut,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.clock.all() })
    },
  })
}

/**
 * Mutation hook for `POST /api/clock/events/:id/void`. Used by
 * wk-clockin's "wait, that wasn't me" affordance and the foreman
 * override path. The API enforces the correctible_until window for
 * worker self-corrections; admin/foreman/office can void any time.
 */
export function useVoidClockEvent() {
  const qc = useQueryClient()
  return useMutation<ClockEventVoidResponse, Error, { id: string; input?: ClockEventVoidRequest }>({
    mutationFn: ({ id, input }) => voidClockEvent(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.clock.all() })
    },
  })
}

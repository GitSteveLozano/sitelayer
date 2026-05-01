// Time review runs — types, request functions, and TanStack hooks.
// Wraps apps/api/src/routes/time-review-runs.ts. Mirrors the workflow
// snapshot envelope from packages/workflows.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request, ApiError } from './client'
import { queryKeys } from './keys'

export type TimeReviewState = 'pending' | 'approved' | 'rejected'
export type TimeReviewHumanEvent = 'APPROVE' | 'REJECT' | 'REOPEN'

export interface TimeReviewRunRow {
  id: string
  company_id: string
  project_id: string | null
  period_start: string
  period_end: string
  state: TimeReviewState
  state_version: number
  covered_entry_ids: string[]
  total_hours: string
  total_entries: number
  anomaly_count: number
  reviewer_user_id: string | null
  approved_at: string | null
  rejected_at: string | null
  rejection_reason: string | null
  reopened_at: string | null
  workflow_engine: string
  workflow_run_id: string | null
  origin: string | null
  created_at: string
  updated_at: string
}

export interface TimeReviewSnapshot {
  state: TimeReviewState
  state_version: number
  context: Omit<TimeReviewRunRow, 'state' | 'state_version'>
  next_events: Array<{ type: string; label: string }>
}

export interface TimeReviewListParams {
  state?: TimeReviewState
  projectId?: string
  /** YYYY-MM-DD */
  from?: string
  /** YYYY-MM-DD */
  to?: string
}

export interface TimeReviewListResponse {
  timeReviewRuns: TimeReviewRunRow[]
}

export interface TimeReviewCreateRequest {
  /** YYYY-MM-DD */
  period_start: string
  /** YYYY-MM-DD */
  period_end: string
  project_id?: string | null
}

export interface TimeReviewEventRequest {
  event: TimeReviewHumanEvent
  state_version: number
  /** Required for REJECT and REOPEN; ignored for APPROVE. */
  reason?: string
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export function fetchTimeReviewRuns(params: TimeReviewListParams = {}): Promise<TimeReviewListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  if (params.projectId) search.set('project_id', params.projectId)
  if (params.from) search.set('from', params.from)
  if (params.to) search.set('to', params.to)
  const qs = search.toString()
  return request<TimeReviewListResponse>(`/api/time-review-runs${qs ? `?${qs}` : ''}`)
}

export function fetchTimeReviewRun(id: string): Promise<TimeReviewSnapshot> {
  return request<TimeReviewSnapshot>(`/api/time-review-runs/${encodeURIComponent(id)}`)
}

export function createTimeReviewRun(input: TimeReviewCreateRequest): Promise<TimeReviewSnapshot> {
  return request<TimeReviewSnapshot>('/api/time-review-runs', { method: 'POST', json: input })
}

export function dispatchTimeReviewEvent(id: string, input: TimeReviewEventRequest): Promise<TimeReviewSnapshot> {
  return request<TimeReviewSnapshot>(`/api/time-review-runs/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: input,
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useTimeReviewRuns(
  params: TimeReviewListParams = {},
  options?: Partial<UseQueryOptions<TimeReviewListResponse>>,
) {
  return useQuery<TimeReviewListResponse>({
    queryKey: queryKeys.timeReviewRuns.list(params),
    queryFn: () => fetchTimeReviewRuns(params),
    ...options,
  })
}

export function useTimeReviewRun(
  id: string | null | undefined,
  options?: Partial<UseQueryOptions<TimeReviewSnapshot>>,
) {
  return useQuery<TimeReviewSnapshot>({
    queryKey: queryKeys.timeReviewRuns.detail(id ?? ''),
    queryFn: () => fetchTimeReviewRun(id!),
    enabled: Boolean(id),
    ...options,
  })
}

export function useCreateTimeReviewRun() {
  const qc = useQueryClient()
  return useMutation<TimeReviewSnapshot, Error, TimeReviewCreateRequest>({
    mutationFn: (input) => createTimeReviewRun(input),
    onSuccess: (snapshot) => {
      void qc.invalidateQueries({ queryKey: queryKeys.timeReviewRuns.all() })
      qc.setQueryData(queryKeys.timeReviewRuns.detail(snapshot.context.id), snapshot)
    },
  })
}

/**
 * Mutation hook for workflow events. The 409 path returns a fresh
 * snapshot in the error body so the UI can re-decide what's allowed
 * without an extra round-trip; we surface that on the ApiError so the
 * caller can pull `err.body.snapshot` for an immediate refresh.
 */
export function useDispatchTimeReviewEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<TimeReviewSnapshot, ApiError, TimeReviewEventRequest>({
    mutationFn: (input) => dispatchTimeReviewEvent(id, input),
    onSuccess: (snapshot) => {
      void qc.invalidateQueries({ queryKey: queryKeys.timeReviewRuns.all() })
      qc.setQueryData(queryKeys.timeReviewRuns.detail(id), snapshot)
    },
    onError: (err) => {
      // 409 carries `{ error, snapshot }` — preload the snapshot into the
      // cache so the UI shows the current server-truth state immediately.
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === 'object' &&
        'snapshot' in err.body
      ) {
        const snapshot = (err.body as { snapshot?: TimeReviewSnapshot }).snapshot
        if (snapshot) qc.setQueryData(queryKeys.timeReviewRuns.detail(id), snapshot)
      }
    },
  })
}

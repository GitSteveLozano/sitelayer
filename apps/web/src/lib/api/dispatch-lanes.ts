// Dispatch lanes admin API — typed client for /api/admin/dispatch-lanes.
//
// Wraps the handler in apps/api/src/routes/dispatch-lanes.ts. Admin-only;
// the server gates this with requireRole(['admin']).

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export type DispatchLaneState = 'active' | 'paused' | 'degraded'

export interface DispatchLane {
  name: string
  state: DispatchLaneState
  pause_reason: string
  paused_at: string | null
  resume_after: string | null
  last_decided_by: string
  last_decided_at: string
  metadata: Record<string, unknown>
}

export interface DispatchLaneListResponse {
  lanes: DispatchLane[]
}

export interface PauseLaneRequest {
  reason: string
  resume_after?: string | null
  metadata?: Record<string, unknown>
}

export interface ResumeLaneRequest {
  reason: string
  metadata?: Record<string, unknown>
}

const KEYS = {
  all: () => ['dispatch-lanes'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const dispatchLaneQueryKeys = KEYS

export function fetchDispatchLanes(): Promise<DispatchLaneListResponse> {
  return request<DispatchLaneListResponse>('/api/admin/dispatch-lanes')
}

export function pauseDispatchLane(name: string, body: PauseLaneRequest): Promise<{ lane: DispatchLane }> {
  return request<{ lane: DispatchLane }>(`/api/admin/dispatch-lanes/${encodeURIComponent(name)}/pause`, {
    method: 'POST',
    json: body,
  })
}

export function resumeDispatchLane(name: string, body: ResumeLaneRequest): Promise<{ lane: DispatchLane }> {
  return request<{ lane: DispatchLane }>(`/api/admin/dispatch-lanes/${encodeURIComponent(name)}/resume`, {
    method: 'POST',
    json: body,
  })
}

export function useDispatchLanes(options?: Partial<UseQueryOptions<DispatchLaneListResponse>>) {
  return useQuery<DispatchLaneListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchDispatchLanes,
    ...options,
  })
}

export function usePauseDispatchLane() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; body: PauseLaneRequest }) => pauseDispatchLane(vars.name, vars.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useResumeDispatchLane() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; body: ResumeLaneRequest }) => resumeDispatchLane(vars.name, vars.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

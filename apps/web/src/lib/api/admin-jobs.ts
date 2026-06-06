// Background-jobs ops view — worker periodic-job fleet health + queue health.
// Wraps GET /api/admin/jobs (read-only). A live ops surface, so the hook
// polls on a short interval rather than relying on the default staleTime.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

/** Last-known lifecycle of a periodic job run. */
export type AdminJobStatus = 'unknown' | 'running' | 'ok' | 'error' | 'skipped'

export interface AdminJobRun {
  job_name: string
  scope: string
  last_started_at: string | null
  last_finished_at: string | null
  last_status: AdminJobStatus
  last_error: string | null
  last_duration_ms: number | null
  run_count: number
  success_count: number
  failure_count: number
  skipped_count: number
  next_eligible_at: string | null
  updated_at: string | null
}

export interface AdminQueueHealth {
  pending: number
  processing: number
  failed: number
  applied: number
  other: number
  total: number
  oldest_pending_age_seconds: number | null
}

export interface AdminJobsQueues {
  mutation_outbox: AdminQueueHealth
  sync_events: AdminQueueHealth
}

export interface AdminJobsResponse {
  generated_at: string
  job_runs: AdminJobRun[]
  queues: AdminJobsQueues
}

const KEYS = {
  all: () => ['admin-jobs'] as const,
}

export const adminJobsQueryKeys = KEYS

export function fetchAdminJobs(): Promise<AdminJobsResponse> {
  return request<AdminJobsResponse>('/api/admin/jobs', { method: 'GET' })
}

/**
 * Live worker periodic-job + queue health. Refetches every 15s so the
 * ops screen reflects the fleet without a manual reload. Pass
 * `refetchInterval` (or any UseQueryOptions) to override.
 */
export function useAdminJobs(options?: Partial<UseQueryOptions<AdminJobsResponse>>) {
  return useQuery<AdminJobsResponse>({
    queryKey: KEYS.all(),
    queryFn: fetchAdminJobs,
    refetchInterval: 15_000,
    ...options,
  })
}

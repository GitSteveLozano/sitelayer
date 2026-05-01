// Workers — types + hooks for the company roster.
// Wraps the existing /api/workers endpoints in apps/api/src/routes/workers.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface Worker {
  id: string
  name: string
  role: string
  version: number
  deleted_at: string | null
  created_at: string
}

export interface WorkerListResponse {
  workers: Worker[]
}

export interface WorkerCreateRequest {
  name: string
  role?: string
}

export interface WorkerPatchRequest {
  name?: string
  role?: string
  expected_version?: number
}

const KEYS = {
  all: () => ['workers'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const workerQueryKeys = KEYS

export function fetchWorkers(): Promise<WorkerListResponse> {
  return request<WorkerListResponse>('/api/workers')
}

export function createWorker(input: WorkerCreateRequest): Promise<Worker> {
  return request<Worker>('/api/workers', { method: 'POST', json: input })
}

export function useWorkers(options?: Partial<UseQueryOptions<WorkerListResponse>>) {
  return useQuery<WorkerListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchWorkers,
    staleTime: 5 * 60_000,
    ...options,
  })
}

export function useCreateWorker() {
  const qc = useQueryClient()
  return useMutation<Worker, Error, WorkerCreateRequest>({
    mutationFn: (input) => createWorker(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all() })
    },
  })
}

export function usePatchWorker(id: string) {
  const qc = useQueryClient()
  return useMutation<Worker, Error, WorkerPatchRequest>({
    mutationFn: (input) => request<Worker>(`/api/workers/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteWorker() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/workers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

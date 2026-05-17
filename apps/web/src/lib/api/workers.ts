// Workers — types + hooks for the company roster.
// Wraps the existing /api/workers endpoints in apps/api/src/routes/workers.ts.
//
// Standard CRUD hooks come from the shared factory. The extra
// `sendWorkerMessage` mutation (which does not fit the CRUD shape) and the
// imperative `createWorker` helper stay defined locally.

import { useMutation, type UseQueryOptions } from '@tanstack/react-query'

import { request } from './client'
import { createCrudHooks } from './crud-factory'

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

const hooks = createCrudHooks<WorkerListResponse, Worker, WorkerCreateRequest, WorkerPatchRequest>({
  entity: 'workers',
  basePath: '/api/workers',
})

export const workerQueryKeys = hooks.queryKeys
export const fetchWorkers = hooks.fetchList
export const useCreateWorker = hooks.useCreate
export const usePatchWorker = hooks.usePatch
export const useDeleteWorker = hooks.useDelete

/**
 * Re-exposed so XState actors that can't go through hooks (or call sites
 * that want to do their own optimistic update) can still create a worker
 * imperatively. The TanStack hook above goes through `request<T>` too.
 */
export function createWorker(input: WorkerCreateRequest): Promise<Worker> {
  return request<Worker>('/api/workers', { method: 'POST', json: input })
}

/**
 * Thin wrapper so callers can keep passing `useWorkers(options)` (the
 * factory's `useList` accepts the same `Partial<UseQueryOptions>` shape;
 * this re-export pins the response type for ergonomics).
 */
export function useWorkers(options?: Partial<UseQueryOptions<WorkerListResponse>>) {
  return hooks.useList(options)
}

export interface WorkerMessageRequest {
  body: string
  subject?: string
}

export interface WorkerMessageResponse {
  notification_id: string
  recipient_clerk_user_id: string
}

export function sendWorkerMessage(workerId: string, input: WorkerMessageRequest): Promise<WorkerMessageResponse> {
  return request<WorkerMessageResponse>(`/api/workers/${encodeURIComponent(workerId)}/messages`, {
    method: 'POST',
    json: input,
  })
}

export function useSendWorkerMessage() {
  return useMutation<WorkerMessageResponse, Error, { workerId: string; input: WorkerMessageRequest }>({
    mutationFn: ({ workerId, input }) => sendWorkerMessage(workerId, input),
  })
}

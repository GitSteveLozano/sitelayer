// Service items — code-keyed catalog of billable items.
// Wraps GET/POST/PATCH/DELETE /api/service-items in
// apps/api/src/routes/service-items.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface ServiceItem {
  code: string
  name: string
  category: string
  unit: string
  default_rate: string | null
  source: string
  version: number
}

export interface ServiceItemListResponse {
  serviceItems: ServiceItem[]
}

export interface ServiceItemCreateRequest {
  code: string
  name: string
  category?: string
  unit?: string
  default_rate?: number | string | null
  source?: string
}

export interface ServiceItemPatchRequest {
  name?: string
  category?: string
  unit?: string
  default_rate?: number | string | null
  expected_version?: number
}

const KEYS = {
  all: () => ['service-items'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const serviceItemQueryKeys = KEYS

export function fetchServiceItems(): Promise<ServiceItemListResponse> {
  return request<ServiceItemListResponse>('/api/service-items')
}

export function useServiceItems(options?: Partial<UseQueryOptions<ServiceItemListResponse>>) {
  return useQuery<ServiceItemListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchServiceItems,
    staleTime: 5 * 60_000,
    ...options,
  })
}

export function useCreateServiceItem() {
  const qc = useQueryClient()
  return useMutation<ServiceItem, Error, ServiceItemCreateRequest>({
    mutationFn: (input) => request<ServiceItem>('/api/service-items', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function usePatchServiceItem(code: string) {
  const qc = useQueryClient()
  return useMutation<ServiceItem, Error, ServiceItemPatchRequest>({
    mutationFn: (input) =>
      request<ServiceItem>(`/api/service-items/${encodeURIComponent(code)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteServiceItem() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { code: string; expected_version?: number }>({
    mutationFn: ({ code, expected_version }) =>
      request(`/api/service-items/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

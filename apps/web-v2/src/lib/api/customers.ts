// Customers — types + hooks for the company customer roster.
// Wraps /api/customers in apps/api/src/routes/customers.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export interface Customer {
  id: string
  external_id: string | null
  name: string
  source: string
  version: number
  deleted_at: string | null
  created_at: string
}

export interface CustomerListResponse {
  customers: Customer[]
}

export interface CustomerCreateRequest {
  name: string
  external_id?: string | null
  source?: string
}

export interface CustomerPatchRequest {
  name?: string
  external_id?: string | null
  source?: string
  expected_version?: number
}

const KEYS = {
  all: () => ['customers'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const customerQueryKeys = KEYS

export function fetchCustomers(): Promise<CustomerListResponse> {
  return request<CustomerListResponse>('/api/customers')
}

export function useCustomers(options?: Partial<UseQueryOptions<CustomerListResponse>>) {
  return useQuery<CustomerListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchCustomers,
    staleTime: 5 * 60_000,
    ...options,
  })
}

export function useCreateCustomer() {
  const qc = useQueryClient()
  return useMutation<Customer, Error, CustomerCreateRequest>({
    mutationFn: (input) => request<Customer>('/api/customers', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function usePatchCustomer(id: string) {
  const qc = useQueryClient()
  return useMutation<Customer, Error, CustomerPatchRequest>({
    mutationFn: (input) =>
      request<Customer>(`/api/customers/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/customers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

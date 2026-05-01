// Pricing profiles — labor-rate-by-division config (jsonb).
// Wraps /api/pricing-profiles in apps/api/src/routes/pricing-profiles.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

/**
 * The `config` jsonb is shaped like:
 *   { divisions: { [code: string]: { rate_standard: number; rate_overtime: number } } }
 * but the v2 hook keeps it `unknown` so the editor can render JSON
 * directly until a typed editor lands.
 */
export interface PricingProfile {
  id: string
  name: string
  is_default: boolean
  config: unknown
  version: number
  created_at: string
}

export interface PricingProfileListResponse {
  pricingProfiles: PricingProfile[]
}

export interface PricingProfileCreateRequest {
  name: string
  is_default?: boolean
  config?: unknown
}

export interface PricingProfilePatchRequest {
  name?: string
  is_default?: boolean
  config?: unknown
  expected_version?: number
}

const KEYS = {
  all: () => ['pricing-profiles'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const pricingProfileQueryKeys = KEYS

export function fetchPricingProfiles(): Promise<PricingProfileListResponse> {
  return request<PricingProfileListResponse>('/api/pricing-profiles')
}

export function usePricingProfiles(options?: Partial<UseQueryOptions<PricingProfileListResponse>>) {
  return useQuery<PricingProfileListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchPricingProfiles,
    staleTime: 5 * 60_000,
    ...options,
  })
}

export function useCreatePricingProfile() {
  const qc = useQueryClient()
  return useMutation<PricingProfile, Error, PricingProfileCreateRequest>({
    mutationFn: (input) => request<PricingProfile>('/api/pricing-profiles', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function usePatchPricingProfile(id: string) {
  const qc = useQueryClient()
  return useMutation<PricingProfile, Error, PricingProfilePatchRequest>({
    mutationFn: (input) =>
      request<PricingProfile>(`/api/pricing-profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeletePricingProfile() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/pricing-profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

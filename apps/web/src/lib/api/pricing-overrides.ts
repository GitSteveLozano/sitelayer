// Per-project (and per-customer) service-item rate overrides — the write side
// of the pricing chain. Cavy asked (WhatsApp 4/11) for project-specific pricing
// and per-builder templates; these hooks drive /api/projects/:id/pricing-overrides
// and /api/customers/:id/pricing-overrides. After editing overrides the caller
// recomputes the estimate so the new rates flow through the resolver into the
// estimate lines.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface PricingOverride {
  id: string
  service_item_code: string
  rate: string
  unit: string
  version: number
  updated_at: string
}

export type PricingScope = { kind: 'project' | 'customer'; id: string }

function basePath(scope: PricingScope): string {
  const seg = scope.kind === 'project' ? 'projects' : 'customers'
  return `/api/${seg}/${encodeURIComponent(scope.id)}/pricing-overrides`
}

export function pricingOverrideKey(scope: PricingScope) {
  return ['pricing-overrides', scope.kind, scope.id] as const
}

export function usePricingOverrides(scope: PricingScope, enabled = true) {
  return useQuery({
    queryKey: pricingOverrideKey(scope),
    enabled: enabled && Boolean(scope.id),
    queryFn: () => request<{ overrides: PricingOverride[] }>(basePath(scope), { method: 'GET' }),
  })
}

export function useUpsertPricingOverride(scope: PricingScope) {
  const qc = useQueryClient()
  return useMutation<PricingOverride, Error, { service_item_code: string; rate: number; unit?: string }>({
    mutationFn: async (input) => {
      const res = await request<{ override: PricingOverride }>(basePath(scope), { method: 'PUT', json: input })
      return res.override
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pricingOverrideKey(scope) }),
  })
}

export function useDeletePricingOverride(scope: PricingScope) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { service_item_code: string }>({
    mutationFn: (input) => request(basePath(scope), { method: 'DELETE', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: pricingOverrideKey(scope) }),
  })
}

/** Recompute a project's estimate so override changes land on the lines. */
export function recomputeEstimate(projectId: string): Promise<unknown> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/estimate/recompute`, { method: 'POST' })
}

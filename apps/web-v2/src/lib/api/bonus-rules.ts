// Bonus rules — tier schedule (jsonb config) for crew bonus payouts.
// Wraps /api/bonus-rules in apps/api/src/routes/bonus-rules.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

/**
 * The `config` jsonb is shaped like:
 *   { tiers: [{ minMargin: number; payoutPercent: number }] }
 * Kept `unknown` here so the editor can render the JSON directly
 * until a typed tier-table editor lands.
 */
export interface BonusRule {
  id: string
  name: string
  config: unknown
  is_active: boolean
  version: number
  created_at: string
}

export interface BonusRuleListResponse {
  bonusRules: BonusRule[]
}

export interface BonusRuleCreateRequest {
  name: string
  config?: unknown
  is_active?: boolean
}

export interface BonusRulePatchRequest {
  name?: string
  config?: unknown
  is_active?: boolean
  expected_version?: number
}

const KEYS = {
  all: () => ['bonus-rules'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const bonusRuleQueryKeys = KEYS

export function fetchBonusRules(): Promise<BonusRuleListResponse> {
  return request<BonusRuleListResponse>('/api/bonus-rules')
}

export function useBonusRules(options?: Partial<UseQueryOptions<BonusRuleListResponse>>) {
  return useQuery<BonusRuleListResponse>({
    queryKey: KEYS.list(),
    queryFn: fetchBonusRules,
    staleTime: 5 * 60_000,
    ...options,
  })
}

export function useCreateBonusRule() {
  const qc = useQueryClient()
  return useMutation<BonusRule, Error, BonusRuleCreateRequest>({
    mutationFn: (input) => request<BonusRule>('/api/bonus-rules', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function usePatchBonusRule(id: string) {
  const qc = useQueryClient()
  return useMutation<BonusRule, Error, BonusRulePatchRequest>({
    mutationFn: (input) =>
      request<BonusRule>(`/api/bonus-rules/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

export function useDeleteBonusRule() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/bonus-rules/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all() }),
  })
}

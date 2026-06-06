// Bonus rules — tier schedule (jsonb config) for crew bonus payouts.
// Wraps /api/bonus-rules in apps/api/src/routes/bonus-rules.ts.
//
// Hooks come from the shared CRUD factory; this module owns the typed
// surface and re-exports under the existing names so consumer screens
// keep working without changes.

import { createCrudHooks } from './crud-factory'

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

const hooks = createCrudHooks<BonusRuleListResponse, BonusRule, BonusRuleCreateRequest, BonusRulePatchRequest>({
  entity: 'bonus-rules',
  basePath: '/api/bonus-rules',
})

export const bonusRuleQueryKeys = hooks.queryKeys
export const fetchBonusRules = hooks.fetchList
export const useBonusRules = hooks.useList
export const useCreateBonusRule = hooks.useCreate
export const usePatchBonusRule = hooks.usePatch
export const useDeleteBonusRule = hooks.useDelete

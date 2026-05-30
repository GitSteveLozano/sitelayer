/**
 * Resolve the markup `config` jsonb to feed into `applyMarkup` for assembly
 * explosion (docs/PLANSWIFT_PHASE2_PLAN.md §3b step 3).
 *
 * The pricing CHAIN (`pricing.ts`) resolves per-line rates from
 * project/customer/company overrides; the markup BUCKETS (material waste, labor
 * burden, sub/freight markup, profit margin) live on the pricing PROFILE's
 * free-form `config` jsonb. For Phase 2 we read the company's default pricing
 * profile config (the same row the bootstrap surfaces). `applyMarkup` applies
 * DEFAULT_MARKUP_CONFIG when a key is absent, so a company with no profile (or a
 * profile with an empty config) still produces sensible, transparent numbers.
 */

import type { LedgerExecutor } from './mutation-tx.js'

/**
 * Returns the raw `config` jsonb of the company's default pricing profile (or
 * the oldest profile if none is flagged default), or `null` when no profile
 * exists. `applyMarkup` tolerates `null` and falls back to industry defaults.
 */
export async function loadDefaultPricingProfileConfig(executor: LedgerExecutor, companyId: string): Promise<unknown> {
  const result = await executor.query<{ config: unknown }>(
    `select config
       from pricing_profiles
      where company_id = $1
      order by is_default desc, created_at asc
      limit 1`,
    [companyId],
  )
  return result.rows[0]?.config ?? null
}

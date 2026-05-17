// Pricing profiles — labor-rate-by-division config (jsonb).
// Wraps /api/pricing-profiles in apps/api/src/routes/pricing-profiles.ts.
//
// Hooks come from the shared CRUD factory; this module owns the typed
// surface and re-exports under the existing names so consumer screens
// keep working without changes.

import { createCrudHooks } from './crud-factory'

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

const hooks = createCrudHooks<
  PricingProfileListResponse,
  PricingProfile,
  PricingProfileCreateRequest,
  PricingProfilePatchRequest
>({
  entity: 'pricing-profiles',
  basePath: '/api/pricing-profiles',
})

export const pricingProfileQueryKeys = hooks.queryKeys
export const fetchPricingProfiles = hooks.fetchList
export const usePricingProfiles = hooks.useList
export const useCreatePricingProfile = hooks.useCreate
export const usePatchPricingProfile = hooks.usePatch
export const useDeletePricingProfile = hooks.useDelete

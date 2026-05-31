// Service items — code-keyed catalog of billable items.
// Wraps GET/POST/PATCH/DELETE /api/service-items in
// apps/api/src/routes/service-items.ts.
//
// Hooks come from the shared CRUD factory. Service items are keyed by
// `code` rather than `id`; the factory takes `idKey: 'code'` so the
// generated DELETE hook accepts `{ code, expected_version? }` to match
// the existing call sites.

import { createCrudHooks } from './crud-factory'

/** One entry in an item's cost-change trail (most-recent first). */
export interface ServiceItemRateHistoryEntry {
  rate: string | null
  unit: string
  recorded_at: string
}

export interface ServiceItem {
  code: string
  name: string
  category: string
  unit: string
  default_rate: string | null
  source: string
  version: number
  /** Productivity factor on top of the catalog rate (e.g. 1.25× std install). */
  labor_multiplier?: string | null
  /** Lifecycle marker, distinct from soft-delete. */
  status?: 'active' | 'seasonal' | 'retired'
  /** Curated service_item_divisions codes this item is valid for (may be empty). */
  divisions?: string[]
  /** Recent rate changes, most-recent first (capped server-side). */
  rate_history?: ServiceItemRateHistoryEntry[]
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
  labor_multiplier?: number | string | null
  status?: 'active' | 'seasonal' | 'retired'
  source?: string
}

export interface ServiceItemPatchRequest {
  name?: string
  category?: string
  unit?: string
  default_rate?: number | string | null
  labor_multiplier?: number | string | null
  status?: 'active' | 'seasonal' | 'retired'
  expected_version?: number
}

const hooks = createCrudHooks<ServiceItemListResponse, ServiceItem, ServiceItemCreateRequest, ServiceItemPatchRequest>({
  entity: 'service-items',
  basePath: '/api/service-items',
  idKey: 'code',
})

export const serviceItemQueryKeys = hooks.queryKeys
export const fetchServiceItems = hooks.fetchList
export const useServiceItems = hooks.useList
export const useCreateServiceItem = hooks.useCreate
export const usePatchServiceItem = hooks.usePatch
export const useDeleteServiceItem = hooks.useDelete

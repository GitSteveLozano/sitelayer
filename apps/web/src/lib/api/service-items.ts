// Service items — code-keyed catalog of billable items.
// Wraps GET/POST/PATCH/DELETE /api/service-items in
// apps/api/src/routes/service-items.ts.
//
// Hooks come from the shared CRUD factory. Service items are keyed by
// `code` rather than `id`; the factory takes `idKey: 'code'` so the
// generated DELETE hook accepts `{ code, expected_version? }` to match
// the existing call sites.

import { createCrudHooks } from './crud-factory'

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

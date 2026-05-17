// Customers — types + hooks for the company customer roster.
// Wraps /api/customers in apps/api/src/routes/customers.ts.
//
// Hooks are produced by the shared CRUD factory; the per-entity surface
// here is just type definitions + a thin re-export so existing callers
// (`useCustomers`, `useCreateCustomer`, …) keep working unchanged.

import { createCrudHooks } from './crud-factory'

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

const hooks = createCrudHooks<CustomerListResponse, Customer, CustomerCreateRequest, CustomerPatchRequest>({
  entity: 'customers',
  basePath: '/api/customers',
})

export const customerQueryKeys = hooks.queryKeys
export const fetchCustomers = hooks.fetchList
export const useCustomers = hooks.useList
export const useCreateCustomer = hooks.useCreate
export const usePatchCustomer = hooks.usePatch
export const useDeleteCustomer = hooks.useDelete

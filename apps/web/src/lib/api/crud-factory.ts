// CRUD hook factory — shared TanStack Query plumbing for entity modules
// that follow the same `list / create / patch / delete` shape used by
// customers, workers, service-items, pricing-profiles, bonus-rules, etc.
//
// Each per-entity module wraps the factory output once and re-exports the
// existing function names (`useCustomers`, `useCreateCustomer`, …) so
// consumer screens are not affected by the migration. The factory itself
// owns:
//   - the query-key namespace (`['<entity>']`, `['<entity>', 'list']`,
//     `['<entity>', 'detail', id]`)
//   - the list/create/patch/delete `request<T>()` calls
//   - auto-invalidation of `KEYS.all()` on mutation success
//
// Custom behaviour (multi-key invalidation, photo upload, etc.) lives in
// the calling module — the factory intentionally does not try to model
// every possible variant.
//
// See `apps/web/src/lib/api/customers.ts` for the canonical usage.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'

import { request } from './client'

export interface CrudFactoryOptions<TListResponse, TRow, TCreateReq, TPatchReq> {
  /** Query-key namespace, e.g. `'customers'`. */
  entity: string
  /** List + create endpoint, e.g. `'/api/customers'`. */
  basePath: string
  /**
   * Per-item endpoint builder; defaults to `${basePath}/${encodeURIComponent(id)}`.
   * Override when the item path is not just `basePath + id` (rare).
   */
  itemPath?: (id: string) => string
  /**
   * Property name on the row used to identify the record for PATCH/DELETE.
   * Defaults to `'id'`. Set to `'code'` for code-keyed catalogs like
   * service-items.
   */
  idKey?: string
  /**
   * Stale time for the list query, in ms. Defaults to 5 minutes — matches
   * the existing per-module hooks.
   */
  staleTime?: number
  /**
   * Function name placeholders for the typed hooks — these are purely for
   * the factory's generic constraints. The exported function names are
   * controlled by the calling module re-exporting the factory result.
   */
  // (no runtime field — TS-only marker so generics can be referenced.)
  __typeMarker?: {
    listResponse?: TListResponse
    row?: TRow
    create?: TCreateReq
    patch?: TPatchReq
  }
}

export interface CrudQueryKeys {
  all: () => readonly unknown[]
  list: () => readonly unknown[]
  detail: (id: string) => readonly unknown[]
}

export interface CrudDeleteRequest {
  expected_version?: number
  // `id` or `code` is supplied dynamically based on idKey; declared as
  // index signature so callers can pass `{ id, expected_version }` or
  // `{ code, expected_version }` interchangeably.
  [key: string]: unknown
}

export interface CrudHooks<TListResponse, TRow, TCreateReq, TPatchReq> {
  queryKeys: CrudQueryKeys
  fetchList: () => Promise<TListResponse>
  useList: (options?: Partial<UseQueryOptions<TListResponse>>) => UseQueryResult<TListResponse>
  useCreate: () => UseMutationResult<TRow, Error, TCreateReq>
  usePatch: (id: string) => UseMutationResult<TRow, Error, TPatchReq>
  useDelete: () => UseMutationResult<unknown, Error, CrudDeleteRequest>
}

/**
 * Build the standard CRUD hook bundle for an entity module. See module
 * doc-comment for the contract.
 */
export function createCrudHooks<
  TListResponse,
  TRow,
  TCreateReq = Partial<TRow>,
  TPatchReq = Partial<TRow>,
>(
  opts: CrudFactoryOptions<TListResponse, TRow, TCreateReq, TPatchReq>,
): CrudHooks<TListResponse, TRow, TCreateReq, TPatchReq> {
  const idKey = opts.idKey ?? 'id'
  const staleTime = opts.staleTime ?? 5 * 60_000
  const itemPath = opts.itemPath ?? ((id: string) => `${opts.basePath}/${encodeURIComponent(id)}`)

  const queryKeys: CrudQueryKeys = {
    all: () => [opts.entity] as const,
    list: () => [opts.entity, 'list'] as const,
    detail: (id: string) => [opts.entity, 'detail', id] as const,
  }

  function fetchList(): Promise<TListResponse> {
    return request<TListResponse>(opts.basePath)
  }

  function useList(options?: Partial<UseQueryOptions<TListResponse>>): UseQueryResult<TListResponse> {
    return useQuery<TListResponse>({
      queryKey: queryKeys.list(),
      queryFn: fetchList,
      staleTime,
      ...options,
    })
  }

  function useCreate(): UseMutationResult<TRow, Error, TCreateReq> {
    const qc = useQueryClient()
    return useMutation<TRow, Error, TCreateReq>({
      mutationFn: (input) => request<TRow>(opts.basePath, { method: 'POST', json: input }),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: queryKeys.all() })
      },
    })
  }

  function usePatch(id: string): UseMutationResult<TRow, Error, TPatchReq> {
    const qc = useQueryClient()
    return useMutation<TRow, Error, TPatchReq>({
      mutationFn: (input) => request<TRow>(itemPath(id), { method: 'PATCH', json: input }),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: queryKeys.all() })
      },
    })
  }

  function useDelete(): UseMutationResult<unknown, Error, CrudDeleteRequest> {
    const qc = useQueryClient()
    return useMutation<unknown, Error, CrudDeleteRequest>({
      mutationFn: (input) => {
        const idValue = input[idKey]
        if (typeof idValue !== 'string' || !idValue) {
          throw new Error(`createCrudHooks(${opts.entity}): delete called without '${idKey}'`)
        }
        const expected = input.expected_version
        return request(itemPath(idValue), {
          method: 'DELETE',
          json: expected !== undefined ? { expected_version: expected } : undefined,
        })
      },
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: queryKeys.all() })
      },
    })
  }

  return {
    queryKeys,
    fetchList,
    useList,
    useCreate,
    usePatch,
    useDelete,
  }
}

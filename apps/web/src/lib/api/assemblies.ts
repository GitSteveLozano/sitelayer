// Assembly resource hooks for the Estimator · Assemblies editor and the
// Estimate Builder line-item drill-down.
//
// The list/detail/create/add-component hooks already live in
// `apps/web/src/lib/api/takeoff.ts` (Phase 3F); this module re-exports
// them and adds the editor-only mutations the new Assemblies screen needs
// (rename header, soft-delete, edit a component, remove a component) so a
// screen has one import surface for the whole CRUD set.
//
// `useAssemblyByServiceItem` (Estimate Builder drill-down) stays here too:
// given a `service_item_code` it resolves the current assembly + its
// components in one call.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'
import {
  type Assembly,
  type AssemblyComponent,
  useAddAssemblyComponent,
  useAssemblies,
  useAssembly,
  useCreateAssembly,
} from './takeoff'

const KEYS = {
  byServiceItem: (code: string) => ['assemblies', 'by-service-item', code] as const,
  detailFromCode: (code: string) => ['assemblies', 'by-service-item', code, 'detail'] as const,
}

export const assemblyQueryKeys = KEYS

interface AssemblyListResponse {
  assemblies: Assembly[]
}

interface AssemblyDetailResponse {
  assembly: Assembly
  components: AssemblyComponent[]
}

export type AssemblyComponentKind = 'material' | 'labor' | 'sub' | 'freight'

/**
 * Fetch the current assembly for a service-item-code in a single call.
 * Returns `null` (not an error) if no assembly is configured for the code
 * — the Estimate Builder uses that to show an inline "no assembly defined"
 * fallback in the drill-down rather than a hard error.
 */
export function useAssemblyByServiceItem(code: string | null | undefined) {
  return useQuery<AssemblyDetailResponse | null>({
    queryKey: KEYS.detailFromCode(code ?? ''),
    queryFn: async () => {
      const list = await request<AssemblyListResponse>(`/api/assemblies?service_item_code=${encodeURIComponent(code!)}`)
      const head = list.assemblies[0]
      if (!head) return null
      return request<AssemblyDetailResponse>(`/api/assemblies/${encodeURIComponent(head.id)}`)
    },
    enabled: Boolean(code),
    // Assemblies don't change line-by-line during an editing session;
    // a 5-minute stale window matches the service-items hook so the
    // drill-down stays responsive even when the estimator opens many
    // rows in a row.
    staleTime: 5 * 60_000,
  })
}

/** PATCH the assembly header (rename / retarget service item / unit). */
export function useUpdateAssembly() {
  const qc = useQueryClient()
  return useMutation<
    { assembly: Assembly },
    Error,
    {
      id: string
      name?: string
      service_item_code?: string
      description?: string | null
      unit?: string
    }
  >({
    mutationFn: ({ id, ...body }) =>
      request(`/api/assemblies/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

/** Soft-delete an assembly. */
export function useDeleteAssembly() {
  const qc = useQueryClient()
  return useMutation<{ assembly: Assembly }, Error, { id: string }>({
    mutationFn: ({ id }) => request(`/api/assemblies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

/** PATCH one component (and recompute the parent's cached total_rate server-side). */
export function useUpdateAssemblyComponent() {
  const qc = useQueryClient()
  return useMutation<
    { component: AssemblyComponent },
    Error,
    {
      assemblyId: string
      componentId: string
      kind?: AssemblyComponentKind
      name?: string
      quantity_per_unit?: number
      unit?: string
      unit_cost?: number
      waste_pct?: number
    }
  >({
    mutationFn: ({ assemblyId, componentId, ...body }) =>
      request(`/api/assemblies/${encodeURIComponent(assemblyId)}/components/${encodeURIComponent(componentId)}`, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

/** Remove one component (and recompute the parent's cached total_rate server-side). */
export function useRemoveAssemblyComponent() {
  const qc = useQueryClient()
  return useMutation<{ component: AssemblyComponent }, Error, { assemblyId: string; componentId: string }>({
    mutationFn: ({ assemblyId, componentId }) =>
      request(`/api/assemblies/${encodeURIComponent(assemblyId)}/components/${encodeURIComponent(componentId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

export { type Assembly, type AssemblyComponent, useAddAssemblyComponent, useAssemblies, useAssembly, useCreateAssembly }

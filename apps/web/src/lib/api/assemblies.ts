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

// ---------------------------------------------------------------------------
// Phase 2 — explode preview + measurement attach
// ---------------------------------------------------------------------------

/** One resolved component line in an explode preview (raw cost, pre-markup). */
export interface AssemblyResolutionLine {
  component_id: string
  kind: AssemblyComponentKind
  name: string
  unit: string
  quantity: number
  unit_cost: number
  amount: number
}

export interface AssemblyResolution {
  assembly_id: string
  service_item_code: string
  total: number
  by_kind: Record<AssemblyComponentKind, number>
  lines: AssemblyResolutionLine[]
}

/** One row of the markup breakdown the explode preview returns for transparency. */
export interface MarkupBreakdownRow {
  label: string
  basis: AssemblyComponentKind | 'profit'
  multiplier: number
  before: number
  after: number
}

export interface MarkupBreakdown {
  lines: MarkupBreakdownRow[]
  subtotal_before_profit: number
  total: number
}

/** One priced estimate line the explode preview would emit (markup baked in). */
export interface ExplodedLine {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
  assembly_id: string
  assembly_component_id: string
  kind: AssemblyComponentKind
}

export interface ExplodeResponse {
  resolution: AssemblyResolution
  markup: MarkupBreakdown
  lines: ExplodedLine[]
}

export interface ExplodeInput {
  measurement_quantity: number
  measurement_unit?: string
  is_deduction?: boolean
}

/**
 * POST /api/assemblies/:id/explode — preview-only (no DB write). Runs the same
 * formula + resolveAssembly + applyMarkup pipeline as recompute against a
 * sample measurement, returning the resolution + markup breakdown + the priced
 * lines. Powers the "what will this cost" affordance in the estimator flow.
 */
export function useExplodeAssembly() {
  return useMutation<ExplodeResponse, Error, { id: string } & ExplodeInput>({
    mutationFn: ({ id, ...body }) =>
      request(`/api/assemblies/${encodeURIComponent(id)}/explode`, { method: 'POST', json: body }),
  })
}

/**
 * PATCH /api/takeoff/measurements/:id with `{ assembly_id }` — attach (uuid) or
 * detach (null) an assembly to a measurement. Invalidates the takeoff +
 * estimate caches so the estimate panel recomputes with the exploded lines.
 */
export function useAttachAssemblyToMeasurement() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { measurementId: string; assemblyId: string | null; expectedVersion?: number }>({
    mutationFn: ({ measurementId, assemblyId, expectedVersion }) =>
      request(`/api/takeoff/measurements/${encodeURIComponent(measurementId)}`, {
        method: 'PATCH',
        json: {
          assembly_id: assemblyId,
          ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['takeoff'] })
      void qc.invalidateQueries({ queryKey: ['estimate'] })
    },
  })
}

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

/**
 * Duplicate an assembly + all of its components. Reuses the create path
 * (POST /api/assemblies then POST …/components for each line) rather than a
 * server-side clone route so it stays additive against the existing API.
 *
 * Fetches the source detail so the copy carries the full recipe even when the
 * caller only has the list header. The new assembly gets a "(copy)" suffix on
 * its name and the same scope service item / unit / description; every
 * component (kind / name / quantity / cost / waste + any Phase 2 formula) is
 * re-created on the new assembly. Returns the freshly created assembly.
 */
export function useCloneAssembly() {
  const qc = useQueryClient()
  return useMutation<{ assembly: Assembly }, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const source = await request<AssemblyDetailResponse>(`/api/assemblies/${encodeURIComponent(id)}`)
      const created = await request<{ assembly: Assembly; components: AssemblyComponent[] }>('/api/assemblies', {
        method: 'POST',
        json: {
          service_item_code: source.assembly.service_item_code,
          name: `${source.assembly.name} (copy)`,
          ...(source.assembly.description != null ? { description: source.assembly.description } : {}),
          unit: source.assembly.unit,
        },
      })
      const newId = created.assembly.id
      // Copy components one at a time, preserving sort order. The server
      // recomputes the cached total_rate on each component write.
      for (const c of source.components) {
        await request(`/api/assemblies/${encodeURIComponent(newId)}/components`, {
          method: 'POST',
          json: {
            kind: c.kind,
            name: c.name,
            quantity_per_unit: Number(c.quantity_per_unit),
            unit: c.unit,
            unit_cost: Number(c.unit_cost),
            waste_pct: Number(c.waste_pct),
            ...(c.quantity_formula
              ? { quantity_formula: c.quantity_formula, formula_vars: c.formula_vars ?? null }
              : {}),
          },
        })
      }
      return { assembly: created.assembly }
    },
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
      /** Phase 2 — set/clear the quantity formula (null/'' clears back to static). */
      quantity_formula?: string | null
      formula_vars?: Record<string, number | string> | null
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

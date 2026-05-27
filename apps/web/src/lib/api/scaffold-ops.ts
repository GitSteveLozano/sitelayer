// Branches, rental vendors, external rentals, scaffold catalog, and BOMs.
// API surface lives in apps/api/src/routes/scaffold-ops.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface Branch {
  id: string
  company_id: string
  code: string
  name: string
  address: string | null
  is_default: boolean
  version: number
  created_at: string
  updated_at: string
}

export interface RentalVendor {
  id: string
  company_id: string
  code: string
  name: string
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface ExternalRental {
  id: string
  company_id: string
  vendor_id: string
  inventory_item_id: string
  project_id: string | null
  branch_id: string | null
  quantity: string
  returned_quantity: string
  vendor_rate: string
  rate_unit: string
  on_rent_date: string
  off_rent_date: string | null
  vendor_po: string | null
  status: string
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ScaffoldManufacturer {
  id: string
  company_id: string | null
  code: string
  name: string
  website: string | null
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface ScaffoldSystem {
  id: string
  company_id: string | null
  manufacturer_id: string | null
  code: string
  name: string
  description: string | null
  active: boolean
}

export interface CatalogPart {
  id: string
  company_id: string
  manufacturer_id: string | null
  scaffold_system_id: string | null
  inventory_item_id: string | null
  sku: string
  description: string
  unit: string
  weight_kg: string | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  surface_area_m2: string | null
  attrs: Record<string, unknown>
  active: boolean
  created_at: string
}

export interface Bom {
  id: string
  company_id: string
  project_id: string
  source: string
  source_ref: string | null
  name: string
  notes: string | null
  status: 'draft' | 'approved' | 'superseded'
  approved_at: string | null
  approved_by: string | null
  total_weight_kg: string
  total_lines: number
  created_at: string
  updated_at: string
}

export interface BomLine {
  id: string
  company_id: string
  bom_id: string
  catalog_part_id: string
  quantity: string
  notes: string | null
  attrs: Record<string, unknown>
}

export interface BomDetail extends Bom {
  lines: BomLine[]
}

// ---- branches ----------------------------------------------------------------

export function useBranches() {
  return useQuery<{ branches: Branch[] }>({
    queryKey: ['branches'],
    queryFn: () => request<{ branches: Branch[] }>('/api/branches'),
  })
}

export function useCreateBranch() {
  const qc = useQueryClient()
  return useMutation<Branch, Error, { code: string; name: string; address?: string | null; is_default?: boolean }>({
    mutationFn: (input) => request<Branch>('/api/branches', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branches'] }),
  })
}

export function usePatchBranch() {
  const qc = useQueryClient()
  return useMutation<Branch, Error, { id: string; name?: string; address?: string | null; is_default?: boolean }>({
    mutationFn: ({ id, ...input }) =>
      request<Branch>(`/api/branches/${encodeURIComponent(id)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branches'] }),
  })
}

// ---- vendors / cross-hire ----------------------------------------------------

export function useRentalVendors() {
  return useQuery<{ vendors: RentalVendor[] }>({
    queryKey: ['rental-vendors'],
    queryFn: () => request<{ vendors: RentalVendor[] }>('/api/rental-vendors'),
  })
}
export function useCreateRentalVendor() {
  const qc = useQueryClient()
  return useMutation<
    RentalVendor,
    Error,
    { code: string; name: string; contact_email?: string; contact_phone?: string; notes?: string }
  >({
    mutationFn: (input) => request<RentalVendor>('/api/rental-vendors', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rental-vendors'] }),
  })
}

export function useExternalRentals(params: { projectId?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.projectId) qs.set('project_id', params.projectId)
  const url = qs.toString() ? `/api/external-rentals?${qs.toString()}` : '/api/external-rentals'
  return useQuery<{ externalRentals: ExternalRental[] }>({
    queryKey: ['external-rentals', params.projectId ?? 'all'],
    queryFn: () => request<{ externalRentals: ExternalRental[] }>(url),
  })
}

export function useCreateExternalRental() {
  const qc = useQueryClient()
  return useMutation<
    ExternalRental,
    Error,
    {
      vendor_id: string
      inventory_item_id: string
      quantity: number
      on_rent_date: string
      project_id?: string
      branch_id?: string
      vendor_rate?: number
      rate_unit?: string
      vendor_po?: string
      notes?: string
    }
  >({
    mutationFn: (input) => request<ExternalRental>('/api/external-rentals', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['external-rentals'] }),
  })
}

export function useReturnExternalRental() {
  const qc = useQueryClient()
  return useMutation<ExternalRental, Error, { id: string; returned_quantity: number; off_rent_date?: string }>({
    mutationFn: ({ id, ...input }) =>
      request<ExternalRental>(`/api/external-rentals/${encodeURIComponent(id)}/return`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['external-rentals'] }),
  })
}

// ---- scaffold catalog --------------------------------------------------------

export function useScaffoldManufacturers() {
  return useQuery<{ manufacturers: ScaffoldManufacturer[] }>({
    queryKey: ['scaffold-manufacturers'],
    queryFn: () => request<{ manufacturers: ScaffoldManufacturer[] }>('/api/scaffold/manufacturers'),
  })
}
export function useScaffoldSystems(manufacturerId?: string) {
  const qs = new URLSearchParams()
  if (manufacturerId) qs.set('manufacturer_id', manufacturerId)
  const url = qs.toString() ? `/api/scaffold/systems?${qs.toString()}` : '/api/scaffold/systems'
  return useQuery<{ systems: ScaffoldSystem[] }>({
    queryKey: ['scaffold-systems', manufacturerId ?? 'all'],
    queryFn: () => request<{ systems: ScaffoldSystem[] }>(url),
  })
}
export function useCatalogParts(params: { systemId?: string; manufacturerId?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.systemId) qs.set('system_id', params.systemId)
  if (params.manufacturerId) qs.set('manufacturer_id', params.manufacturerId)
  const url = qs.toString() ? `/api/scaffold/catalog-parts?${qs.toString()}` : '/api/scaffold/catalog-parts'
  return useQuery<{ catalogParts: CatalogPart[] }>({
    queryKey: ['catalog-parts', params.systemId ?? '', params.manufacturerId ?? ''],
    queryFn: () => request<{ catalogParts: CatalogPart[] }>(url),
  })
}
export function useImportCatalogParts() {
  const qc = useQueryClient()
  return useMutation<{ inserted: number; updated: number }, Error, { rows: Array<Record<string, unknown>> }>({
    mutationFn: (input) =>
      request<{ inserted: number; updated: number }>('/api/scaffold/catalog-parts/import', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog-parts'] }),
  })
}

// ---- BOMs --------------------------------------------------------------------

export function useProjectBoms(projectId: string) {
  return useQuery<{ boms: Bom[] }>({
    queryKey: ['project', projectId, 'boms'],
    enabled: !!projectId,
    queryFn: () => request<{ boms: Bom[] }>(`/api/projects/${encodeURIComponent(projectId)}/boms`),
  })
}
export function useCreateBom(projectId: string) {
  const qc = useQueryClient()
  return useMutation<Bom, Error, { name: string; source?: string; source_ref?: string; notes?: string }>({
    mutationFn: (input) =>
      request<Bom>(`/api/projects/${encodeURIComponent(projectId)}/boms`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId, 'boms'] }),
  })
}
export function useBom(bomId: string) {
  return useQuery<BomDetail>({
    queryKey: ['bom', bomId],
    enabled: !!bomId,
    queryFn: () => request<BomDetail>(`/api/boms/${encodeURIComponent(bomId)}`),
  })
}
export function useAppendBomLines(bomId: string) {
  const qc = useQueryClient()
  return useMutation<
    { lines: BomLine[] },
    Error,
    { lines: Array<{ catalog_part_id: string; quantity: number; notes?: string }> }
  >({
    mutationFn: (input) =>
      request<{ lines: BomLine[] }>(`/api/boms/${encodeURIComponent(bomId)}/lines`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bom', bomId] }),
  })
}
export function useApproveBom(bomId: string) {
  const qc = useQueryClient()
  return useMutation<Bom, Error, void>({
    mutationFn: () => request<Bom>(`/api/boms/${encodeURIComponent(bomId)}/approve`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bom', bomId] })
      qc.invalidateQueries({ queryKey: ['project'] })
    },
  })
}

export interface ScaffoldDesignBomResult {
  bom: Bom
  lines: Array<{ id: string; catalog_part_id: string; quantity: string }>
  unresolved: Array<{ role: string; lengthMm: number; quantity: number }>
  model_summary: {
    members: number
    bounds: { lengthMm: number; widthMm: number; heightMm: number }
    warnings: string[]
  }
}

export interface ScaffoldDesignBomInput {
  name?: string
  scaffold_system_id?: string | null
  spec: Record<string, unknown>
}

/** Generate + persist a draft BOM from a scaffold design spec for a project. */
export function useCreateScaffoldDesignBom(projectId: string) {
  const qc = useQueryClient()
  return useMutation<ScaffoldDesignBomResult, Error, ScaffoldDesignBomInput>({
    mutationFn: (input) =>
      request<ScaffoldDesignBomResult>(`/api/projects/${encodeURIComponent(projectId)}/scaffold-designs/bom`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-boms', projectId] }),
  })
}

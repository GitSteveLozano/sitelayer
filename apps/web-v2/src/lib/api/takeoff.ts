// Phase 3 takeoff resource layer — tags, pages, assemblies, import,
// QBO custom-field mappings. The full polygon-canvas UI lives in v1
// for now; v2 ships the data layer + non-canvas surfaces (tag table,
// page nav, calibration form, assembly editor, CSV importer, custom
// field settings).

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

// ---------------------------------------------------------------------------
// Multi-condition tags (3A)
// ---------------------------------------------------------------------------

export interface TakeoffTag {
  id: string
  measurement_id: string
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  notes: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

const tagKey = (measurementId: string) => ['takeoff', 'tags', measurementId] as const

export function useTakeoffTags(measurementId: string | null | undefined) {
  return useQuery<{ tags: TakeoffTag[] }>({
    queryKey: tagKey(measurementId ?? ''),
    queryFn: () => request(`/api/takeoff/measurements/${encodeURIComponent(measurementId!)}/tags`),
    enabled: Boolean(measurementId),
  })
}

export function useAddTakeoffTag(measurementId: string) {
  const qc = useQueryClient()
  return useMutation<{ tag: TakeoffTag }, Error, { service_item_code: string; quantity: number; unit?: string; rate?: number; notes?: string }>({
    mutationFn: (input) => request(`/api/takeoff/measurements/${encodeURIComponent(measurementId)}/tags`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tagKey(measurementId) }),
  })
}

export function useRemoveTakeoffTag(measurementId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, string>({
    mutationFn: (tagId) => request(`/api/takeoff/tags/${encodeURIComponent(tagId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tagKey(measurementId) }),
  })
}

// ---------------------------------------------------------------------------
// Blueprint pages + calibration (3B/C)
// ---------------------------------------------------------------------------

export interface BlueprintPage {
  id: string
  blueprint_document_id: string
  page_number: number
  storage_path: string | null
  calibration_world_distance: string | null
  calibration_world_unit: string | null
  calibration_x1: string | null
  calibration_y1: string | null
  calibration_x2: string | null
  calibration_y2: string | null
  calibration_set_at: string | null
  measurement_count: number
}

const pagesKey = (docId: string) => ['blueprints', 'pages', docId] as const

export function useBlueprintPages(docId: string | null | undefined) {
  return useQuery<{ pages: BlueprintPage[] }>({
    queryKey: pagesKey(docId ?? ''),
    queryFn: () => request(`/api/blueprints/${encodeURIComponent(docId!)}/pages`),
    enabled: Boolean(docId),
  })
}

export function useCalibratePage() {
  const qc = useQueryClient()
  return useMutation<
    { page: BlueprintPage },
    Error,
    { pageId: string; world_distance: number; world_unit: string; x1: number; y1: number; x2: number; y2: number }
  >({
    mutationFn: ({ pageId, ...input }) =>
      request(`/api/blueprint-pages/${encodeURIComponent(pageId)}/calibrate`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprints'] }),
  })
}

// ---------------------------------------------------------------------------
// Assemblies (3F)
// ---------------------------------------------------------------------------

export interface Assembly {
  id: string
  service_item_code: string
  name: string
  description: string | null
  total_rate: string
  unit: string
  version: number
  created_at: string
  updated_at: string
}

export interface AssemblyComponent {
  id: string
  assembly_id: string
  kind: 'material' | 'labor' | 'sub' | 'freight'
  name: string
  quantity_per_unit: string
  unit: string
  unit_cost: string
  waste_pct: string
  sort_order: number
}

const assemblyListKey = ['assemblies', 'list'] as const
const assemblyDetailKey = (id: string) => ['assemblies', 'detail', id] as const

export function useAssemblies(serviceItemCode?: string) {
  const qs = serviceItemCode ? `?service_item_code=${encodeURIComponent(serviceItemCode)}` : ''
  return useQuery<{ assemblies: Assembly[] }>({
    queryKey: [...assemblyListKey, serviceItemCode ?? ''],
    queryFn: () => request(`/api/assemblies${qs}`),
  })
}

export function useAssembly(id: string | null | undefined) {
  return useQuery<{ assembly: Assembly; components: AssemblyComponent[] }>({
    queryKey: assemblyDetailKey(id ?? ''),
    queryFn: () => request(`/api/assemblies/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  })
}

export function useCreateAssembly() {
  const qc = useQueryClient()
  return useMutation<
    { assembly: Assembly; components: AssemblyComponent[] },
    Error,
    { service_item_code: string; name: string; description?: string; unit?: string }
  >({
    mutationFn: (input) => request('/api/assemblies', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

export function useAddAssemblyComponent(assemblyId: string) {
  const qc = useQueryClient()
  return useMutation<
    { component: AssemblyComponent },
    Error,
    { kind: 'material' | 'labor' | 'sub' | 'freight'; name: string; quantity_per_unit: number; unit: string; unit_cost: number; waste_pct?: number }
  >({
    mutationFn: (input) =>
      request(`/api/assemblies/${encodeURIComponent(assemblyId)}/components`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

// ---------------------------------------------------------------------------
// CSV import (3G)
// ---------------------------------------------------------------------------

export interface ImportRow {
  service_item_code: string
  quantity: number
  unit?: string
  rate?: number
  notes?: string
}

export function useImportTakeoff(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    { imported: number; source_label: string },
    Error,
    { rows: ImportRow[]; source_label?: string; page_id?: string }
  >({
    mutationFn: (input) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/takeoff/import`, { method: 'POST', json: input }),
    onSuccess: () => {
      // Imports add takeoff measurements (tags + measurements) and may
      // bump per-page measurement_count via DB trigger, so the
      // blueprints/pages cache also goes stale.
      qc.invalidateQueries({ queryKey: ['takeoff'] })
      qc.invalidateQueries({ queryKey: ['blueprints'] })
    },
  })
}

// ---------------------------------------------------------------------------
// QBO custom field mappings (3H)
// ---------------------------------------------------------------------------

export interface QboCustomFieldMapping {
  id: string
  entity_type: string
  field_name: string
  qbo_definition_id: string
  qbo_label: string | null
}

export function useQboCustomFields() {
  return useQuery<{ mappings: QboCustomFieldMapping[] }>({
    queryKey: ['qbo', 'custom-fields'],
    queryFn: () => request('/api/qbo/custom-fields'),
  })
}

export function useUpsertQboCustomField() {
  const qc = useQueryClient()
  return useMutation<
    { mapping: QboCustomFieldMapping },
    Error,
    { entity_type: 'Estimate' | 'Invoice' | 'Bill' | 'PurchaseOrder'; field_name: string; qbo_definition_id: string; qbo_label?: string; notes?: string }
  >({
    mutationFn: (input) => request('/api/qbo/custom-fields', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qbo', 'custom-fields'] }),
  })
}

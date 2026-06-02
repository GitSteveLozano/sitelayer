// Shared cost library resource hooks (Takeoff Deep Dive M5).
//
// Company-scoped + shared-catalog list/search, single-row create, and a
// CSV/.xlsx price-book import. This is purely additive: the pricing resolver
// consults the library only as the lowest-priority fallback (apps/api
// pricing.ts layer 6), so an empty library changes nothing.
//
// The row type is defined locally (mirroring service-items.ts) rather than in
// @sitelayer/domain to keep this slice additive and avoid a domain rebuild.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface CostLibraryItem {
  id: string
  /** NULL = shared/global catalog row; a uuid = the company's own imported row. */
  company_id: string | null
  trade: string
  code: string
  name: string | null
  unit: string
  /** numeric(12,4) as a string (or null). */
  material_rate: string | null
  labor_rate: string | null
  region: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface CostLibraryListResponse {
  items: CostLibraryItem[]
}

const COST_LIBRARY_KEY = ['cost-library'] as const

export interface CostLibraryListParams {
  q?: string
  trade?: string
  region?: string
}

function buildQuery(params: CostLibraryListParams | undefined): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.trade) sp.set('trade', params.trade)
  if (params.region) sp.set('region', params.region)
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** GET /api/cost-library — list/search the company's library plus shared catalog rows. */
export function useCostLibrary(params?: CostLibraryListParams) {
  return useQuery<CostLibraryListResponse>({
    queryKey: [...COST_LIBRARY_KEY, params ?? {}],
    queryFn: () => request(`/api/cost-library${buildQuery(params)}`),
    // The library is reference data that changes rarely during a session; a
    // 5-minute stale window matches the service-items / conditions hooks.
    staleTime: 5 * 60_000,
  })
}

export interface CreateCostLibraryItemInput {
  code: string
  trade?: string
  name?: string | null
  unit?: string
  material_rate?: number | null
  labor_rate?: number | null
  region?: string | null
  source?: string
}

/** POST /api/cost-library — create one library row. */
export function useCreateCostLibraryItem() {
  const qc = useQueryClient()
  return useMutation<{ item: CostLibraryItem }, Error, CreateCostLibraryItemInput>({
    mutationFn: (input) => request('/api/cost-library', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: COST_LIBRARY_KEY }),
  })
}

export interface ImportCostLibraryInput {
  format: 'csv' | 'xlsx'
  /** CSV text, or a base64-encoded .xlsx file. */
  content: string
  /** Optional default source label stamped on rows whose source column is blank. */
  source?: string
  /** Optional region applied to every imported row (per-book region tag). */
  region?: string
}

export interface ImportCostLibraryResponse {
  imported: number
  source: string
  items: CostLibraryItem[]
}

/** POST /api/cost-library/import — parse + upsert a CSV/.xlsx price book. */
export function useImportCostLibrary() {
  const qc = useQueryClient()
  return useMutation<ImportCostLibraryResponse, Error, ImportCostLibraryInput>({
    mutationFn: (input) => request('/api/cost-library/import', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: COST_LIBRARY_KEY }),
  })
}

/**
 * Read a File as a base64 string (without the data-URL prefix) so an .xlsx
 * upload can ride in the JSON import body. CSV files are read as text by the
 * caller instead.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('failed to read file'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

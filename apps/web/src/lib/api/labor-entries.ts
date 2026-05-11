// Labor entries — create + list hooks for the foreman manual time-entry
// surface. Wraps POST/GET /api/labor-entries in
// apps/api/src/routes/labor-entries.ts.
//
// The POST endpoint enforces role (admin / foreman / office) on the
// server and re-validates (service_item_code, division_code) against the
// `service_item_divisions` xref. We surface the server's 400 error body
// through ApiError so callers can render the curated-catalog message
// the API returns.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface LaborEntry {
  id: string
  project_id: string
  worker_id: string | null
  service_item_code: string
  hours: string
  sqft_done: string
  status: string
  occurred_on: string
  division_code: string | null
  created_at: string
}

export interface LaborEntryCreateRequest {
  project_id: string
  service_item_code: string
  hours: number
  occurred_on: string
  worker_id?: string | null
  sqft_done?: number | null
  division_code?: string | null
  status?: string
  expected_version?: number
}

const KEYS = {
  all: () => ['labor-entries'] as const,
  list: () => [...KEYS.all(), 'list'] as const,
}

export const laborEntryQueryKeys = KEYS

export function createLaborEntry(input: LaborEntryCreateRequest): Promise<LaborEntry> {
  return request<LaborEntry>('/api/labor-entries', { method: 'POST', json: input })
}

export function useCreateLaborEntry() {
  const qc = useQueryClient()
  return useMutation<LaborEntry, Error, LaborEntryCreateRequest>({
    mutationFn: (input) => createLaborEntry(input),
    onSuccess: () => {
      // Bootstrap + project summaries embed the labor roll-up, so kick
      // every related cache. Bootstrap query keys are slug-scoped so we
      // invalidate the family rather than guess the active slug here.
      void qc.invalidateQueries({ queryKey: KEYS.all() })
      void qc.invalidateQueries({ queryKey: ['bootstrap'] })
      void qc.invalidateQueries({ queryKey: ['projects', 'summary'] })
      void qc.invalidateQueries({ queryKey: ['time-review-runs'] })
    },
  })
}

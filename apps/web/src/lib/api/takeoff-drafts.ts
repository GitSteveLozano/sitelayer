// Multi-draft takeoff resource layer (Phase A.3 of MULTI_DRAFT_TAKEOFF_SPEC.md).
// Backed by the routes added in apps/api/src/routes/takeoff-drafts.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface TakeoffDraft {
  id: string
  company_id: string
  project_id: string
  name: string
  /** Free-text discriminator. 'measurement' today; 'scaffolding' reserved for the future scaffolding-design tool. */
  type: string
  status: 'active' | 'archived'
  version: number
  /** Phase C: pipeline that produced this draft. 'manual' for canvas-authored drafts. */
  source?: 'manual' | 'roomplan' | 'photogrammetry' | 'drone' | 'blueprint_vision'
  /** Phase C: pipeline-supplied review flag — true when any quantity scored below the confidence floor. */
  review_required?: boolean
  /** Phase C: semver of the producing pipeline. Null for manual drafts. */
  pipeline_version?: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type CaptureKind = 'roomplan' | 'photogrammetry' | 'drone' | 'blueprint_vision'

export interface CaptureRequestBody {
  kind: CaptureKind
  name?: string
  payload: Record<string, unknown>
}

export interface CaptureResultSummary {
  quantities_count: number
  review_required: boolean
  capture_source: string
  geometry: { rooms: number; surfaces: number; objects: number }
  pipeline_version: string
}

export interface CaptureResponse {
  draft: TakeoffDraft
  result_summary: CaptureResultSummary
}

const draftsByProjectKey = (projectId: string, includeArchived: boolean) =>
  ['takeoff-drafts', 'by-project', projectId, includeArchived ? 'all' : 'active'] as const

export function useTakeoffDrafts(projectId: string | null | undefined, options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? false
  return useQuery<{ drafts: TakeoffDraft[] }>({
    queryKey: draftsByProjectKey(projectId ?? '', includeArchived),
    queryFn: () => {
      const qs = includeArchived ? '?include_archived=1' : ''
      return request(`/api/projects/${encodeURIComponent(projectId!)}/takeoff-drafts${qs}`)
    },
    enabled: Boolean(projectId),
  })
}

export function useCreateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft }, Error, { name: string; type?: string }>({
    mutationFn: (input) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

export function useUpdateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    { draft: TakeoffDraft },
    Error,
    { id: string; name?: string; status?: 'active' | 'archived'; expected_version: number }
  >({
    mutationFn: ({ id, ...body }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

export function useDuplicateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft; measurement_count: number }, Error, { id: string; name?: string }>({
    mutationFn: ({ id, name }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        json: name ? { name } : {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
      // Newly duplicated draft contains its source's measurements; the
      // canvas keys its measurement query on draft_id, so invalidate
      // everything under 'takeoff' to be safe.
      qc.invalidateQueries({ queryKey: ['takeoff'] })
    },
  })
}

export function useDeleteTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft }, Error, { id: string }>({
    mutationFn: ({ id }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

/**
 * Phase C: run one of the four capture pipelines (roomplan /
 * photogrammetry / drone / blueprint_vision) against a JSON payload
 * and land the result as a new takeoff draft. The server validates
 * `kind`, dispatches to the matching @sitelayer/pipe-* package, and
 * stashes the TakeoffResult on the new draft.
 */
export function useCaptureTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CaptureResponse, Error, CaptureRequestBody>({
    mutationFn: (input) =>
      request<CaptureResponse>(`/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/capture`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
    },
  })
}

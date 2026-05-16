// QR scaffold tags + inspections.
// API surface lives in apps/api/src/routes/scaffold-tags.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export interface ScaffoldTag {
  id: string
  company_id: string
  project_id: string
  qr_token: string
  label: string
  structure_type: 'scaffold' | 'stair_tower' | 'hoist' | 'shoring' | 'other'
  erected_on: string | null
  dismantled_on: string | null
  height_m: string | null
  load_class: string | null
  last_inspection_id: string | null
  last_inspection_status: 'pass' | 'fail' | 'tagged_out' | null
  last_inspection_at: string | null
  status: 'active' | 'tagged_out' | 'dismantled'
  lat: string | null
  lng: string | null
  notes: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface ScaffoldInspection {
  id: string
  company_id: string
  tag_id: string
  project_id: string
  inspector_user_id: string
  inspector_name: string | null
  status: 'pass' | 'fail' | 'tagged_out'
  checklist: Array<{ key: string; label: string; ok: boolean; notes?: string }>
  photo_refs: string[]
  defects: string | null
  remediation: string | null
  signed_at: string
  next_due_on: string | null
  notes: string | null
  created_at: string
}

export function useScaffoldTags(projectId: string) {
  return useQuery<{ tags: ScaffoldTag[] }>({
    queryKey: ['project', projectId, 'scaffold-tags'],
    enabled: !!projectId,
    queryFn: () =>
      request<{ tags: ScaffoldTag[] }>(`/api/projects/${encodeURIComponent(projectId)}/scaffold-tags`),
  })
}

export function useCreateScaffoldTag(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    ScaffoldTag,
    Error,
    {
      label: string
      qr_token?: string
      structure_type?: ScaffoldTag['structure_type']
      erected_on?: string
      height_m?: number
      load_class?: string
      lat?: number
      lng?: number
      notes?: string
    }
  >({
    mutationFn: (input) =>
      request<ScaffoldTag>(`/api/projects/${encodeURIComponent(projectId)}/scaffold-tags`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId, 'scaffold-tags'] }),
  })
}

export function useTagByToken(token: string) {
  return useQuery<{ tag: ScaffoldTag; inspections: ScaffoldInspection[] }>({
    queryKey: ['scaffold-tag-by-token', token],
    enabled: !!token,
    queryFn: () =>
      request<{ tag: ScaffoldTag; inspections: ScaffoldInspection[] }>(
        `/api/scaffold-tags/by-token/${encodeURIComponent(token)}`,
      ),
  })
}

export function useCreateInspection(tagId: string) {
  const qc = useQueryClient()
  return useMutation<
    ScaffoldInspection,
    Error,
    {
      status: 'pass' | 'fail' | 'tagged_out'
      checklist?: Array<{ key: string; label: string; ok: boolean; notes?: string }>
      photo_refs?: string[]
      defects?: string
      remediation?: string
      inspector_name?: string
      next_due_on?: string
      notes?: string
    }
  >({
    mutationFn: (input) =>
      request<ScaffoldInspection>(`/api/scaffold-tags/${encodeURIComponent(tagId)}/inspections`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scaffold-tag-by-token'] })
      qc.invalidateQueries({ queryKey: ['project'] })
    },
  })
}

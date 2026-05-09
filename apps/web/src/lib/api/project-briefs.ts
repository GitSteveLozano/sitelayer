// Project briefs (`fm-brief` -> `wk-today` / `wk-scope`).
// Adds the create mutation + a typed step shape on top of the existing
// `useProjectBriefs` query in `lib/api/projects.ts`. The query side is
// intentionally untouched so we don't introduce a second key prefix.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

/**
 * Step entries embedded in the brief's `steps` jsonb array. The backend
 * stores them as opaque jsonb so the shape is whatever the foreman UI
 * sends. This is the shape `fm-brief` writes and `wk-scope` reads.
 */
export interface ProjectBriefStep {
  /** Stable id when persisted; client may pass a temp string when posting. */
  id?: string
  title: string
  duration_min?: number | null
  materials?: string | null
  notes?: string | null
}

/** Inline material/delivery entry; written by `fm-brief`'s materials list. */
export interface ProjectBriefMaterial {
  description: string
  quantity?: string | null
  vendor?: string | null
}

export interface ProjectBriefCreateRequest {
  effective_date: string
  goal: string
  steps?: ProjectBriefStep[]
  crew?: unknown[]
  materials?: ProjectBriefMaterial[]
}

export interface ProjectBriefCreateResponse {
  brief: {
    id: string
    company_id: string
    project_id: string
    foreman_user_id: string
    effective_date: string
    goal: string
    steps: unknown
    crew: unknown
    materials: unknown
    version: number
    created_at: string
    updated_at: string
  }
}

export function createProjectBrief(
  projectId: string,
  input: ProjectBriefCreateRequest,
): Promise<ProjectBriefCreateResponse> {
  return request<ProjectBriefCreateResponse>(`/api/projects/${encodeURIComponent(projectId)}/briefs`, {
    method: 'POST',
    json: input,
  })
}

export function useCreateProjectBrief(projectId: string) {
  const qc = useQueryClient()
  return useMutation<ProjectBriefCreateResponse, Error, ProjectBriefCreateRequest>({
    mutationFn: (input) => createProjectBrief(projectId, input),
    onSuccess: () => {
      // Invalidate the existing `useProjectBriefs` query key from
      // lib/api/projects.ts (`['projects', 'briefs', projectId, date]`).
      void qc.invalidateQueries({ queryKey: ['projects', 'briefs', projectId] })
    },
  })
}

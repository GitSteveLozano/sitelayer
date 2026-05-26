// Project-closeout workflow client — GET snapshot + POST CLOSEOUT for the
// `project_closeout` deterministic workflow (states: active → completed).
//
// Backend reducer lives in `packages/workflows/src/project-closeout.ts`;
// routes are the closeout branches of `apps/api/src/routes/projects.ts`:
//   - GET  /api/projects/:id/closeout — admin/office; returns a
//          WorkflowSnapshot { state, state_version, next_events, context }.
//   - POST /api/projects/:id/closeout — admin/office; applies CLOSEOUT.
//
// NOTE on the optimistic-concurrency key: unlike the canonical
// billing-run/estimate-push events endpoints (which POST `state_version`),
// the closeout POST gates on the project row's `version` column via
// `expected_version`. We read that from `context.version` on the snapshot
// and send it back. A stale version returns 409, which the UI handles by
// reloading the snapshot (the standard headless-workflow 409 → reload).
//
// On success the POST returns the updated project row (not a fresh
// WorkflowSnapshot), so the mutation just invalidates the snapshot query
// and lets the GET re-derive `state` / `next_events`.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { ProjectCloseoutHumanEventType, ProjectCloseoutWorkflowState } from '@sitelayer/workflows'
import { request } from './client'

// Re-exported under local names. Canonical unions live in
// @sitelayer/workflows so the reducer and the client agree.
export type ProjectCloseoutState = ProjectCloseoutWorkflowState
export type ProjectCloseoutHumanEvent = ProjectCloseoutHumanEventType

export interface ProjectCloseoutSnapshot {
  state: ProjectCloseoutState
  state_version: number
  next_events: Array<{ type: ProjectCloseoutHumanEvent; label: string; disabled_reason?: string }>
  context: {
    id: string
    company_id: string
    status: string
    closed_at: string | null
    closed_by: string | null
    summary_locked_at: string | null
    workflow_engine: string
    workflow_run_id: string | null
    version: number
    created_at: string
    updated_at: string
  }
}

const KEYS = {
  all: () => ['project-closeout'] as const,
  byProject: (projectId: string) => [...KEYS.all(), projectId] as const,
}

export const projectCloseoutQueryKeys = KEYS

export function fetchProjectCloseout(projectId: string): Promise<ProjectCloseoutSnapshot> {
  return request<ProjectCloseoutSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/closeout`)
}

/**
 * POST the CLOSEOUT event. `expectedVersion` is the project row's current
 * `version` (read from `snapshot.context.version`) — the server rejects a
 * stale value with 409. Returns void: the updated row is discarded and the
 * caller refetches the snapshot to render the new `completed` state.
 */
export function closeoutProject(projectId: string, expectedVersion: number): Promise<unknown> {
  return request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/closeout`, {
    method: 'POST',
    json: { expected_version: expectedVersion },
  })
}

export function useProjectCloseout(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectCloseoutSnapshot>>,
) {
  return useQuery<ProjectCloseoutSnapshot>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectCloseout(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

/**
 * Mutation that drives the CLOSEOUT transition. On success (and on any
 * settle, so a 409 reloads the authoritative state) it invalidates the
 * snapshot query; the GET then re-derives `state` + `next_events`.
 */
export function useCloseoutProject(projectId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { expectedVersion: number }>({
    mutationFn: ({ expectedVersion }) => closeoutProject(projectId, expectedVersion),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) })
      // The closeout-summary rollup locks at closeout — refresh it too.
      qc.invalidateQueries({ queryKey: ['closeout-summary', projectId] })
    },
  })
}

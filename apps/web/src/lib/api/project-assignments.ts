// Project assignments — who's allocated to which project.
//
// Wraps apps/api/src/routes/project-assignments.ts. The API is per-project:
//   GET    /api/projects/:projectId/assignments        -> list for one project
//   POST   /api/projects/:projectId/assignments        -> add (admin/office)
//   DELETE /api/projects/:projectId/assignments/:id     -> remove (admin/office)
//
// There is no company-wide "all assignments" endpoint, so the portfolio
// view (apps/web/src/screens/projects/assignments.tsx) fans out one list
// query per project via `useProjectAssignmentsForProjects` and groups the
// results client-side.
//
// Note: assignment rows identify the assignee by `clerk_user_id`. The
// `workers` roster in /api/bootstrap is keyed by worker `id` and does not
// expose a clerk mapping, so the UI shows the clerk user id as the
// identity until a join surface exists.

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { request } from './client'

export type ProjectAssignmentRole = 'foreman' | 'worker'

export interface ProjectAssignment {
  id: string
  project_id: string
  clerk_user_id: string
  role: ProjectAssignmentRole
  assigned_by_clerk_user_id: string | null
  created_at: string
  deleted_at: string | null
}

export interface ProjectAssignmentListResponse {
  assignments: ProjectAssignment[]
}

export interface CreateProjectAssignmentRequest {
  clerk_user_id: string
  role: ProjectAssignmentRole
}

export const projectAssignmentKeys = {
  all: () => ['project-assignments'] as const,
  list: (projectId: string) => [...projectAssignmentKeys.all(), 'list', projectId] as const,
}

export function fetchProjectAssignments(projectId: string): Promise<ProjectAssignmentListResponse> {
  return request<ProjectAssignmentListResponse>(`/api/projects/${encodeURIComponent(projectId)}/assignments`)
}

/**
 * One assignment list query per project id. `useQueries` keeps each
 * project's cache entry independent (so a single project's add/remove
 * invalidates just that key) while letting the screen aggregate the
 * results into a portfolio grouping. Pass the project ids the caller
 * already has (e.g. from bootstrap); an empty array yields no queries.
 */
export function useProjectAssignmentsForProjects(projectIds: readonly string[]) {
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: projectAssignmentKeys.list(projectId),
      queryFn: () => fetchProjectAssignments(projectId),
    })),
  })
}

/**
 * Add an assignment to a project. Admin/office only on the server — a
 * non-privileged caller gets a 403 the screen surfaces as an error.
 */
export function useAddProjectAssignment() {
  const queryClient = useQueryClient()
  return useMutation<ProjectAssignment, Error, { projectId: string; input: CreateProjectAssignmentRequest }>({
    mutationFn: ({ projectId, input }) =>
      request<ProjectAssignment>(`/api/projects/${encodeURIComponent(projectId)}/assignments`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: projectAssignmentKeys.list(projectId) })
    },
  })
}

/**
 * Soft-delete an assignment. Admin/office only on the server.
 */
export function useRemoveProjectAssignment() {
  const queryClient = useQueryClient()
  return useMutation<ProjectAssignment, Error, { projectId: string; assignmentId: string }>({
    mutationFn: ({ projectId, assignmentId }) =>
      request<ProjectAssignment>(
        `/api/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(assignmentId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: projectAssignmentKeys.list(projectId) })
    },
  })
}

// Project assignments — who's allocated to which project.
//
// Wraps apps/api/src/routes/project-assignments.ts:
//   GET    /api/assignments                             -> company-wide list (one query)
//   GET    /api/projects/:projectId/assignments         -> list for one project
//   POST   /api/projects/:projectId/assignments         -> add (admin/office)
//   DELETE /api/projects/:projectId/assignments/:id      -> remove (admin/office)
//
// The portfolio view (apps/web/src/screens/projects/assignments.tsx) uses the
// company-wide `useAllAssignments()` so it no longer fans out one request per
// project. `useProjectAssignmentsForProjects` is kept for any per-project
// caller / cache-keyed flows.
//
// Assignment rows identify the assignee by `clerk_user_id`. The API resolves
// that id against the global clerk_users mirror and returns `assignee_name` /
// `assignee_email` when known (both null when the identity hasn't been
// mirrored yet), so the UI shows a human name and falls back to the id.

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
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
  /** Resolved from the clerk_users mirror; null when the id isn't mapped. */
  assignee_name: string | null
  /** Resolved from the clerk_users mirror; null when the id isn't mapped. */
  assignee_email: string | null
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
  company: () => [...projectAssignmentKeys.all(), 'company'] as const,
}

export function fetchProjectAssignments(projectId: string): Promise<ProjectAssignmentListResponse> {
  return request<ProjectAssignmentListResponse>(`/api/projects/${encodeURIComponent(projectId)}/assignments`)
}

export function fetchAllAssignments(): Promise<ProjectAssignmentListResponse> {
  return request<ProjectAssignmentListResponse>('/api/assignments')
}

/**
 * Company-wide assignments in a single request (every project's roster). This
 * is the portfolio "Assignments" screen's primary read — it replaces the
 * per-project fan-out that previously issued one query per project (N+1).
 */
export function useAllAssignments() {
  return useQuery({
    queryKey: projectAssignmentKeys.company(),
    queryFn: fetchAllAssignments,
  })
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

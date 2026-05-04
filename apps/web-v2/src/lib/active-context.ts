/**
 * Active mobile shell context.
 *
 * The role-aware shell does not present a manual toggle. The active context
 * is computed from a small set of inputs:
 *   - the caller's company role (admin always wins)
 *   - the caller's project assignments
 *   - which project they're currently looking at (route param or selection)
 *   - optional geofence/recent-activity hints
 *
 * Resolution order (first match wins):
 *   1. Company admin → 'admin' shell. Always.
 *   2. The caller is in a foreman assignment for the current project → 'foreman'
 *   3. The caller is in a worker assignment for the current project → 'worker'
 *   4. The caller has any active foreman assignment → 'foreman' (their default home)
 *   5. The caller has any active worker assignment → 'worker'
 *   6. Fallback → 'admin' (company-level role member without assignments;
 *      they see a stripped-down admin home that politely says "no projects
 *      assigned to you yet").
 *
 * This is a pure function — no I/O, no React. Bootstrap response shape
 * lives in api.ts.
 */
import type { ProjectAssignmentRow } from '../api-v1-compat.js'

export type CompanyRole = 'admin' | 'foreman' | 'office' | 'member'
export type ProjectRole = 'admin' | 'foreman' | 'worker'

export type ActiveContext = {
  kind: ProjectRole
  /**
   * The project this context is scoped to, if any. Admin shell typically
   * has no projectId (portfolio view); foreman/worker shell always carries
   * the project they're acting within.
   */
  projectId: string | null
}

export type ComputeActiveContextArgs = {
  companyRole: CompanyRole
  assignments: readonly Pick<ProjectAssignmentRow, 'project_id' | 'role'>[]
  /**
   * The project the user has navigated to or is geofenced into. When null,
   * we fall back to the user's "default home" context.
   */
  currentProjectId?: string | null
}

/**
 * Coerce an arbitrary string from /api/session into the CompanyRole union.
 * Unknown values fall through to 'member'. 'office' is preserved here
 * (computeActiveContext aliases it to admin) so call sites that branch on
 * the raw role still see what came off the wire.
 */
export function normalizeMobileShellRole(value: string | null | undefined): CompanyRole {
  if (value === 'admin' || value === 'foreman' || value === 'office' || value === 'member') {
    return value
  }
  return 'member'
}

export function computeActiveContext({
  companyRole,
  assignments,
  currentProjectId,
}: ComputeActiveContextArgs): ActiveContext {
  // Office collapses into admin (matches normalizeCompanyRole on the server).
  if (companyRole === 'admin' || companyRole === 'office') {
    return { kind: 'admin', projectId: currentProjectId ?? null }
  }

  if (currentProjectId) {
    const here = assignments.filter((a) => a.project_id === currentProjectId)
    if (here.some((a) => a.role === 'foreman')) {
      return { kind: 'foreman', projectId: currentProjectId }
    }
    if (here.some((a) => a.role === 'worker')) {
      return { kind: 'worker', projectId: currentProjectId }
    }
  }

  // No current-project context — pick the user's default shell from their
  // assignment portfolio. Foreman wins over worker since foremen typically
  // need the wider triage surface to manage their crew.
  const hasForemanAssignment = assignments.some((a) => a.role === 'foreman')
  if (hasForemanAssignment) {
    return { kind: 'foreman', projectId: null }
  }
  const hasWorkerAssignment = assignments.some((a) => a.role === 'worker')
  if (hasWorkerAssignment) {
    return { kind: 'worker', projectId: null }
  }

  // Member with no assignments — render the admin shell scaffold; the home
  // screen handles the empty-list copy.
  return { kind: 'admin', projectId: null }
}

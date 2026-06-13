/**
 * Active mobile shell context.
 *
 * The role-aware shell is admin-first, with an optional mode override for
 * users who carry multiple roles. The active context is computed from:
 *   - the caller's company role
 *   - the caller's project assignments
 *   - which project they're currently looking at (route param or selection)
 *   - an optional user-selected role mode
 *
 * Resolution order (first match wins):
 *   1. Valid explicit mode override -> that shell.
 *   2. Company admin / office -> 'admin' shell by default.
 *   3. Company bookkeeper -> 'bookkeeper' shell (finance/payroll surface;
 *      a bookkeeper never clocks in and never carries a project context).
 *   4. The caller is in a foreman assignment for the current project -> 'foreman'
 *   5. The caller is in a worker assignment for the current project -> 'worker'
 *   6. The caller has any active foreman assignment -> 'foreman' (their default home)
 *   7. The caller has any active worker assignment -> 'worker'
 *   8. Fallback -> 'worker' (company-level member without assignments;
 *      field users should never see the admin shell by accident).
 *
 * This is a pure function -- no I/O, no React. Bootstrap response shape
 * lives in api.ts.
 */
import type { ProjectAssignmentRow } from '@/lib/api'
import type { CompanyRole, ProjectRole } from '@sitelayer/domain'

export type { CompanyRole, ProjectRole } from '@sitelayer/domain'
export type RoleMode = ProjectRole

/**
 * The mobile shell's active context kind. This is the project-role union
 * (`admin | foreman | worker`) PLUS the company-only `bookkeeper` persona,
 * which has no project scope and never appears as a `RoleMode` (it is not
 * a hat you toggle into — it's the company role itself resolving to the
 * finance/payroll shell).
 */
export type ContextKind = ProjectRole | 'bookkeeper'

export type ActiveContext = {
  kind: ContextKind
  /**
   * The project this context is scoped to, if any. Admin shell typically
   * has no projectId (portfolio view); foreman/worker shell always carries
   * the project they're acting within. The bookkeeper shell is always
   * portfolio-wide (no project scope).
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
  modeOverride?: RoleMode | null
}

/**
 * Coerce an arbitrary string from /api/session into the CompanyRole union.
 * Unknown values fall through to 'member'. 'office' is preserved here
 * (computeActiveContext aliases it to admin) so call sites that branch on
 * the raw role still see what came off the wire -- distinct from the
 * server-side `normalizeCompanyRole` in @sitelayer/domain which collapses
 * 'office' to 'admin' at the auth boundary.
 */
export function normalizeMobileShellRole(value: string | null | undefined): CompanyRole {
  if (value === 'admin' || value === 'foreman' || value === 'office' || value === 'member' || value === 'bookkeeper') {
    return value
  }
  return 'member'
}

export function normalizeRoleMode(value: string | null | undefined): RoleMode | null {
  if (value === 'admin' || value === 'foreman' || value === 'worker') {
    return value
  }
  return null
}

export function availableRoleModes({
  companyRole,
  assignments,
}: Pick<ComputeActiveContextArgs, 'companyRole' | 'assignments'>): RoleMode[] {
  const modes: RoleMode[] = []
  const hasAdmin = companyRole === 'admin' || companyRole === 'office'
  const hasForeman = companyRole === 'foreman' || assignments.some((a) => a.role === 'foreman')
  const hasWorker = assignments.some((a) => a.role === 'worker')

  if (hasAdmin) modes.push('admin')
  if (hasForeman) modes.push('foreman')
  if (hasWorker) modes.push('worker')

  // Plain members without project assignment still belong in the field app.
  return modes.length > 0 ? modes : ['worker']
}

export function computeActiveContext({
  companyRole,
  assignments,
  currentProjectId,
  modeOverride,
}: ComputeActiveContextArgs): ActiveContext {
  const modes = availableRoleModes({ companyRole, assignments })
  if (modeOverride && modes.includes(modeOverride)) {
    return { kind: modeOverride, projectId: modeOverride === 'admin' ? (currentProjectId ?? null) : null }
  }

  // Office collapses into admin (matches normalizeCompanyRole on the server).
  if (companyRole === 'admin' || companyRole === 'office') {
    return { kind: 'admin', projectId: currentProjectId ?? null }
  }

  // Bookkeeper resolves to the finance/payroll shell. It is a company role,
  // not a project-level role mode, so it is never overridable and never
  // carries a project context — a bookkeeper reviews money portfolio-wide
  // and does not clock in. Resolved here, BEFORE the project/foreman/worker
  // fallbacks, so a bookkeeper with a stray assignment still lands in
  // finance rather than the field/clock-in shell.
  if (companyRole === 'bookkeeper') {
    return { kind: 'bookkeeper', projectId: null }
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

  // No current-project context -- pick the user's default shell from their
  // assignment portfolio. Foreman wins over worker since foremen typically
  // need the wider triage surface to manage their crew.
  const hasForemanAssignment = assignments.some((a) => a.role === 'foreman')
  if (hasForemanAssignment) {
    return { kind: 'foreman', projectId: null }
  }
  if (companyRole === 'foreman') {
    return { kind: 'foreman', projectId: null }
  }
  const hasWorkerAssignment = assignments.some((a) => a.role === 'worker')
  if (hasWorkerAssignment) {
    return { kind: 'worker', projectId: null }
  }

  // Member with no assignments stays in the field shell. Admin belongs to
  // explicit admin/office permissions only.
  return { kind: 'worker', projectId: null }
}

import type { Pool } from 'pg'
import type { CompanyRole, ProjectRole } from './auth-types.js'

/**
 * Compute the caller's effective role within a single project. Used by
 * the role-aware shell (web) and by handlers that gate per-project access
 * tighter than company-level role allows (e.g., a foreman-on-Hillcrest
 * shouldn't see Aspen-Ridge field events).
 *
 * Resolution rules:
 *   1. Company admin always wins, regardless of assignments.
 *   2. Otherwise, an active row in `project_assignments` with role=foreman
 *      promotes the caller to foreman scope on this project.
 *   3. Otherwise, an active row with role=worker.
 *   4. Otherwise null — the caller has no contextual role on this project
 *      (they may still see the project at company scope as a foreman of
 *      another project, but they get no project-specific elevation here).
 */
export async function getProjectRole(
  pool: Pool,
  args: {
    clerkUserId: string
    projectId: string
    companyRole: CompanyRole
  },
): Promise<ProjectRole | null> {
  if (args.companyRole === 'admin') return 'admin'
  const result = await pool.query<{ role: string }>(
    `select role from project_assignments
       where project_id = $1
         and clerk_user_id = $2
         and deleted_at is null`,
    [args.projectId, args.clerkUserId],
  )
  if (result.rows.some((r) => r.role === 'foreman')) return 'foreman'
  if (result.rows.some((r) => r.role === 'worker')) return 'worker'
  return null
}

export type ProjectAssignmentRow = {
  id: string
  project_id: string
  clerk_user_id: string
  role: 'foreman' | 'worker'
  assigned_by_clerk_user_id: string | null
  created_at: string
  deleted_at: string | null
}

/**
 * List the caller's own active project assignments across a single company.
 * Used by /api/bootstrap to seed the contextual-shell selector on session
 * resume.
 */
export async function listAssignmentsForUser(
  pool: Pool,
  args: { companyId: string; clerkUserId: string },
): Promise<ProjectAssignmentRow[]> {
  const result = await pool.query<ProjectAssignmentRow>(
    `select id, project_id, clerk_user_id, role, assigned_by_clerk_user_id, created_at, deleted_at
       from project_assignments
       where company_id = $1
         and clerk_user_id = $2
         and deleted_at is null
       order by created_at asc`,
    [args.companyId, args.clerkUserId],
  )
  return result.rows
}

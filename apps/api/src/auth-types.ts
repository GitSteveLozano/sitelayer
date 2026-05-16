/**
 * Shared identity/RBAC types used by route modules and server.ts. Lives in
 * its own module so route extractions don't have to circular-import
 * server.ts.
 */
export type CompanyRole = 'admin' | 'foreman' | 'office' | 'member' | 'bookkeeper'

export const COMPANY_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']

// 'office' is retained in the union (and in `requireRole(['admin', 'office'])`
// allow-lists across the route modules) but normalizes to 'admin' on read —
// the design handoff collapses the office role into admin. No schema migration:
// company_memberships.role is a free-text column and the union stays compatible.
export function normalizeCompanyRole(value: unknown): CompanyRole {
  if (value === 'office') return 'admin'
  if (typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value)) {
    return value as CompanyRole
  }
  return 'member'
}

/**
 * The role the caller carries within the scope of a single project. Distinct
 * from `CompanyRole` because the same user can be admin-of-the-company and
 * worker-on-this-project simultaneously, and the contextual shell needs the
 * project-specific answer.
 */
export type ProjectRole = 'admin' | 'foreman' | 'worker'

export type ActiveCompany = {
  id: string
  slug: string
  name: string
  created_at: string
  role: CompanyRole
}

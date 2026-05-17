/**
 * Shared identity/RBAC types. Same union used by `apps/api/src/auth-types.ts`
 * (server-side membership resolution) and `apps/web/src/lib/active-context.ts`
 * (client-side role-mode picking). Lives in domain so both tiers agree on
 * what's a valid role and how 'office' collapses to 'admin' on read.
 */

export type CompanyRole = 'admin' | 'foreman' | 'office' | 'member' | 'bookkeeper'

export const COMPANY_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']

/**
 * Coerce an arbitrary wire value into the CompanyRole union. 'office' is
 * retained in the union (and in `requireRole(['admin', 'office'])`
 * allow-lists across the route modules) but normalizes to 'admin' on read
 * — the design handoff collapses the office role into admin. No schema
 * migration: company_memberships.role is a free-text column and the union
 * stays compatible.
 */
export function normalizeCompanyRole(value: unknown): CompanyRole {
  if (value === 'office') return 'admin'
  if (typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value)) {
    return value as CompanyRole
  }
  return 'member'
}

/**
 * The role the caller carries within the scope of a single project.
 * Distinct from `CompanyRole` because the same user can be
 * admin-of-the-company and worker-on-this-project simultaneously, and the
 * contextual shell needs the project-specific answer.
 */
export type ProjectRole = 'admin' | 'foreman' | 'worker'

export type ActiveCompany = {
  id: string
  slug: string
  name: string
  created_at: string
  role: CompanyRole
}

/**
 * Entity types tracked in `integration_mappings` (QBO local_ref → external_id
 * pairs). Hardcoded as string literals in many places across the API; importing
 * from here keeps the union narrow and grep-able.
 */
export type IntegrationEntityType =
  | 'customer'
  | 'service_item'
  | 'division'
  | 'project'
  | 'material_bill'
  | 'qbo_vendor'
  | 'qbo_account'

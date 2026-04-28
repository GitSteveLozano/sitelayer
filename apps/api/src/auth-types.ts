/**
 * Shared identity/RBAC types used by route modules and server.ts. Lives in
 * its own module so route extractions don't have to circular-import
 * server.ts.
 */
export type CompanyRole = 'admin' | 'foreman' | 'office' | 'member'

export const COMPANY_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member']

export function normalizeCompanyRole(value: unknown): CompanyRole {
  if (typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value)) {
    return value as CompanyRole
  }
  return 'member'
}

export type ActiveCompany = {
  id: string
  slug: string
  name: string
  created_at: string
  role: CompanyRole
}

/**
 * Shared identity/RBAC types used by route modules and server.ts. Lives in
 * its own module so route extractions don't have to circular-import
 * server.ts.
 *
 * Canonical definitions live in `@sitelayer/domain` so the web tier can
 * import the same union and normalization rule.
 */
export {
  COMPANY_ROLES,
  normalizeCompanyRole,
  type ActiveCompany,
  type CompanyRole,
  type ProjectRole,
} from '@sitelayer/domain'

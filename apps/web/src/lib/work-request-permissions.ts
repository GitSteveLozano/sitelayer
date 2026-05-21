import type { CompanyRole } from '@sitelayer/domain'

const TRIAGE_ROLES = new Set<CompanyRole>(['admin', 'foreman', 'office', 'bookkeeper'])
const CREATE_ROLES = new Set<CompanyRole>(['admin', 'foreman', 'office', 'member', 'bookkeeper'])

export function canCreateWorkRequests(role: CompanyRole): boolean {
  return CREATE_ROLES.has(role)
}

export function canTriageWorkRequests(role: CompanyRole): boolean {
  return TRIAGE_ROLES.has(role)
}

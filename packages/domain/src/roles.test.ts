import { describe, expect, it } from 'vitest'
import { COMPANY_ROLES, normalizeCompanyRole, type CompanyRole } from './roles.js'

describe('COMPANY_ROLES', () => {
  it('contains the five canonical role identifiers', () => {
    expect(COMPANY_ROLES).toHaveLength(5)
    expect([...COMPANY_ROLES].sort()).toEqual(['admin', 'bookkeeper', 'foreman', 'member', 'office'])
  })
})

describe('normalizeCompanyRole', () => {
  it('returns each canonical role as-is, except office which collapses to admin', () => {
    const expectations: Array<[CompanyRole, CompanyRole]> = [
      ['admin', 'admin'],
      ['foreman', 'foreman'],
      ['office', 'admin'],
      ['member', 'member'],
      ['bookkeeper', 'bookkeeper'],
    ]
    for (const [input, expected] of expectations) {
      expect(normalizeCompanyRole(input)).toBe(expected)
    }
  })

  it('falls back to member for unknown role strings', () => {
    expect(normalizeCompanyRole('superuser')).toBe('member')
    expect(normalizeCompanyRole('')).toBe('member')
    expect(normalizeCompanyRole('Admin')).toBe('member') // case-sensitive
    expect(normalizeCompanyRole('ADMIN')).toBe('member')
  })

  it('falls back to member for non-string inputs', () => {
    expect(normalizeCompanyRole(null)).toBe('member')
    expect(normalizeCompanyRole(undefined)).toBe('member')
    expect(normalizeCompanyRole(42)).toBe('member')
    expect(normalizeCompanyRole({ role: 'admin' })).toBe('member')
    expect(normalizeCompanyRole(['admin'])).toBe('member')
    expect(normalizeCompanyRole(true)).toBe('member')
  })
})

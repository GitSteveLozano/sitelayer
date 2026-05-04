import { describe, expect, it } from 'vitest'
import { normalizeCompanyRole } from './auth-types.js'

describe('normalizeCompanyRole', () => {
  it('passes through admin/foreman/member', () => {
    expect(normalizeCompanyRole('admin')).toBe('admin')
    expect(normalizeCompanyRole('foreman')).toBe('foreman')
    expect(normalizeCompanyRole('member')).toBe('member')
  })

  it('aliases legacy office to admin', () => {
    // Per the design handoff, the office role collapses into admin. Legacy
    // rows (if any) and any literal 'office' read off the wire should be
    // treated as admin so the contextual shell never tries to render an
    // office-only surface.
    expect(normalizeCompanyRole('office')).toBe('admin')
  })

  it('falls back to member for unknown values', () => {
    expect(normalizeCompanyRole('owner')).toBe('member')
    expect(normalizeCompanyRole(null)).toBe('member')
    expect(normalizeCompanyRole(undefined)).toBe('member')
    expect(normalizeCompanyRole(42)).toBe('member')
  })
})

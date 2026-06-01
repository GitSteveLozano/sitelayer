import { describe, expect, it } from 'vitest'
import { COMPANY_ROLES, normalizeCompanyRole, type CompanyRole } from '@sitelayer/domain'
import {
  normalizeGrantConstraints,
  permissionDecision,
  resolveCompanyRoleAuthority,
} from './permission-seam.js'

// ---------------------------------------------------------------------------
// LAYER 1 seam + LAYER 2 overlay resolution. Pure logic — no DB, no HTTP. These
// pin (a) the round-trip-identity invariant that makes every plain member
// behaviour-unchanged at the ~260 requireRole sites, (b) the custom-role base
// gating, and (c) the requirePermission verdict (granted / denied / over_cap).
// ---------------------------------------------------------------------------

describe('resolveCompanyRoleAuthority — LAYER 1 plain-member round trip', () => {
  // The seam sets active.role = effectiveRole. For a plain member it MUST equal
  // normalizeCompanyRole(raw) exactly, or ~260 requireRole sites change
  // behaviour. office→admin is preserved (the estimator demotion is LAYER 2).
  const rawRoles: CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']

  for (const raw of rawRoles) {
    it(`role ${raw}: effectiveRole === normalizeCompanyRole(raw), no grants`, () => {
      const normalized = normalizeCompanyRole(raw)
      const out = resolveCompanyRoleAuthority(normalized, null)
      expect(out.effectiveRole).toBe(normalized)
      expect(out.grants).toEqual([])
    })
  }

  it('every CompanyRole in the union round-trips to itself', () => {
    for (const raw of COMPANY_ROLES) {
      const normalized = normalizeCompanyRole(raw)
      expect(resolveCompanyRoleAuthority(normalized, null).effectiveRole).toBe(normalized)
    }
  })

  it('plain office collapses to admin at LAYER 1 (demotion is LAYER 2 only)', () => {
    const out = resolveCompanyRoleAuthority(normalizeCompanyRole('office'), null)
    // normalizeCompanyRole('office') === 'admin', so the effective long-tail
    // role stays admin — office keeps its tail access; the matrix demotes it to
    // estimator only at the named-action overlay.
    expect(out.effectiveRole).toBe('admin')
    expect(out.effectiveBuiltin).toBe('owner')
  })
})

describe('resolveCompanyRoleAuthority — custom-role member', () => {
  it('gates the long tail as builtinToCompanyRole(inherit_from)', () => {
    // A custom role inheriting estimator: the long-tail role becomes office,
    // and the named-action base is estimator with the role grants attached.
    const out = resolveCompanyRoleAuthority(normalizeCompanyRole('member'), {
      effectiveBuiltin: 'estimator',
      grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }],
    })
    expect(out.effectiveRole).toBe('office')
    expect(out.effectiveBuiltin).toBe('estimator')
    expect(out.grants).toHaveLength(1)
  })

  it('a foreman-based custom role gates the tail as foreman', () => {
    const out = resolveCompanyRoleAuthority(normalizeCompanyRole('member'), {
      effectiveBuiltin: 'foreman',
      grants: [],
    })
    expect(out.effectiveRole).toBe('foreman')
    expect(out.effectiveBuiltin).toBe('foreman')
  })
})

describe('permissionDecision — LAYER 2 named-action overlay', () => {
  it('owner holds all 9 actions', () => {
    expect(permissionDecision('owner', [], 'auth_materials').outcome).toBe('allowed')
    expect(permissionDecision('owner', [], 'edit_pricing_book').outcome).toBe('allowed')
    expect(permissionDecision('owner', [], 'stop_work').outcome).toBe('allowed')
  })

  it('foreman does NOT hold edit_pricing_book (matrix-as-designed delta)', () => {
    expect(permissionDecision('foreman', [], 'edit_pricing_book').outcome).toBe('denied')
    // but foreman holds approve_time + brief_crew per the matrix
    expect(permissionDecision('foreman', [], 'approve_time').outcome).toBe('allowed')
    expect(permissionDecision('foreman', [], 'brief_crew').outcome).toBe('allowed')
  })

  it('auth_materials is Owner-only by default — estimator denied', () => {
    expect(permissionDecision('estimator', [], 'auth_materials').outcome).toBe('denied')
  })

  it('a custom grant additively adds auth_materials to an estimator base', () => {
    const grants = [{ action: 'auth_materials' as const, constraints: { max_amount_cents: 100000 } }]
    // within cap
    expect(permissionDecision('estimator', grants, 'auth_materials', { amountCents: 50000 }).outcome).toBe('allowed')
    // exactly at cap is allowed (<=)
    expect(permissionDecision('estimator', grants, 'auth_materials', { amountCents: 100000 }).outcome).toBe('allowed')
  })

  it('over the auth_materials cap returns over_cap with the cap surfaced', () => {
    const grants = [{ action: 'auth_materials' as const, constraints: { max_amount_cents: 100000 } }]
    const verdict = permissionDecision('estimator', grants, 'auth_materials', { amountCents: 150000 })
    expect(verdict).toEqual({ outcome: 'over_cap', cap: 100000 })
  })

  it('uncapped grant (no magnitude or no constraint) is allowed', () => {
    const uncapped = [{ action: 'auth_materials' as const, constraints: null }]
    expect(permissionDecision('estimator', uncapped, 'auth_materials', { amountCents: 9_999_999 }).outcome).toBe(
      'allowed',
    )
    // owner holds auth_materials uncapped; a huge amount with no grant cap is fine
    expect(permissionDecision('owner', [], 'auth_materials', { amountCents: 9_999_999 }).outcome).toBe('allowed')
  })

  it('a grant only TIGHTENS a held cap, never loosens it', () => {
    // owner already holds auth_materials uncapped; a grant adds a 1000-cent cap.
    const grants = [{ action: 'auth_materials' as const, constraints: { max_amount_cents: 1000 } }]
    expect(permissionDecision('owner', grants, 'auth_materials', { amountCents: 5000 })).toEqual({
      outcome: 'over_cap',
      cap: 1000,
    })
  })
})

describe('normalizeGrantConstraints', () => {
  it('null / empty / non-object → null (uncapped)', () => {
    expect(normalizeGrantConstraints(null)).toBeNull()
    expect(normalizeGrantConstraints(undefined)).toBeNull()
    expect(normalizeGrantConstraints({})).toBeNull()
  })

  it('coerces numeric-string jsonb values and drops non-finite', () => {
    expect(normalizeGrantConstraints({ max_amount_cents: '100000' })).toEqual({ max_amount_cents: 100000 })
    expect(normalizeGrantConstraints({ max_amount_cents: 5000, junk: 'not-a-number' })).toEqual({
      max_amount_cents: 5000,
    })
  })
})

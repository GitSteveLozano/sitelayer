import { describe, it, expect } from 'vitest'
import {
  PERMISSION_ACTIONS,
  BUILTIN_ROLES,
  BUILTIN_ROLE_PERMISSIONS,
  CONSTRAINABLE_ACTIONS,
  CONSTRAINT_ENFORCEMENT,
  companyRoleToBuiltin,
  builtinToCompanyRole,
  resolveEffectivePermissions,
  hasPermission,
  checkConstraint,
  isPermissionAction,
  isBuiltinRole,
  isConstrainableAction,
  type PermissionGrant,
} from './permissions.js'
import { COMPANY_ROLES, type CompanyRole } from './roles.js'

describe('permissions — the design matrix (msg__89/90)', () => {
  it('has exactly the 9 design actions', () => {
    expect(PERMISSION_ACTIONS).toEqual([
      'create_project',
      'edit_pricing_book',
      'auth_materials',
      'brief_crew',
      'submit_daily_log',
      'approve_time',
      'clock_in_out',
      'flag_issue',
      'stop_work',
    ])
  })

  it('Owner holds all 9 actions', () => {
    expect([...BUILTIN_ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSION_ACTIONS].sort())
  })

  it('encodes the exact grid for each persona', () => {
    // The matrix cells from the design (Owner=all asserted above).
    expect(new Set(BUILTIN_ROLE_PERMISSIONS.estimator)).toEqual(
      new Set(['create_project', 'edit_pricing_book', 'clock_in_out', 'flag_issue', 'stop_work']),
    )
    expect(new Set(BUILTIN_ROLE_PERMISSIONS.foreman)).toEqual(
      new Set(['brief_crew', 'submit_daily_log', 'approve_time', 'clock_in_out', 'flag_issue', 'stop_work']),
    )
    expect(new Set(BUILTIN_ROLE_PERMISSIONS.crew)).toEqual(new Set(['clock_in_out', 'flag_issue', 'stop_work']))
  })

  it('Estimator and Foreman cannot auth materials (Owner-only by default)', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.estimator).not.toContain('auth_materials')
    expect(BUILTIN_ROLE_PERMISSIONS.foreman).not.toContain('auth_materials')
    expect(BUILTIN_ROLE_PERMISSIONS.owner).toContain('auth_materials')
  })

  it('Foreman is demoted off edit_pricing_book (Owner/Estimator only)', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.foreman).not.toContain('edit_pricing_book')
    expect(BUILTIN_ROLE_PERMISSIONS.estimator).toContain('edit_pricing_book')
  })

  it('every role permission is a real action; every base is a builtin', () => {
    for (const base of BUILTIN_ROLES) {
      for (const action of BUILTIN_ROLE_PERMISSIONS[base]) {
        expect(isPermissionAction(action), `${base}:${action}`).toBe(true)
      }
      expect(isBuiltinRole(base)).toBe(true)
    }
  })
})

describe('permissions — company role <-> builtin mapping', () => {
  it('maps office to estimator (the intended demotion), admin to owner', () => {
    expect(companyRoleToBuiltin('admin')).toBe('owner')
    expect(companyRoleToBuiltin('office')).toBe('estimator')
    expect(companyRoleToBuiltin('foreman')).toBe('foreman')
    expect(companyRoleToBuiltin('member')).toBe('crew')
    expect(companyRoleToBuiltin('bookkeeper')).toBe('bookkeeper')
  })

  it('round-trips every company role through builtin and back', () => {
    for (const role of COMPANY_ROLES as readonly CompanyRole[]) {
      expect(builtinToCompanyRole(companyRoleToBuiltin(role))).toBe(role)
    }
  })
})

describe('permissions — constrainable actions', () => {
  it('only auth_materials and approve_time are constrainable, with their keys', () => {
    expect(CONSTRAINABLE_ACTIONS).toEqual({
      auth_materials: 'max_amount_cents',
      approve_time: 'max_ot_hours_per_week',
    })
    expect(isConstrainableAction('auth_materials')).toBe(true)
    expect(isConstrainableAction('approve_time')).toBe(true)
    expect(isConstrainableAction('create_project')).toBe(false)
  })

  it('auth_materials is enforced; approve_time OT cap is inert in v1', () => {
    expect(CONSTRAINT_ENFORCEMENT.auth_materials).toBe('enforced')
    expect(CONSTRAINT_ENFORCEMENT.approve_time).toBe('inert')
  })
})

describe('permissions — resolveEffectivePermissions', () => {
  it('base role with no grants = the matrix row, all uncapped', () => {
    const perms = resolveEffectivePermissions('foreman')
    expect([...perms.keys()].sort()).toEqual([...BUILTIN_ROLE_PERMISSIONS.foreman].sort())
    expect(perms.get('approve_time')).toEqual({ granted: true, constraints: null })
    expect(hasPermission(perms, 'edit_pricing_book')).toBe(false)
  })

  it('additive grant: Foreman + auth_materials up to $1,000 (the design example)', () => {
    const grants: PermissionGrant[] = [{ action: 'auth_materials', constraints: { max_amount_cents: 100000 } }]
    const perms = resolveEffectivePermissions('foreman', grants)
    expect(hasPermission(perms, 'auth_materials')).toBe(true)
    expect(perms.get('auth_materials')).toEqual({ granted: true, constraints: { max_amount_cents: 100000 } })
    // base actions still present
    expect(hasPermission(perms, 'brief_crew')).toBe(true)
  })

  it('a grant can only tighten a cap a base action already has (min wins)', () => {
    // Owner has auth_materials uncapped; a grant capping it tightens to the cap.
    const tightened = resolveEffectivePermissions('owner', [
      { action: 'auth_materials', constraints: { max_amount_cents: 50000 } },
    ])
    expect(tightened.get('auth_materials')).toEqual({ granted: true, constraints: { max_amount_cents: 50000 } })
    // Two grants: the smaller cap wins.
    const min = resolveEffectivePermissions('crew', [
      { action: 'auth_materials', constraints: { max_amount_cents: 100000 } },
      { action: 'auth_materials', constraints: { max_amount_cents: 30000 } },
    ])
    expect(min.get('auth_materials')?.constraints).toEqual({ max_amount_cents: 30000 })
  })

  it('a grant never removes a base action', () => {
    // No grant API removes; resolving with empty/irrelevant grants keeps the base.
    const perms = resolveEffectivePermissions('crew', [{ action: 'flag_issue', constraints: null }])
    expect(hasPermission(perms, 'clock_in_out')).toBe(true)
    expect(hasPermission(perms, 'flag_issue')).toBe(true)
    expect(hasPermission(perms, 'stop_work')).toBe(true)
  })

  it('ignores grants for unknown actions', () => {
    const perms = resolveEffectivePermissions('crew', [
      { action: 'totally_made_up' as PermissionGrant['action'], constraints: null },
    ])
    expect([...perms.keys()].sort()).toEqual([...BUILTIN_ROLE_PERMISSIONS.crew].sort())
  })
})

describe('permissions — checkConstraint', () => {
  it('uncapped grant allows any value', () => {
    const perms = resolveEffectivePermissions('owner') // auth_materials uncapped
    expect(checkConstraint(perms, 'auth_materials', 9_999_999)).toEqual({ outcome: 'allowed', cap: null })
  })

  it('within cap = allowed; over cap = over_cap with the cap surfaced', () => {
    const perms = resolveEffectivePermissions('foreman', [
      { action: 'auth_materials', constraints: { max_amount_cents: 100000 } },
    ])
    expect(checkConstraint(perms, 'auth_materials', 100000)).toEqual({ outcome: 'allowed', cap: 100000 })
    expect(checkConstraint(perms, 'auth_materials', 100001)).toEqual({ outcome: 'over_cap', cap: 100000 })
  })

  it('action not granted = denied', () => {
    const perms = resolveEffectivePermissions('crew') // no auth_materials
    expect(checkConstraint(perms, 'auth_materials', 1).outcome).toBe('denied')
  })
})

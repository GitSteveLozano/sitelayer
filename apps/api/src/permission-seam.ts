/**
 * Pure resolution + decision helpers for the RBAC custom-roles overhaul
 * (docs/RBAC_OVERHAUL_ANALYSIS.md, packages/domain/src/permissions.ts).
 *
 * These are the I/O-free heart of the LAYER 1 seam + the LAYER 2 overlay so
 * server.ts only owns the SQL/HTTP wiring and this logic stays unit-testable
 * without booting the HTTP server.
 *
 *  - LAYER 1: `resolveCompanyRoleAuthority` turns a member's raw company role
 *    (+ optional custom-role base/grants) into the EFFECTIVE company role used
 *    by the existing ~260 `requireRole` sites, plus the effectiveBuiltin +
 *    grants used by LAYER 2. For a plain member the effective role round-trips
 *    to exactly `normalizeCompanyRole(raw)` — zero behaviour change.
 *
 *  - LAYER 2: `permissionDecision` is the pure verdict behind
 *    `requirePermission`: granted? and, for a constrainable action with a
 *    magnitude, within cap? server.ts maps the verdict to a 200-continue / 403.
 */

import {
  builtinToCompanyRole,
  checkConstraint,
  companyRoleToBuiltin,
  hasPermission,
  isConstrainableAction,
  resolveEffectivePermissions,
  CONSTRAINABLE_ACTIONS,
  type BuiltinRole,
  type CompanyRole,
  type PermissionAction,
  type PermissionGrant,
} from '@sitelayer/domain'

/** The custom-role base + additive grants, once loaded from the DB. */
export type CustomRoleAuthority = {
  effectiveBuiltin: BuiltinRole
  grants: PermissionGrant[]
}

/** The resolved per-request authority feeding both enforcement layers. */
export type CompanyRoleAuthority = {
  /** EFFECTIVE company role for LAYER 1 (`requireRole`). */
  effectiveRole: CompanyRole
  /** Built-in base for LAYER 2 (`requirePermission` / the matrix). */
  effectiveBuiltin: BuiltinRole
  /** Additive named-action grants (custom roles only; [] otherwise). */
  grants: PermissionGrant[]
}

/**
 * Coerce a grant's jsonb `constraints` into the numeric Record the resolver
 * expects. Drops non-finite values; null/empty → null (uncapped).
 */
export function normalizeGrantConstraints(
  raw: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    const num = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(num)) out[key] = num
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Resolve a member's effective authority. `customRole` is the loaded
 * inherit_from base + grants when the member is linked to a (live) custom role,
 * else null.
 *
 * Custom-role member → gates the long tail as `builtinToCompanyRole(base)`; the
 * matrix + grants apply at the named-action overlay. Plain member → unchanged:
 * effectiveRole is exactly `normalizedRole` and the base round-trips to it.
 */
export function resolveCompanyRoleAuthority(
  normalizedRole: CompanyRole,
  customRole: CustomRoleAuthority | null,
): CompanyRoleAuthority {
  if (customRole) {
    return {
      effectiveRole: builtinToCompanyRole(customRole.effectiveBuiltin),
      effectiveBuiltin: customRole.effectiveBuiltin,
      grants: customRole.grants,
    }
  }
  return {
    effectiveRole: normalizedRole,
    effectiveBuiltin: companyRoleToBuiltin(normalizedRole),
    grants: [],
  }
}

/** Verdict for one LAYER 2 named-action check. */
export type PermissionVerdict =
  | { outcome: 'allowed' }
  | { outcome: 'denied' }
  | { outcome: 'over_cap'; cap: number | null }

/**
 * The pure decision behind `requirePermission`. Resolves the effective
 * permission map from base + grants, then:
 *  - 'denied'   when the action isn't held at all.
 *  - 'over_cap' when the action is constrainable, a magnitude is supplied, and
 *               it exceeds the cap (surfaces the cap).
 *  - 'allowed'  otherwise.
 *
 * `opts.amountCents` feeds `auth_materials` (max_amount_cents); `opts.otHours`
 * feeds `approve_time` (max_ot_hours_per_week — stored but INERT in v1; the cap
 * is still checked here when an hours figure is explicitly supplied).
 */
export function permissionDecision(
  effectiveBuiltin: BuiltinRole,
  grants: readonly PermissionGrant[],
  action: PermissionAction,
  opts: { amountCents?: number; otHours?: number } = {},
): PermissionVerdict {
  const perms = resolveEffectivePermissions(effectiveBuiltin, grants)
  if (!hasPermission(perms, action)) return { outcome: 'denied' }
  if (isConstrainableAction(action)) {
    const capKey = CONSTRAINABLE_ACTIONS[action]
    const value = capKey === 'max_amount_cents' ? opts.amountCents : opts.otHours
    if (value !== undefined) {
      const result = checkConstraint(perms, action, value)
      if (result.outcome === 'over_cap') return { outcome: 'over_cap', cap: result.cap }
    }
  }
  return { outcome: 'allowed' }
}

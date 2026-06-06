/**
 * Permission model for the custom-roles overhaul (RBAC-A / RABAC).
 *
 * See docs/RBAC_OVERHAUL_ANALYSIS.md for the full rationale. In short:
 *
 *  - The Steve design is a role-centric RBAC + a thin attribute-constraint
 *    layer (NIST "RBAC-A", Kuhn-Coyne-Weil 2010; RABAC, Jin-Sandhu-Krishnan
 *    2012). Four built-in roles over a 9-ACTION matrix, plus custom roles that
 *    inherit a base role and add *parameterized* extra powers (e.g. "auth
 *    materials up to $1,000", "approve OT <= 8h/week").
 *
 *  - Why these live in @sitelayer/domain as a checked-in constant (not a
 *    table): the built-in role->permission matrix is the SYSTEM CONTRACT —
 *    constant-time, immutable, no DB hit. Only CUSTOM roles are per-company
 *    editable (stored in custom_roles / custom_role_grants, migration 136).
 *
 * TWO-LAYER ENFORCEMENT (the key architectural decision):
 *
 *  1. The ~260 existing `requireRole([...])` sites gate the LONG TAIL of
 *     operations off the caller's effective BASE role. Custom roles resolve to
 *     their `inherit_from` base, so making role-resolution custom-role-aware in
 *     ONE place (server.ts) lets every existing site respect custom roles with
 *     no per-site edit. The matrix does NOT define permissions for these ~260
 *     operations — only the 9 named actions below.
 *
 *  2. The 9 NAMED ACTIONS get an explicit `requirePermission(action)` overlay
 *     at their specific routes. Here the matrix is authoritative (so e.g.
 *     Foreman loses edit_pricing_book, materials-auth is Owner-only by
 *     default), custom-role grants apply additively, and the $-cap / OT-cap
 *     constraints are enforced (auth_materials live; approve_time defined but
 *     INERT in v1 — no per-request OT figure exists at the approve boundary).
 *
 * Constraints can only NARROW a granted action (P ∩ R) — a custom role can add
 * a capped power or tighten a cap, but can never remove a base action. A
 * continuous dollar cap has no finite role encoding, which is exactly why the
 * cap is an attribute on the grant, not a distinct role (role explosion).
 */

import type { CompanyRole } from './roles.js'

// --- The 9 design actions (msg__89/90 ACTION_MATRIX) -----------------------

export const PERMISSION_ACTIONS = [
  'create_project',
  'edit_pricing_book',
  'auth_materials',
  'brief_crew',
  'submit_daily_log',
  'approve_time',
  'clock_in_out',
  'flag_issue',
  'stop_work',
] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && (PERMISSION_ACTIONS as readonly string[]).includes(value)
}

// --- Built-in roles --------------------------------------------------------
//
// The four design personas (Owner/Estimator/Foreman/Crew) plus `bookkeeper`,
// which the design's O/E/F/W matrix omits. Per the operator's decision the
// bookkeeper is a seeded role that keeps its financial visibility (its long
// tail, preserved via the base mapping below) but has no field/crew powers —
// modeled here as a fifth base whose 9-action row is the universal-safety
// minimum. Bookkeeper's substantive authority is the financial tail, not the
// field-ops matrix.

export const BUILTIN_ROLES = ['owner', 'estimator', 'foreman', 'crew', 'bookkeeper'] as const
export type BuiltinRole = (typeof BUILTIN_ROLES)[number]

export function isBuiltinRole(value: unknown): value is BuiltinRole {
  return typeof value === 'string' && (BUILTIN_ROLES as readonly string[]).includes(value)
}

/**
 * Company role (the 5-union stored on company_memberships.role) -> built-in.
 *
 * NOTE the intended, operator-confirmed demotion: `office` maps to `estimator`
 * (NOT `admin`). Today normalizeCompanyRole collapses office->admin on read, so
 * office currently has full-owner powers; under the matrix an Estimator is
 * strictly less than an Owner. This demotion is realized ONLY at the 9 named
 * actions (the requirePermission overlay) — the long-tail requireRole sites
 * still gate on the raw company role, so office keeps its existing tail access.
 */
export function companyRoleToBuiltin(role: CompanyRole): BuiltinRole {
  switch (role) {
    case 'admin':
      return 'owner'
    case 'office':
      return 'estimator'
    case 'foreman':
      return 'foreman'
    case 'member':
      return 'crew'
    case 'bookkeeper':
      return 'bookkeeper'
  }
}

/**
 * Built-in (a custom role's inherit_from) -> the company role used to gate the
 * long tail. The inverse of companyRoleToBuiltin; owner->admin keeps a custom
 * Owner-based role at admin tail authority.
 */
export function builtinToCompanyRole(role: BuiltinRole): CompanyRole {
  switch (role) {
    case 'owner':
      return 'admin'
    case 'estimator':
      return 'office'
    case 'foreman':
      return 'foreman'
    case 'crew':
      return 'member'
    case 'bookkeeper':
      return 'bookkeeper'
  }
}

// --- The matrix (BUILTIN_ROLE_PERMISSIONS) ---------------------------------
//
// Exactly the design's ACTION_MATRIX. Owner = all 9; the rest per the grid.
// This is the system contract — editing it is a deliberate code change, never
// a per-company write.

export const BUILTIN_ROLE_PERMISSIONS: Record<BuiltinRole, readonly PermissionAction[]> = {
  owner: [...PERMISSION_ACTIONS],
  estimator: ['create_project', 'edit_pricing_book', 'clock_in_out', 'flag_issue', 'stop_work'],
  foreman: ['brief_crew', 'submit_daily_log', 'approve_time', 'clock_in_out', 'flag_issue', 'stop_work'],
  crew: ['clock_in_out', 'flag_issue', 'stop_work'],
  // Office/financial persona: universal safety only; real authority is the
  // financial long tail gated by the bookkeeper company role.
  bookkeeper: ['flag_issue', 'stop_work'],
}

// --- Constrainable actions (the attribute layer) ---------------------------
//
// Maps an action to the constraint parameter key it carries. A grant on a
// constrainable action MAY include the key (a cap); absent/null = uncapped.
// Money is integer cents; OT is whole hours/week. approve_time's cap is stored
// and validated in v1 but NOT enforced (the OT figure isn't presented at the
// time-review approve boundary — see analysis doc).

export const CONSTRAINABLE_ACTIONS = {
  auth_materials: 'max_amount_cents',
  approve_time: 'max_ot_hours_per_week',
} as const satisfies Partial<Record<PermissionAction, string>>

export type ConstrainableAction = keyof typeof CONSTRAINABLE_ACTIONS

export function isConstrainableAction(action: PermissionAction): action is ConstrainableAction {
  return action in CONSTRAINABLE_ACTIONS
}

/** v1 enforcement status of a constrainable action's cap. */
export const CONSTRAINT_ENFORCEMENT: Record<ConstrainableAction, 'enforced' | 'inert'> = {
  // material_bills.amount is present at POST /api/projects/:id/material-bills.
  auth_materials: 'enforced',
  // OT is a downstream payroll aggregate, not surfaced at the approve boundary.
  approve_time: 'inert',
}

// --- Custom-role grants + effective resolution -----------------------------

/** A per-company grant row (custom_role_grants): an action + optional caps. */
export interface PermissionGrant {
  action: PermissionAction
  /** Numeric constraint params, e.g. { max_amount_cents: 100000 }. null/{} = uncapped. */
  constraints: Readonly<Record<string, number>> | null
}

/** The resolved authority for one action. constraints null = uncapped. */
export interface EffectivePermission {
  granted: true
  constraints: Readonly<Record<string, number>> | null
}

export type EffectivePermissionMap = ReadonlyMap<PermissionAction, EffectivePermission>

/**
 * Tighter-wins merge of two constraint sets: per key the SMALLER value wins
 * (a cap can only narrow). A missing key on either side means "uncapped on
 * that key", and uncapped is looser than any number — so the side that
 * specifies the key wins. null on both = uncapped.
 */
function mergeConstraintsTighter(
  a: Readonly<Record<string, number>> | null,
  b: Readonly<Record<string, number>> | null,
): Readonly<Record<string, number>> | null {
  if (!a || Object.keys(a).length === 0) return b && Object.keys(b).length > 0 ? b : null
  if (!b || Object.keys(b).length === 0) return Object.keys(a).length > 0 ? a : null
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const existing = out[k]
    out[k] = existing === undefined ? v : Math.min(existing, v)
  }
  return out
}

/**
 * Resolve a caller's effective named-action permissions: start from the base
 * built-in matrix (every base action granted, uncapped), then apply custom
 * grants. Additive at the ACTION level (a grant adds an action the base lacks),
 * reductive at the MAGNITUDE level (a grant on a held action can only tighten
 * its cap). A grant never removes a base action.
 */
export function resolveEffectivePermissions(
  base: BuiltinRole,
  grants: readonly PermissionGrant[] = [],
): EffectivePermissionMap {
  const out = new Map<PermissionAction, EffectivePermission>()
  for (const action of BUILTIN_ROLE_PERMISSIONS[base]) {
    out.set(action, { granted: true, constraints: null })
  }
  for (const grant of grants) {
    if (!isPermissionAction(grant.action)) continue
    const existing = out.get(grant.action)
    const grantConstraints = grant.constraints && Object.keys(grant.constraints).length > 0 ? grant.constraints : null
    if (!existing) {
      // Additive: the base lacks this action; the grant adds it with its cap.
      out.set(grant.action, { granted: true, constraints: grantConstraints })
    } else {
      // Already held by the base: tighten the cap only (never loosen).
      out.set(grant.action, {
        granted: true,
        constraints: mergeConstraintsTighter(existing.constraints, grantConstraints),
      })
    }
  }
  return out
}

/** Does the caller hold the action at all (ignoring caps)? */
export function hasPermission(perms: EffectivePermissionMap, action: PermissionAction): boolean {
  return perms.get(action)?.granted === true
}

/**
 * Check a constrainable action against an actual magnitude. Returns:
 *  - 'denied'  : the action isn't granted at all.
 *  - 'allowed' : granted and within cap (or uncapped).
 *  - 'over_cap': granted but the magnitude exceeds the cap (caller is over
 *                their limit; route should 403 with the cap surfaced).
 * `value` units must match the constraint key (cents for max_amount_cents,
 * hours for max_ot_hours_per_week).
 */
export function checkConstraint(
  perms: EffectivePermissionMap,
  action: ConstrainableAction,
  value: number,
): { outcome: 'denied' | 'allowed' | 'over_cap'; cap: number | null } {
  const perm = perms.get(action)
  if (!perm) return { outcome: 'denied', cap: null }
  const capKey = CONSTRAINABLE_ACTIONS[action]
  const cap = perm.constraints?.[capKey]
  if (cap === undefined) return { outcome: 'allowed', cap: null }
  return { outcome: value <= cap ? 'allowed' : 'over_cap', cap }
}

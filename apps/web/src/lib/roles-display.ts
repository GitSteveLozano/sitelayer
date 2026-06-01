// Presentational helpers for the Roles + Permissions settings surfaces
// (mobile owner-settings-mobile.tsx + desktop owner-settings.tsx).
//
// The matrix itself is the immutable system contract in @sitelayer/domain
// (BUILTIN_ROLE_PERMISSIONS); this module only owns the human-facing labels
// for the 9 actions / 5 built-in roles and the small bits of form-encoding
// the create-custom-role flow needs (the auth_materials $-cap and the inert
// approve_time OT-cap). Nothing here re-derives permission logic — that all
// lives in permissions.ts and is imported.

import {
  BUILTIN_ROLE_PERMISSIONS,
  CONSTRAINABLE_ACTIONS,
  PERMISSION_ACTIONS,
  type BuiltinRole,
  type PermissionAction,
} from '@sitelayer/domain'
import type { CustomRoleGrant } from '@/lib/api/company-roles'

/** Human label for each of the 9 named actions, in matrix order. */
export const ACTION_LABELS: Record<PermissionAction, string> = {
  create_project: 'Create project',
  edit_pricing_book: 'Edit pricing book',
  auth_materials: 'Auth materials · $',
  brief_crew: 'Brief crew',
  submit_daily_log: 'Submit daily log',
  approve_time: 'Approve time',
  clock_in_out: 'Clock in / out',
  flag_issue: 'Flag issue',
  stop_work: 'Stop work',
}

/** Human label for each of the 5 built-in bases. */
export const BUILTIN_ROLE_LABELS: Record<BuiltinRole, string> = {
  owner: 'Owner',
  estimator: 'Estimator',
  foreman: 'Foreman',
  crew: 'Crew',
  bookkeeper: 'Bookkeeper',
}

/** Single-letter column header per built-in (Crew shows W, the design's "worker"). */
export const BUILTIN_ROLE_INITIALS: Record<BuiltinRole, string> = {
  owner: 'O',
  estimator: 'E',
  foreman: 'F',
  crew: 'W',
  bookkeeper: 'B',
}

/** The 9 actions in their canonical display order (matches PERMISSION_ACTIONS). */
export const ACTION_ORDER: readonly PermissionAction[] = PERMISSION_ACTIONS

/**
 * Build the read-only action × role matrix straight from the built-in
 * permission contract. `roles` is the ordered set of built-in bases to show
 * as columns (the API's `builtins` list preserves BUILTIN_ROLES order).
 */
export function buildBuiltinMatrix(
  roles: readonly BuiltinRole[],
): Array<{ action: PermissionAction; label: string; allowed: Record<BuiltinRole, boolean> }> {
  return ACTION_ORDER.map((action) => {
    const allowed = {} as Record<BuiltinRole, boolean>
    for (const role of roles) {
      allowed[role] = (BUILTIN_ROLE_PERMISSIONS[role] as readonly PermissionAction[]).includes(action)
    }
    return { action, label: ACTION_LABELS[action], allowed }
  })
}

/** Default $ cap shown when a fresh role first enables auth_materials. */
export const DEFAULT_AUTH_MATERIALS_DOLLARS = 1000
/** Default OT cap (hours/week) shown when a fresh role first enables approve_time. */
export const DEFAULT_APPROVE_OT_HOURS = 8

/**
 * The form state for the "extra powers" a custom role can toggle on. Only the
 * actions a base does NOT already hold are meaningful to add, but we keep the
 * full list so the UI can show what's inherited vs addable. Each entry carries
 * the optional cap input (dollars for auth_materials, OT hours for approve_time).
 */
export interface ExtraPowerState {
  /** Is the action toggled on as an extra grant? */
  on: boolean
  /** auth_materials: dollar cap as a string (UI input). Empty = uncapped. */
  dollars?: string
  /** approve_time: OT hours/week cap as a string (UI input). Empty = uncapped. */
  otHours?: string
}

/**
 * Encode the toggled extra-power form state into the grant array the API
 * accepts. auth_materials' dollar input becomes integer cents
 * (max_amount_cents); approve_time's OT input becomes whole hours
 * (max_ot_hours_per_week). Blank caps encode as an uncapped grant
 * (constraints null). Actions left off are omitted entirely.
 *
 * Throws on a malformed (negative / non-numeric) cap so the caller can surface
 * a field error before POSTing.
 */
export function encodeGrants(state: Record<string, ExtraPowerState>): CustomRoleGrant[] {
  const out: CustomRoleGrant[] = []
  for (const action of ACTION_ORDER) {
    const power = state[action]
    if (!power?.on) continue
    let constraints: Record<string, number> | null = null
    if (action === 'auth_materials' && power.dollars != null && power.dollars.trim() !== '') {
      const dollars = Number(power.dollars)
      if (!Number.isFinite(dollars) || dollars < 0) {
        throw new Error('Auth materials cap must be a non-negative dollar amount.')
      }
      constraints = { [CONSTRAINABLE_ACTIONS.auth_materials]: Math.round(dollars * 100) }
    } else if (action === 'approve_time' && power.otHours != null && power.otHours.trim() !== '') {
      const hours = Number(power.otHours)
      if (!Number.isInteger(hours) || hours < 0) {
        throw new Error('Approve OT cap must be a non-negative whole number of hours.')
      }
      constraints = { [CONSTRAINABLE_ACTIONS.approve_time]: hours }
    }
    out.push({ action, constraints })
  }
  return out
}

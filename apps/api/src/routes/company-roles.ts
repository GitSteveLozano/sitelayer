import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_PERMISSIONS,
  CONSTRAINABLE_ACTIONS,
  FIELD_REQUEST_CAPABILITIES,
  PERMISSION_ACTIONS,
  builtinToCompanyRole,
  companyRoleToBuiltin,
  defaultCompanyCapabilities,
  isBuiltinRole,
  isConstrainableAction,
  isFieldRequestCapability,
  mergeCompanyCapabilities,
  normalizeCompanyRole,
  type BuiltinRole,
  type CompanyRole,
  type FieldRequestCapability,
  type PermissionAction,
} from '@sitelayer/domain'
import { recordAudit } from '../audit.js'
import { HttpError, parseJsonBody } from '../http-utils.js'
import { observeAudit } from '../metrics.js'
import { withMutationTx } from '../mutation-tx.js'

/**
 * Custom-role management API (the editable half of the RBAC-A overhaul — see
 * docs/RBAC_OVERHAUL_ANALYSIS.md and packages/domain/src/permissions.ts).
 *
 * Built-in roles are the immutable system contract in @sitelayer/domain and are
 * NOT stored or editable here — GET surfaces their matrix read-only. CUSTOM
 * roles (migration 136: custom_roles + custom_role_grants) inherit one of the
 * five built-in bases and add parameterized named-action grants; those are the
 * rows this admin-gated CRUD writes.
 *
 * Routes:
 *   GET    /api/companies/:id/roles                 → { builtins, custom }
 *   POST   /api/companies/:id/roles                 → create custom role + grants
 *   PATCH  /api/companies/:id/roles/:roleId         → rename and/or replace grants
 *   DELETE /api/companies/:id/roles/:roleId         → soft-delete + unlink memberships
 *   POST   /api/companies/:id/memberships/:mId/role → assign custom/builtin role
 *
 * Every mutation runs under withMutationTx(companyId, …) so the RLS GUC is set
 * and the writes are atomic.
 */

export type CompanyRoleRouteCtx = {
  pool: Pool
  /** Act-as-aware identity (getCurrentUserId), used for audit attribution. */
  userId: string
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
}

/** Shared executor interface satisfied by Pool and PoolClient. */
type QueryExecutor = Pick<Pool | PoolClient, 'query'>

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PermissionActionEnum = z.enum(PERMISSION_ACTIONS)
const BuiltinRoleEnum = z.enum(BUILTIN_ROLES)

/**
 * A single grant: an action plus optional integer constraints. A constraint
 * key is only legal on a constrainable action (CONSTRAINABLE_ACTIONS), must be
 * the action's own key (e.g. auth_materials → max_amount_cents), and must be a
 * non-negative integer (money in cents). The cross-field checks live in
 * `validateGrant` so the 400 message names the offending action + key.
 */
const GrantSchema = z
  .object({
    action: PermissionActionEnum,
    constraints: z.record(z.string(), z.number()).nullish(),
  })
  .strict()

const CreateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    inherit_from: BuiltinRoleEnum,
    grants: z.array(GrantSchema).max(PERMISSION_ACTIONS.length).optional(),
  })
  .strict()

const PatchRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    grants: z.array(GrantSchema).max(PERMISSION_ACTIONS.length).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.grants !== undefined, {
    message: 'name or grants is required',
  })

const AssignRoleSchema = z
  .object({
    custom_role_id: z.string().trim().min(1).nullish(),
    builtin_role: BuiltinRoleEnum.optional(),
  })
  .strict()
  .refine((v) => v.custom_role_id !== undefined || v.builtin_role !== undefined, {
    message: 'custom_role_id or builtin_role is required',
  })

/**
 * Body for granting one company (field_request.*) capability to a membership.
 * The capability MUST be a field_request.* name — the company boundary can
 * never mint an app_issue.* cap (those live ONLY on the platform boundary via
 * platform_admin_grants). The enum is the catalog slice from @sitelayer/domain.
 */
const FieldRequestCapabilityEnum = z.enum(FIELD_REQUEST_CAPABILITIES)
const GrantCapabilitySchema = z
  .object({
    capability: FieldRequestCapabilityEnum,
  })
  .strict()

type ParsedGrant = { action: PermissionAction; constraints: Record<string, number> | null }

/**
 * Cross-field validation a Zod schema can't express ergonomically:
 *  - a constraint key must belong to the action (auth_materials → max_amount_cents);
 *  - a cap on a non-constrainable action is rejected;
 *  - cap values must be non-negative integers (cents / whole hours).
 * Returns the normalized grant (constraints null when empty) or throws HttpError.
 */
function validateGrant(grant: {
  action: PermissionAction
  constraints?: Record<string, number> | null | undefined
}): ParsedGrant {
  const raw = grant.constraints
  if (raw === undefined || raw === null || Object.keys(raw).length === 0) {
    return { action: grant.action, constraints: null }
  }
  if (!isConstrainableAction(grant.action)) {
    throw new HttpError(400, `action ${grant.action} is not constrainable — remove its constraints`)
  }
  const expectedKey: string = CONSTRAINABLE_ACTIONS[grant.action]
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== expectedKey) {
      throw new HttpError(400, `action ${grant.action} only accepts the constraint key ${expectedKey}, got ${key}`)
    }
    if (!Number.isInteger(value)) {
      throw new HttpError(400, `constraint ${key} must be an integer, got ${value}`)
    }
    if (value < 0) {
      throw new HttpError(400, `constraint ${key} must be non-negative, got ${value}`)
    }
    out[key] = value
  }
  return { action: grant.action, constraints: Object.keys(out).length > 0 ? out : null }
}

/**
 * Validate + de-dup a grant set. A repeated action is rejected (the DB unique
 * (custom_role_id, action) would 500 otherwise, and "last write wins" silently
 * would surprise the caller).
 */
function validateGrants(
  grants: ReadonlyArray<{ action: PermissionAction; constraints?: Record<string, number> | null | undefined }>,
): ParsedGrant[] {
  const seen = new Set<PermissionAction>()
  const out: ParsedGrant[] = []
  for (const grant of grants) {
    if (seen.has(grant.action)) {
      throw new HttpError(400, `duplicate grant for action ${grant.action}`)
    }
    seen.add(grant.action)
    out.push(validateGrant(grant))
  }
  return out
}

// ---------------------------------------------------------------------------
// Row shapes + response shaping
// ---------------------------------------------------------------------------

type CustomRoleRow = {
  id: string
  company_id: string
  name: string
  inherit_from: string
  created_at: string
  created_by: string | null
}

type GrantRow = {
  id: string
  custom_role_id: string
  action: string
  constraints: Record<string, unknown> | null
}

/** The read-only built-in matrix, surfaced so the UI never re-derives it. */
function builtinsView() {
  return BUILTIN_ROLES.map((role: BuiltinRole) => ({
    role,
    actions: BUILTIN_ROLE_PERMISSIONS[role],
  }))
}

function customRoleView(row: CustomRoleRow, grants: GrantRow[]) {
  return {
    id: row.id,
    name: row.name,
    inherit_from: row.inherit_from,
    created_at: row.created_at,
    created_by: row.created_by,
    grants: grants
      .filter((g) => g.custom_role_id === row.id)
      .map((g) => ({ action: g.action, constraints: g.constraints ?? null })),
  }
}

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

/** Returns true (and sends 403) if the caller is not an admin of `companyId`. */
async function blockIfNotAdmin(ctx: CompanyRoleRouteCtx, companyId: string): Promise<boolean> {
  const check = await ctx.pool.query<{ role: string }>(
    'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
    [companyId, ctx.userId],
  )
  if (!check.rows[0] || normalizeCompanyRole(check.rows[0].role) !== 'admin') {
    ctx.sendJson(403, { error: 'admin role required' })
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Transaction bodies (extracted so they can be unit-tested against a fake client)
// ---------------------------------------------------------------------------

/** Insert a custom role + its grants. Caller wraps this in withMutationTx. */
export async function createCustomRoleTx(
  client: QueryExecutor,
  args: { companyId: string; name: string; inheritFrom: BuiltinRole; grants: ParsedGrant[]; actorUserId: string },
): Promise<{ role: CustomRoleRow; grants: GrantRow[] }> {
  let roleRow: CustomRoleRow
  try {
    const inserted = await client.query<CustomRoleRow>(
      `insert into custom_roles (company_id, name, inherit_from, created_by)
       values ($1, $2, $3, $4)
       returning id, company_id, name, inherit_from, created_at, created_by`,
      [args.companyId, args.name, args.inheritFrom, args.actorUserId],
    )
    const row = inserted.rows[0]
    if (!row) throw new HttpError(500, 'custom role insert returned no row')
    roleRow = row
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'a role with that name already exists')
    throw err
  }

  const grantRows = await insertGrants(client, args.companyId, roleRow.id, args.grants)

  await recordAudit(client, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    entityType: 'company_role',
    entityId: roleRow.id,
    action: 'create',
    after: { id: roleRow.id, name: roleRow.name, inherit_from: roleRow.inherit_from, grants: args.grants },
  })

  return { role: roleRow, grants: grantRows }
}

/** Replace a role's name and/or grant set. Caller wraps this in withMutationTx. */
export async function patchCustomRoleTx(
  client: QueryExecutor,
  args: {
    companyId: string
    roleId: string
    name?: string | undefined
    grants?: ParsedGrant[] | undefined
    actorUserId: string
  },
): Promise<{ role: CustomRoleRow; grants: GrantRow[] }> {
  // Lock the role (also asserts it exists, belongs to the company, and is live).
  const existing = await client.query<CustomRoleRow>(
    `select id, company_id, name, inherit_from, created_at, created_by
       from custom_roles where id = $1 and company_id = $2 and deleted_at is null
       for update`,
    [args.roleId, args.companyId],
  )
  if (!existing.rows[0]) throw new HttpError(404, 'custom role not found')

  let roleRow = existing.rows[0]
  if (args.name !== undefined && args.name !== roleRow.name) {
    try {
      const updated = await client.query<CustomRoleRow>(
        `update custom_roles set name = $1 where id = $2 and company_id = $3
         returning id, company_id, name, inherit_from, created_at, created_by`,
        [args.name, args.roleId, args.companyId],
      )
      roleRow = updated.rows[0] ?? roleRow
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'a role with that name already exists')
      throw err
    }
  }

  let grantRows: GrantRow[]
  if (args.grants !== undefined) {
    // Replace-the-set semantics: clear and re-insert so a removed action's
    // grant row disappears (inherit_from is immutable, never touched here).
    await client.query('delete from custom_role_grants where custom_role_id = $1 and company_id = $2', [
      args.roleId,
      args.companyId,
    ])
    grantRows = await insertGrants(client, args.companyId, args.roleId, args.grants)
  } else {
    grantRows = await selectGrants(client, args.companyId, args.roleId)
  }

  await recordAudit(client, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    entityType: 'company_role',
    entityId: args.roleId,
    action: 'update',
    after: {
      id: args.roleId,
      name: roleRow.name,
      ...(args.grants !== undefined ? { grants: args.grants } : {}),
    },
  })

  return { role: roleRow, grants: grantRows }
}

/** Soft-delete a role and null every membership.custom_role_id pointing at it. */
export async function deleteCustomRoleTx(
  client: QueryExecutor,
  args: { companyId: string; roleId: string; actorUserId: string },
): Promise<{ unlinked: number }> {
  const deleted = await client.query<{ id: string }>(
    `update custom_roles set deleted_at = now()
       where id = $1 and company_id = $2 and deleted_at is null
       returning id`,
    [args.roleId, args.companyId],
  )
  if (!deleted.rows[0]) throw new HttpError(404, 'custom role not found')

  // Detach members so a soft-deleted role can't keep gating anyone. The
  // membership then falls back to its raw company role (LAYER 1 default).
  const unlinked = await client.query(
    `update company_memberships set custom_role_id = null
       where company_id = $1 and custom_role_id = $2`,
    [args.companyId, args.roleId],
  )

  await recordAudit(client, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    entityType: 'company_role',
    entityId: args.roleId,
    action: 'delete',
    after: { id: args.roleId, unlinked_memberships: unlinked.rowCount ?? 0 },
  })

  return { unlinked: unlinked.rowCount ?? 0 }
}

/**
 * Assign a custom role (or clear it back to the raw company role) on one
 * membership. When `builtinRole` is supplied the member is set to that built-in
 * base via its company role AND any custom_role_id is cleared, so the member
 * gates purely on the matrix built-in. Caller wraps this in withMutationTx.
 */
export async function assignMembershipRoleTx(
  client: QueryExecutor,
  args: {
    companyId: string
    membershipId: string
    customRoleId?: string | null | undefined
    builtinRole?: BuiltinRole | undefined
    actorUserId: string
  },
): Promise<{ membership: { id: string; clerk_user_id: string; role: string; custom_role_id: string | null } }> {
  // Lock the membership and assert it belongs to the company.
  const membership = await client.query<{
    id: string
    clerk_user_id: string
    role: string
    custom_role_id: string | null
  }>(
    `select id, clerk_user_id, role, custom_role_id from company_memberships
       where id = $1 and company_id = $2 for update`,
    [args.membershipId, args.companyId],
  )
  if (!membership.rows[0]) throw new HttpError(404, 'membership not found')

  let nextRole = membership.rows[0].role
  let nextCustomRoleId: string | null

  if (args.builtinRole !== undefined) {
    // Assigning a built-in base: map to its company role (the LAYER 1 long-tail
    // gate) via the domain helper, and clear the custom link.
    nextRole = builtinToCompanyRole(args.builtinRole)
    nextCustomRoleId = null
  } else if (args.customRoleId) {
    // Assigning a custom role: assert it exists, is live, and is this company's.
    const role = await client.query<{ id: string }>(
      `select id from custom_roles where id = $1 and company_id = $2 and deleted_at is null limit 1`,
      [args.customRoleId, args.companyId],
    )
    if (!role.rows[0]) throw new HttpError(404, 'custom role not found')
    nextCustomRoleId = args.customRoleId
  } else {
    // custom_role_id: null → clear the link, keep the raw company role.
    nextCustomRoleId = null
  }

  const updated = await client.query<{
    id: string
    clerk_user_id: string
    role: string
    custom_role_id: string | null
  }>(
    `update company_memberships set role = $1, custom_role_id = $2
       where id = $3 and company_id = $4
       returning id, clerk_user_id, role, custom_role_id`,
    [nextRole, nextCustomRoleId, args.membershipId, args.companyId],
  )
  const row = updated.rows[0]
  if (!row) throw new HttpError(500, 'membership role update returned no row')

  await recordAudit(client, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    entityType: 'company_membership',
    entityId: row.id,
    action: 'assign_role',
    after: { id: row.id, role: row.role, custom_role_id: row.custom_role_id },
  })

  return { membership: row }
}

// ---------------------------------------------------------------------------
// Membership capability grants (the field_request.* opt-in surface)
// ---------------------------------------------------------------------------
//
// The foundation (packages/domain/src/capabilities.ts +
// apps/api/src/capability.ts) resolves a membership's effective COMPANY
// capabilities as: the role-default field_request.* caps UNION the field_request.*
// slice of the EXISTING additive custom_role_grants action rows attached to the
// membership's custom role (server.ts loads those into `grantActions`). So to
// "grant a company capability to a membership" we add a field_request.* action
// row to that membership's custom role — the same row shape the keystone reads.
//
// A membership without a custom role has nowhere additive to live, so the grant
// path auto-provisions a per-member custom role inheriting the member's current
// builtin base (a behaviour-preserving no-op until a field_request.* row is
// added). Revoke deletes the field_request.* row; it never strips a role-default
// cap (you can't drop below the role floor — that's the system contract).

type MembershipRow = {
  id: string
  clerk_user_id: string
  role: string
  custom_role_id: string | null
}

/** The shape returned by the capability GET / grant / revoke endpoints. */
export type MembershipCapabilitiesView = {
  membership_id: string
  clerk_user_id: string
  role: CompanyRole
  /** The role-floor field_request.* caps (always held; never revocable). */
  role_default: FieldRequestCapability[]
  /** The additive field_request.* caps granted via custom_role_grants. */
  granted: FieldRequestCapability[]
  /** role_default ∪ granted — the membership's effective company caps. */
  effective: FieldRequestCapability[]
}

const FIELD_REQUEST_CAPABILITY_ORDER: readonly FieldRequestCapability[] = FIELD_REQUEST_CAPABILITIES

/** Stable catalog order so the response is deterministic. */
function sortCaps(caps: Iterable<FieldRequestCapability>): FieldRequestCapability[] {
  const set = new Set(caps)
  return FIELD_REQUEST_CAPABILITY_ORDER.filter((c) => set.has(c))
}

/** Load a membership (asserts it belongs to the company). For-update optional. */
async function loadMembership(
  client: QueryExecutor,
  companyId: string,
  membershipId: string,
  forUpdate: boolean,
): Promise<MembershipRow> {
  const result = await client.query<MembershipRow>(
    `select id, clerk_user_id, role, custom_role_id from company_memberships
       where id = $1 and company_id = $2${forUpdate ? ' for update' : ''}`,
    [membershipId, companyId],
  )
  const row = result.rows[0]
  if (!row) throw new HttpError(404, 'membership not found')
  return row
}

/** The field_request.* action names granted on a (live) custom role. */
async function selectFieldRequestGrants(
  client: QueryExecutor,
  companyId: string,
  customRoleId: string | null,
): Promise<FieldRequestCapability[]> {
  if (!customRoleId) return []
  const result = await client.query<{ action: string }>(
    `select action from custom_role_grants where custom_role_id = $1 and company_id = $2`,
    [customRoleId, companyId],
  )
  const out = new Set<FieldRequestCapability>()
  for (const row of result.rows) {
    if (isFieldRequestCapability(row.action)) out.add(row.action)
  }
  return sortCaps(out)
}

function membershipCapabilitiesView(row: MembershipRow, granted: FieldRequestCapability[]): MembershipCapabilitiesView {
  const role = normalizeCompanyRole(row.role)
  const effective = mergeCompanyCapabilities(role, granted)
  return {
    membership_id: row.id,
    clerk_user_id: row.clerk_user_id,
    role,
    role_default: sortCaps(defaultCompanyCapabilities(role)),
    granted: sortCaps(granted),
    effective: sortCaps(effective),
  }
}

/**
 * Read a membership's effective company capabilities. Company-scoped via the
 * GUC the caller already set (or the bare pool for the GET). Pure read.
 */
export async function readMembershipCapabilitiesTx(
  client: QueryExecutor,
  args: { companyId: string; membershipId: string },
): Promise<MembershipCapabilitiesView> {
  const membership = await loadMembership(client, args.companyId, args.membershipId, false)
  const granted = await selectFieldRequestGrants(client, args.companyId, membership.custom_role_id)
  return membershipCapabilitiesView(membership, granted)
}

/**
 * Ensure a membership has a custom role to hang additive grants on. If it
 * already has one, return it; otherwise mint a per-member role inheriting the
 * member's current builtin base and link it. Returns the custom_role_id.
 */
async function ensureMembershipCustomRole(
  client: QueryExecutor,
  args: { companyId: string; membership: MembershipRow; actorUserId: string },
): Promise<string> {
  if (args.membership.custom_role_id) return args.membership.custom_role_id

  const inheritFrom = companyRoleToBuiltin(normalizeCompanyRole(args.membership.role))
  // Per-member role name keyed on the membership id so re-grants are stable and
  // the name uniqueness (custom_roles unique (company_id, name)) never collides.
  const name = `caps:${args.membership.id}`
  let roleId: string
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into custom_roles (company_id, name, inherit_from, created_by)
       values ($1, $2, $3, $4)
       returning id`,
      [args.companyId, name, inheritFrom, args.actorUserId],
    )
    const row = inserted.rows[0]
    if (!row) throw new HttpError(500, 'per-member role insert returned no row')
    roleId = row.id
  } catch (err) {
    // A prior grant may have created the per-member role then failed to link;
    // recover by reusing it.
    if (isUniqueViolation(err)) {
      const existing = await client.query<{ id: string }>(
        `select id from custom_roles where company_id = $1 and name = $2 and deleted_at is null limit 1`,
        [args.companyId, name],
      )
      const row = existing.rows[0]
      if (!row) throw err
      roleId = row.id
    } else {
      throw err
    }
  }

  await client.query(`update company_memberships set custom_role_id = $1 where id = $2 and company_id = $3`, [
    roleId,
    args.membership.id,
    args.companyId,
  ])
  args.membership.custom_role_id = roleId
  return roleId
}

/** Grant one field_request.* capability to a membership (idempotent). */
export async function grantMembershipCapabilityTx(
  client: QueryExecutor,
  args: {
    companyId: string
    membershipId: string
    capability: FieldRequestCapability
    actorUserId: string
  },
): Promise<MembershipCapabilitiesView> {
  const membership = await loadMembership(client, args.companyId, args.membershipId, true)

  // A role-default cap is always held — granting it is a no-op (don't litter a
  // redundant custom_role_grants row). Still surface the (unchanged) view.
  const roleDefaults = defaultCompanyCapabilities(normalizeCompanyRole(membership.role))
  if (!(roleDefaults as Set<string>).has(args.capability)) {
    const customRoleId = await ensureMembershipCustomRole(client, {
      companyId: args.companyId,
      membership,
      actorUserId: args.actorUserId,
    })
    // Idempotent insert — the (custom_role_id, action) unique key absorbs a re-grant.
    await client.query(
      `insert into custom_role_grants (custom_role_id, company_id, action, constraints)
       values ($1, $2, $3, null)
       on conflict (custom_role_id, action) do nothing`,
      [customRoleId, args.companyId, args.capability],
    )
    await recordAudit(client, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      entityType: 'company_membership',
      entityId: membership.id,
      action: 'grant_capability',
      after: { id: membership.id, capability: args.capability },
    })
  }

  const granted = await selectFieldRequestGrants(client, args.companyId, membership.custom_role_id)
  return membershipCapabilitiesView(membership, granted)
}

/**
 * Revoke one field_request.* capability from a membership. Only removes an
 * ADDITIVE grant row; a role-default cap can never be revoked (the floor is the
 * system contract), so revoking one is a no-op that still 200s with the view.
 */
export async function revokeMembershipCapabilityTx(
  client: QueryExecutor,
  args: {
    companyId: string
    membershipId: string
    capability: FieldRequestCapability
    actorUserId: string
  },
): Promise<MembershipCapabilitiesView> {
  const membership = await loadMembership(client, args.companyId, args.membershipId, true)

  if (membership.custom_role_id) {
    const deleted = await client.query(
      `delete from custom_role_grants
         where custom_role_id = $1 and company_id = $2 and action = $3`,
      [membership.custom_role_id, args.companyId, args.capability],
    )
    if ((deleted as { rowCount?: number }).rowCount) {
      await recordAudit(client, {
        companyId: args.companyId,
        actorUserId: args.actorUserId,
        entityType: 'company_membership',
        entityId: membership.id,
        action: 'revoke_capability',
        after: { id: membership.id, capability: args.capability },
      })
    }
  }

  const granted = await selectFieldRequestGrants(client, args.companyId, membership.custom_role_id)
  return membershipCapabilitiesView(membership, granted)
}

// ---------------------------------------------------------------------------
// Small SQL helpers
// ---------------------------------------------------------------------------

async function insertGrants(
  client: QueryExecutor,
  companyId: string,
  roleId: string,
  grants: ParsedGrant[],
): Promise<GrantRow[]> {
  const out: GrantRow[] = []
  for (const grant of grants) {
    const inserted = await client.query<GrantRow>(
      `insert into custom_role_grants (custom_role_id, company_id, action, constraints)
       values ($1, $2, $3, $4::jsonb)
       returning id, custom_role_id, action, constraints`,
      [roleId, companyId, grant.action, grant.constraints === null ? null : JSON.stringify(grant.constraints)],
    )
    const row = inserted.rows[0]
    if (row) out.push(row)
  }
  return out
}

async function selectGrants(client: QueryExecutor, companyId: string, roleId: string): Promise<GrantRow[]> {
  const result = await client.query<GrantRow>(
    `select id, custom_role_id, action, constraints from custom_role_grants
       where custom_role_id = $1 and company_id = $2`,
    [roleId, companyId],
  )
  return result.rows
}

const PG_UNIQUE_VIOLATION = '23505'
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleCompanyRoleRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CompanyRoleRouteCtx,
): Promise<boolean> {
  const { pool, userId, sendJson, readBody } = ctx

  const rolesMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/roles$/)
  const roleByIdMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/roles\/([^/]+)$/)
  const assignMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/memberships\/([^/]+)\/role$/)
  const capabilitiesMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/memberships\/([^/]+)\/capabilities$/)
  const capabilityByNameMatch = url.pathname.match(
    /^\/api\/companies\/([^/]+)\/memberships\/([^/]+)\/capabilities\/([^/]+)$/,
  )

  // ---- GET /api/companies/:id/roles → builtins matrix + custom roles --------
  if (req.method === 'GET' && rolesMatch) {
    const companyId = rolesMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const roles = await pool.query<CustomRoleRow>(
      `select id, company_id, name, inherit_from, created_at, created_by
         from custom_roles where company_id = $1 and deleted_at is null
        order by lower(name) asc`,
      [companyId],
    )
    const grants = roles.rows.length
      ? await pool.query<GrantRow>(
          `select id, custom_role_id, action, constraints from custom_role_grants
             where company_id = $1 and custom_role_id = any($2::uuid[])`,
          [companyId, roles.rows.map((r) => r.id)],
        )
      : { rows: [] as GrantRow[] }

    // The company's memberships, so the admin UI can assign per-member roles
    // AND per-member field_request.* capabilities (the opt-in below) without a
    // second round trip / a superadmin endpoint.
    const memberships = await pool.query<MembershipRow>(
      `select id, clerk_user_id, role, custom_role_id from company_memberships
         where company_id = $1 order by role, clerk_user_id`,
      [companyId],
    )

    sendJson(200, {
      builtins: builtinsView(),
      custom: roles.rows.map((r) => customRoleView(r, grants.rows)),
      memberships: memberships.rows.map((m) => ({
        id: m.id,
        clerk_user_id: m.clerk_user_id,
        role: normalizeCompanyRole(m.role),
        custom_role_id: m.custom_role_id,
      })),
    })
    return true
  }

  // ---- POST /api/companies/:id/roles → create a custom role -----------------
  if (req.method === 'POST' && rolesMatch) {
    const companyId = rolesMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(CreateRoleSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    if (!isBuiltinRole(parsed.value.inherit_from)) {
      sendJson(400, { error: 'inherit_from must be a built-in role' })
      return true
    }

    let grants: ParsedGrant[]
    try {
      grants = validateGrants(parsed.value.grants ?? [])
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    try {
      const result = await withMutationTx(companyId, (client) =>
        createCustomRoleTx(client, {
          companyId,
          name: parsed.value.name,
          inheritFrom: parsed.value.inherit_from,
          grants,
          actorUserId: userId,
        }),
      )
      observeAudit('company_role', 'create')
      sendJson(201, { role: customRoleView(result.role, result.grants) })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- PATCH /api/companies/:id/roles/:roleId → rename / replace grants ------
  if (req.method === 'PATCH' && roleByIdMatch) {
    const companyId = roleByIdMatch[1]!
    const roleId = roleByIdMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(PatchRoleSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }

    let grants: ParsedGrant[] | undefined
    try {
      grants = parsed.value.grants !== undefined ? validateGrants(parsed.value.grants) : undefined
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    try {
      const result = await withMutationTx(companyId, (client) =>
        patchCustomRoleTx(client, {
          companyId,
          roleId,
          name: parsed.value.name,
          grants,
          actorUserId: userId,
        }),
      )
      observeAudit('company_role', 'update')
      sendJson(200, { role: customRoleView(result.role, result.grants) })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- DELETE /api/companies/:id/roles/:roleId → soft delete ----------------
  if (req.method === 'DELETE' && roleByIdMatch) {
    const companyId = roleByIdMatch[1]!
    const roleId = roleByIdMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    try {
      const result = await withMutationTx(companyId, (client) =>
        deleteCustomRoleTx(client, { companyId, roleId, actorUserId: userId }),
      )
      observeAudit('company_role', 'delete')
      sendJson(200, { deleted: true, unlinked_memberships: result.unlinked })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- POST /api/companies/:id/memberships/:mId/role → assign ---------------
  if (req.method === 'POST' && assignMatch) {
    const companyId = assignMatch[1]!
    const membershipId = assignMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(AssignRoleSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    // Disallow supplying both at once — the intent is ambiguous.
    if (parsed.value.builtin_role !== undefined && parsed.value.custom_role_id) {
      sendJson(400, { error: 'supply either custom_role_id or builtin_role, not both' })
      return true
    }

    try {
      const result = await withMutationTx(companyId, (client) =>
        assignMembershipRoleTx(client, {
          companyId,
          membershipId,
          customRoleId: parsed.value.custom_role_id ?? null,
          builtinRole: parsed.value.builtin_role,
          actorUserId: userId,
        }),
      )
      observeAudit('company_membership', 'assign_role')
      sendJson(200, { membership: result.membership })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- GET /api/companies/:id/memberships/:mId/capabilities -----------------
  // The membership's effective COMPANY (field_request.*) capabilities: role
  // floor ∪ the additive custom_role_grants opt-in. app_issue.* caps NEVER
  // appear here — those live only on the platform boundary.
  if (req.method === 'GET' && capabilitiesMatch) {
    const companyId = capabilitiesMatch[1]!
    const membershipId = capabilitiesMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    try {
      const view = await readMembershipCapabilitiesTx(pool, { companyId, membershipId })
      sendJson(200, { capabilities: view })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- POST /api/companies/:id/memberships/:mId/capabilities ----------------
  // Grant one field_request.* capability to the membership (idempotent).
  if (req.method === 'POST' && capabilitiesMatch) {
    const companyId = capabilitiesMatch[1]!
    const membershipId = capabilitiesMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(GrantCapabilitySchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }

    try {
      const view = await withMutationTx(companyId, (client) =>
        grantMembershipCapabilityTx(client, {
          companyId,
          membershipId,
          capability: parsed.value.capability,
          actorUserId: userId,
        }),
      )
      observeAudit('company_membership', 'grant_capability')
      sendJson(200, { capabilities: view })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  // ---- DELETE /api/companies/:id/memberships/:mId/capabilities/:capability --
  // Revoke an additive field_request.* grant. A role-default cap can't be
  // revoked (the floor is the system contract) — that's a 200 no-op.
  if (req.method === 'DELETE' && capabilityByNameMatch) {
    const companyId = capabilityByNameMatch[1]!
    const membershipId = capabilityByNameMatch[2]!
    const capabilityRaw = decodeURIComponent(capabilityByNameMatch[3]!)
    if (await blockIfNotAdmin(ctx, companyId)) return true

    if (!isFieldRequestCapability(capabilityRaw)) {
      sendJson(400, { error: 'capability must be a field_request.* capability' })
      return true
    }

    try {
      const view = await withMutationTx(companyId, (client) =>
        revokeMembershipCapabilityTx(client, {
          companyId,
          membershipId,
          capability: capabilityRaw,
          actorUserId: userId,
        }),
      )
      observeAudit('company_membership', 'revoke_capability')
      sendJson(200, { capabilities: view })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  return false
}

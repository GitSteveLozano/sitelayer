import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleCompanyRoleRoutes, type CompanyRoleRouteCtx } from './company-roles.js'

// ---------------------------------------------------------------------------
// Custom-role management API coverage. The admin gate + GET run at ctx.pool;
// the create / patch / delete / assign mutations go through withMutationTx,
// which checks out FakePool.connect() and runs begin / set_config / commit.
// FakePool models custom_roles, custom_role_grants, and company_memberships so
// the transaction bodies execute end-to-end against in-memory rows.
// ---------------------------------------------------------------------------

type CustomRoleRow = {
  id: string
  company_id: string
  name: string
  inherit_from: string
  deleted_at: string | null
  created_at: string
  created_by: string | null
}
type GrantRow = { id: string; custom_role_id: string; company_id: string; action: string; constraints: unknown }
type MembershipRow = {
  id: string
  company_id: string
  clerk_user_id: string
  role: string
  custom_role_id: string | null
}

class FakePool {
  roles: CustomRoleRow[] = []
  grants: GrantRow[] = []
  memberships: MembershipRow[] = []
  audit: Array<{ entityType: string; action: string }> = []
  private seq = 0

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const sql = sqlRaw.trim()

    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // Admin gate / membership lookup
    if (/^select role from company_memberships/i.test(sql)) {
      const [companyId, userId] = params as [string, string]
      const m = this.memberships.find((r) => r.company_id === companyId && r.clerk_user_id === userId)
      return { rows: m ? [{ role: m.role }] : [], rowCount: m ? 1 : 0 }
    }

    // GET list custom_roles
    if (/from custom_roles where company_id = \$1 and deleted_at is null/i.test(sql) && /order by/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.roles
        .filter((r) => r.company_id === companyId && r.deleted_at === null)
        .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
      return { rows, rowCount: rows.length }
    }

    // GET grants for a set of roles (any($2::uuid[]))
    if (/from custom_role_grants/i.test(sql) && /= any\(\$2::uuid\[\]\)/i.test(sql)) {
      const [companyId, roleIds] = params as [string, string[]]
      const rows = this.grants.filter((g) => g.company_id === companyId && roleIds.includes(g.custom_role_id))
      return { rows, rowCount: rows.length }
    }

    // insert custom_roles
    if (/^insert into custom_roles/i.test(sql)) {
      const [companyId, name, inheritFrom, createdBy] = params as [string, string, string, string]
      // Mirror the unique (company_id, lower(name)) where deleted_at is null.
      if (
        this.roles.some(
          (r) => r.company_id === companyId && r.deleted_at === null && r.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        const err = new Error('duplicate key') as Error & { code?: string }
        err.code = '23505'
        throw err
      }
      const row: CustomRoleRow = {
        id: `role-${(this.seq += 1)}`,
        company_id: companyId,
        name,
        inherit_from: inheritFrom,
        deleted_at: null,
        created_at: '2026-06-01T00:00:00.000Z',
        created_by: createdBy,
      }
      this.roles.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // insert custom_role_grants
    if (/^insert into custom_role_grants/i.test(sql)) {
      const [roleId, companyId, action, constraints] = params as [string, string, string, string | null]
      const row: GrantRow = {
        id: `grant-${(this.seq += 1)}`,
        custom_role_id: roleId,
        company_id: companyId,
        action,
        constraints: constraints === null ? null : JSON.parse(constraints),
      }
      this.grants.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // select … for update (PATCH lock)
    if (/from custom_roles where id = \$1 and company_id = \$2 and deleted_at is null/i.test(sql) && /for update/i.test(sql)) {
      const [roleId, companyId] = params as [string, string]
      const row = this.roles.find((r) => r.id === roleId && r.company_id === companyId && r.deleted_at === null)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // assign-role existence check: select id from custom_roles … limit 1
    if (/^select id from custom_roles where id = \$1 and company_id = \$2 and deleted_at is null/i.test(sql)) {
      const [roleId, companyId] = params as [string, string]
      const row = this.roles.find((r) => r.id === roleId && r.company_id === companyId && r.deleted_at === null)
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }

    // update custom_roles set name
    if (/^update custom_roles set name/i.test(sql)) {
      const [name, roleId, companyId] = params as [string, string, string]
      if (
        this.roles.some(
          (r) =>
            r.company_id === companyId &&
            r.deleted_at === null &&
            r.id !== roleId &&
            r.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        const err = new Error('duplicate key') as Error & { code?: string }
        err.code = '23505'
        throw err
      }
      const row = this.roles.find((r) => r.id === roleId && r.company_id === companyId)
      if (!row) return { rows: [], rowCount: 0 }
      row.name = name
      return { rows: [row], rowCount: 1 }
    }

    // delete custom_role_grants (PATCH replace-the-set)
    if (/^delete from custom_role_grants/i.test(sql)) {
      const [roleId, companyId] = params as [string, string]
      this.grants = this.grants.filter((g) => !(g.custom_role_id === roleId && g.company_id === companyId))
      return { rows: [], rowCount: 0 }
    }

    // select grants for one role (PATCH no-grants path)
    if (/from custom_role_grants/i.test(sql) && /custom_role_id = \$1 and company_id = \$2/i.test(sql)) {
      const [roleId, companyId] = params as [string, string]
      const rows = this.grants.filter((g) => g.custom_role_id === roleId && g.company_id === companyId)
      return { rows, rowCount: rows.length }
    }

    // soft delete custom_roles
    if (/^update custom_roles set deleted_at/i.test(sql)) {
      const [roleId, companyId] = params as [string, string]
      const row = this.roles.find((r) => r.id === roleId && r.company_id === companyId && r.deleted_at === null)
      if (!row) return { rows: [], rowCount: 0 }
      row.deleted_at = '2026-06-01T00:00:00.000Z'
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    // null out memberships pointing at a deleted role
    if (/^update company_memberships set custom_role_id = null/i.test(sql)) {
      const [companyId, roleId] = params as [string, string]
      const affected = this.memberships.filter((m) => m.company_id === companyId && m.custom_role_id === roleId)
      for (const m of affected) m.custom_role_id = null
      return { rows: [], rowCount: affected.length }
    }

    // assign: lock membership for update
    if (/^select id, clerk_user_id, role, custom_role_id from company_memberships/i.test(sql) && /for update/i.test(sql)) {
      const [membershipId, companyId] = params as [string, string]
      const m = this.memberships.find((r) => r.id === membershipId && r.company_id === companyId)
      return { rows: m ? [{ id: m.id, clerk_user_id: m.clerk_user_id, role: m.role, custom_role_id: m.custom_role_id }] : [], rowCount: m ? 1 : 0 }
    }

    // assign: update membership role + custom_role_id
    if (/^update company_memberships set role = \$1, custom_role_id = \$2/i.test(sql)) {
      const [role, customRoleId, membershipId, companyId] = params as [string, string | null, string, string]
      const m = this.memberships.find((r) => r.id === membershipId && r.company_id === companyId)
      if (!m) return { rows: [], rowCount: 0 }
      m.role = role
      m.custom_role_id = customRoleId
      return { rows: [{ id: m.id, clerk_user_id: m.clerk_user_id, role: m.role, custom_role_id: m.custom_role_id }], rowCount: 1 }
    }

    if (/^insert into audit_events/i.test(sql)) {
      this.audit.push({ entityType: params[3] as string, action: params[5] as string })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`FakePool: unhandled SQL: ${sql.slice(0, 100)}`)
  }
}

type Captured = { status: number; body: unknown }
function makeCtx(
  pool: FakePool,
  opts: { userId?: string; body?: Record<string, unknown> } = {},
): { ctx: CompanyRoleRouteCtx; captured: Captured[] } {
  const captured: Captured[] = []
  const ctx: CompanyRoleRouteCtx = {
    pool: pool as unknown as Pool,
    userId: opts.userId ?? 'e2e-admin',
    sendJson: (status, body) => captured.push({ status, body }),
    readBody: async () => opts.body ?? {},
  }
  return { ctx, captured }
}

function req(method: string) {
  return { method } as Parameters<typeof handleCompanyRoleRoutes>[0]
}

const ADMIN_POOL = () => {
  const pool = new FakePool()
  pool.memberships.push({ id: 'm-admin', company_id: 'co-1', clerk_user_id: 'e2e-admin', role: 'admin', custom_role_id: null })
  pool.attach()
  return pool
}

const u = (path: string) => new URL(`http://x${path}`)

// ---------------------------------------------------------------------------
// GET — builtins matrix + custom roles
// ---------------------------------------------------------------------------

describe('GET /api/companies/:id/roles', () => {
  it('admin → built-in matrix (5 roles) + custom roles with grants', async () => {
    const pool = ADMIN_POOL()
    pool.roles.push({
      id: 'role-x',
      company_id: 'co-1',
      name: 'Lead Foreman',
      inherit_from: 'foreman',
      deleted_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      created_by: 'e2e-admin',
    })
    pool.grants.push({
      id: 'g1',
      custom_role_id: 'role-x',
      company_id: 'co-1',
      action: 'auth_materials',
      constraints: { max_amount_cents: 100000 },
    })
    const { ctx, captured } = makeCtx(pool)
    const handled = await handleCompanyRoleRoutes(req('GET'), u('/api/companies/co-1/roles'), ctx)
    expect(handled).toBe(true)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]?.body as {
      builtins: Array<{ role: string; actions: string[] }>
      custom: Array<{ name: string; inherit_from: string; grants: Array<{ action: string; constraints: unknown }> }>
    }
    expect(body.builtins.map((b) => b.role).sort()).toEqual(['bookkeeper', 'crew', 'estimator', 'foreman', 'owner'])
    expect(body.builtins.find((b) => b.role === 'owner')?.actions).toContain('auth_materials')
    expect(body.custom).toHaveLength(1)
    expect(body.custom[0]?.name).toBe('Lead Foreman')
    expect(body.custom[0]?.grants[0]).toEqual({ action: 'auth_materials', constraints: { max_amount_cents: 100000 } })
  })

  it('non-admin → 403', async () => {
    const pool = ADMIN_POOL()
    pool.memberships.push({ id: 'm-mem', company_id: 'co-1', clerk_user_id: 'e2e-member', role: 'member', custom_role_id: null })
    const { ctx, captured } = makeCtx(pool, { userId: 'e2e-member' })
    await handleCompanyRoleRoutes(req('GET'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST — create + validation
// ---------------------------------------------------------------------------

describe('POST /api/companies/:id/roles — create', () => {
  it('admin creates a role with a capped auth_materials grant → 201 + audit', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: {
        name: 'Buyer',
        inherit_from: 'estimator',
        grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 50000 } }],
      },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(201)
    const body = captured[0]?.body as { role: { id: string; name: string; inherit_from: string; grants: unknown[] } }
    expect(body.role.name).toBe('Buyer')
    expect(body.role.inherit_from).toBe('estimator')
    expect(body.role.grants).toEqual([{ action: 'auth_materials', constraints: { max_amount_cents: 50000 } }])
    expect(pool.roles).toHaveLength(1)
    expect(pool.grants).toHaveLength(1)
    expect(pool.audit.some((a) => a.entityType === 'company_role' && a.action === 'create')).toBe(true)
  })

  it('uncapped grant (no constraints) → 201, constraints null', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'Promoter', inherit_from: 'crew', grants: [{ action: 'create_project' }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(201)
    expect(pool.grants[0]?.constraints).toBeNull()
  })

  it('non-admin → 403, no row', async () => {
    const pool = ADMIN_POOL()
    pool.memberships.push({ id: 'm-mem', company_id: 'co-1', clerk_user_id: 'e2e-member', role: 'member', custom_role_id: null })
    const { ctx, captured } = makeCtx(pool, { userId: 'e2e-member', body: { name: 'X', inherit_from: 'crew' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(403)
    expect(pool.roles).toHaveLength(0)
  })

  it('unknown action → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'X', inherit_from: 'crew', grants: [{ action: 'nuke_everything' }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect(pool.roles).toHaveLength(0)
  })

  it('bad inherit_from → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { name: 'X', inherit_from: 'wizard' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('constraint on a non-constrainable action → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'X', inherit_from: 'crew', grants: [{ action: 'create_project', constraints: { max_amount_cents: 1000 } }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect((captured[0]?.body as { error: string }).error).toMatch(/not constrainable/)
    expect(pool.roles).toHaveLength(0)
  })

  it('wrong constraint key for a constrainable action → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'X', inherit_from: 'estimator', grants: [{ action: 'auth_materials', constraints: { max_ot_hours_per_week: 5 } }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect((captured[0]?.body as { error: string }).error).toMatch(/max_amount_cents/)
  })

  it('negative cap → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'X', inherit_from: 'estimator', grants: [{ action: 'auth_materials', constraints: { max_amount_cents: -100 } }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect((captured[0]?.body as { error: string }).error).toMatch(/non-negative/)
  })

  it('non-integer cap → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'X', inherit_from: 'estimator', grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 12.5 } }] },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect((captured[0]?.body as { error: string }).error).toMatch(/integer/)
  })

  it('duplicate grant action → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      body: {
        name: 'X',
        inherit_from: 'crew',
        grants: [{ action: 'create_project' }, { action: 'create_project' }],
      },
    })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(400)
    expect((captured[0]?.body as { error: string }).error).toMatch(/duplicate/)
  })

  it('duplicate role name (23505) → 409', async () => {
    const pool = ADMIN_POOL()
    pool.roles.push({
      id: 'role-dup',
      company_id: 'co-1',
      name: 'Buyer',
      inherit_from: 'estimator',
      deleted_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      created_by: 'e2e-admin',
    })
    const { ctx, captured } = makeCtx(pool, { body: { name: 'buyer', inherit_from: 'estimator' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/roles'), ctx)
    expect(captured[0]?.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// PATCH — rename / replace grants
// ---------------------------------------------------------------------------

describe('PATCH /api/companies/:id/roles/:roleId', () => {
  const seedRole = (pool: FakePool) => {
    pool.roles.push({
      id: 'role-1',
      company_id: 'co-1',
      name: 'Buyer',
      inherit_from: 'estimator',
      deleted_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      created_by: 'e2e-admin',
    })
    pool.grants.push({ id: 'g-old', custom_role_id: 'role-1', company_id: 'co-1', action: 'create_project', constraints: null })
  }

  it('rename + replace grants → 200, old grant gone, audit', async () => {
    const pool = ADMIN_POOL()
    seedRole(pool)
    const { ctx, captured } = makeCtx(pool, {
      body: { name: 'Senior Buyer', grants: [{ action: 'auth_materials', constraints: { max_amount_cents: 25000 } }] },
    })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]?.body as { role: { name: string; grants: Array<{ action: string }> } }
    expect(body.role.name).toBe('Senior Buyer')
    expect(body.role.grants).toEqual([{ action: 'auth_materials', constraints: { max_amount_cents: 25000 } }])
    expect(pool.grants.map((g) => g.action)).toEqual(['auth_materials'])
    expect(pool.audit.some((a) => a.entityType === 'company_role' && a.action === 'update')).toBe(true)
  })

  it('rename only (no grants key) leaves grants intact', async () => {
    const pool = ADMIN_POOL()
    seedRole(pool)
    const { ctx, captured } = makeCtx(pool, { body: { name: 'Renamed' } })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]?.body as { role: { name: string; grants: unknown[] } }
    expect(body.role.name).toBe('Renamed')
    expect(body.role.grants).toHaveLength(1)
    expect(pool.grants).toHaveLength(1)
  })

  it('empty grants array clears all grants', async () => {
    const pool = ADMIN_POOL()
    seedRole(pool)
    const { ctx, captured } = makeCtx(pool, { body: { grants: [] } })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(200)
    expect(pool.grants).toHaveLength(0)
  })

  it('unknown role → 404', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { name: 'X' } })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/nope'), ctx)
    expect(captured[0]?.status).toBe(404)
  })

  it('empty body → 400', async () => {
    const pool = ADMIN_POOL()
    seedRole(pool)
    const { ctx, captured } = makeCtx(pool, { body: {} })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('invalid constraint in replacement grants → 400, no mutation', async () => {
    const pool = ADMIN_POOL()
    seedRole(pool)
    const { ctx, captured } = makeCtx(pool, {
      body: { grants: [{ action: 'brief_crew', constraints: { max_amount_cents: 1 } }] },
    })
    await handleCompanyRoleRoutes(req('PATCH'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(400)
    // Original grant untouched (validation runs before the tx).
    expect(pool.grants.map((g) => g.action)).toEqual(['create_project'])
  })
})

// ---------------------------------------------------------------------------
// DELETE — soft delete + unlink memberships
// ---------------------------------------------------------------------------

describe('DELETE /api/companies/:id/roles/:roleId', () => {
  it('soft-deletes + nulls memberships pointing at it → 200 with unlink count', async () => {
    const pool = ADMIN_POOL()
    pool.roles.push({
      id: 'role-1',
      company_id: 'co-1',
      name: 'Buyer',
      inherit_from: 'estimator',
      deleted_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      created_by: 'e2e-admin',
    })
    pool.memberships.push({ id: 'm-2', company_id: 'co-1', clerk_user_id: 'u2', role: 'office', custom_role_id: 'role-1' })
    pool.memberships.push({ id: 'm-3', company_id: 'co-1', clerk_user_id: 'u3', role: 'office', custom_role_id: 'role-1' })
    const { ctx, captured } = makeCtx(pool)
    await handleCompanyRoleRoutes(req('DELETE'), u('/api/companies/co-1/roles/role-1'), ctx)
    expect(captured[0]?.status).toBe(200)
    expect((captured[0]?.body as { unlinked_memberships: number }).unlinked_memberships).toBe(2)
    expect(pool.roles[0]?.deleted_at).not.toBeNull()
    expect(pool.memberships.filter((m) => m.custom_role_id === 'role-1')).toHaveLength(0)
    expect(pool.audit.some((a) => a.entityType === 'company_role' && a.action === 'delete')).toBe(true)
  })

  it('unknown / already-deleted role → 404', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool)
    await handleCompanyRoleRoutes(req('DELETE'), u('/api/companies/co-1/roles/nope'), ctx)
    expect(captured[0]?.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST assign — membership role
// ---------------------------------------------------------------------------

describe('POST /api/companies/:id/memberships/:mId/role — assign', () => {
  const seed = (pool: FakePool) => {
    pool.roles.push({
      id: 'role-1',
      company_id: 'co-1',
      name: 'Buyer',
      inherit_from: 'estimator',
      deleted_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      created_by: 'e2e-admin',
    })
    pool.memberships.push({ id: 'm-2', company_id: 'co-1', clerk_user_id: 'u2', role: 'member', custom_role_id: null })
  }

  it('assign custom role → 200, membership.custom_role_id set + audit', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    const { ctx, captured } = makeCtx(pool, { body: { custom_role_id: 'role-1' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-2/role'), ctx)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]?.body as { membership: { custom_role_id: string | null } }
    expect(body.membership.custom_role_id).toBe('role-1')
    expect(pool.memberships.find((m) => m.id === 'm-2')?.custom_role_id).toBe('role-1')
    expect(pool.audit.some((a) => a.entityType === 'company_membership' && a.action === 'assign_role')).toBe(true)
  })

  it('assign builtin_role owner → role=admin, custom_role_id cleared', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    pool.memberships.push({ id: 'm-3', company_id: 'co-1', clerk_user_id: 'u3', role: 'office', custom_role_id: 'role-1' })
    const { ctx, captured } = makeCtx(pool, { body: { builtin_role: 'owner' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-3/role'), ctx)
    expect(captured[0]?.status).toBe(200)
    const m = pool.memberships.find((x) => x.id === 'm-3')
    expect(m?.role).toBe('admin')
    expect(m?.custom_role_id).toBeNull()
  })

  it('clear custom role (custom_role_id: null) keeps raw company role', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    pool.memberships.push({ id: 'm-4', company_id: 'co-1', clerk_user_id: 'u4', role: 'foreman', custom_role_id: 'role-1' })
    const { ctx, captured } = makeCtx(pool, { body: { custom_role_id: null } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-4/role'), ctx)
    expect(captured[0]?.status).toBe(200)
    const m = pool.memberships.find((x) => x.id === 'm-4')
    expect(m?.custom_role_id).toBeNull()
    expect(m?.role).toBe('foreman')
  })

  it('assign a missing custom role → 404', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    const { ctx, captured } = makeCtx(pool, { body: { custom_role_id: 'nope' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-2/role'), ctx)
    expect(captured[0]?.status).toBe(404)
  })

  it('unknown membership → 404', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    const { ctx, captured } = makeCtx(pool, { body: { custom_role_id: 'role-1' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/nope/role'), ctx)
    expect(captured[0]?.status).toBe(404)
  })

  it('both custom_role_id and builtin_role → 400', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    const { ctx, captured } = makeCtx(pool, { body: { custom_role_id: 'role-1', builtin_role: 'owner' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-2/role'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('empty body → 400', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    const { ctx, captured } = makeCtx(pool, { body: {} })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-2/role'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('non-admin → 403', async () => {
    const pool = ADMIN_POOL()
    seed(pool)
    pool.memberships.push({ id: 'm-mem', company_id: 'co-1', clerk_user_id: 'e2e-member', role: 'member', custom_role_id: null })
    const { ctx, captured } = makeCtx(pool, { userId: 'e2e-member', body: { custom_role_id: 'role-1' } })
    await handleCompanyRoleRoutes(req('POST'), u('/api/companies/co-1/memberships/m-2/role'), ctx)
    expect(captured[0]?.status).toBe(403)
  })
})

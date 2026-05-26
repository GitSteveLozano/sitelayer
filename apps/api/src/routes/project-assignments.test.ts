import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleProjectAssignmentRoutes, type ProjectAssignmentRouteCtx } from './project-assignments.js'

/**
 * Tests for the assignment list routes — focused on the new company-wide
 * GET /api/assignments and the assignee name/email resolution that both
 * list routes now do via a LEFT JOIN to the clerk_users mirror.
 *
 * FakePool stubs the SQL fragments the read paths run:
 *   1. select set_config — RLS scoping inside withCompanyClient
 *   2. select … from project_assignments pa left join clerk_users cu …
 *      — the company-wide or per-project list with name resolution.
 *
 * The join is modeled the way Postgres would compute it: assignee_name is
 * the trimmed "first last" (null when both Clerk name parts are absent),
 * assignee_email is the mirror email, and both are null when no live
 * clerk_users row matches (so the client falls back to the clerk_user_id).
 */

type AssignmentRow = {
  id: string
  project_id: string
  clerk_user_id: string
  role: 'foreman' | 'worker'
  assigned_by_clerk_user_id: string | null
  created_at: string
  deleted_at: string | null
}

type ClerkUserRow = {
  clerk_user_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  deleted_at: string | null
}

class FakePool {
  assignments: AssignmentRow[] = []
  clerkUsers: ClerkUserRow[] = []

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => undefined,
    }
  }

  private resolveName(clerkUserId: string): { assignee_name: string | null; assignee_email: string | null } {
    const u = this.clerkUsers.find((r) => r.clerk_user_id === clerkUserId && r.deleted_at === null)
    if (!u) return { assignee_name: null, assignee_email: null }
    const name = [u.first_name, u.last_name]
      .filter((p) => p && p.trim())
      .join(' ')
      .trim()
    return { assignee_name: name === '' ? null : name, assignee_email: u.email }
  }

  private project(row: AssignmentRow) {
    return {
      id: row.id,
      project_id: row.project_id,
      clerk_user_id: row.clerk_user_id,
      role: row.role,
      assigned_by_clerk_user_id: row.assigned_by_clerk_user_id,
      created_at: row.created_at,
      deleted_at: row.deleted_at,
      ...this.resolveName(row.clerk_user_id),
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim()

    if (
      trimmed.startsWith('begin') ||
      trimmed.startsWith('commit') ||
      trimmed.startsWith('rollback') ||
      trimmed.startsWith('select set_config') ||
      trimmed.startsWith('set local')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/from project_assignments pa[\s\S]+left join clerk_users cu/i.test(trimmed)) {
      const companyId = params[0] as string
      void companyId
      const perProject = /pa\.project_id = \$2/.test(trimmed)
      let rows = this.assignments.filter((r) => r.deleted_at === null)
      if (perProject) {
        const projectId = params[1] as string
        rows = rows.filter((r) => r.project_id === projectId)
        rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      } else {
        rows = [...rows].sort((a, b) =>
          a.project_id === b.project_id ? (a.created_at < b.created_at ? -1 : 1) : a.project_id < b.project_id ? -1 : 1,
        )
      }
      return { rows: rows.map((r) => this.project(r)), rowCount: rows.length }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  options: { role?: 'admin' | 'foreman' | 'office' | 'member' | 'bookkeeper' } = {},
): { ctx: ProjectAssignmentRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const role = options.role ?? 'member'
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => ({}),
      sendJson: (status, payload) => {
        responses.push({ status, body: payload })
      },
      getCurrentUserId: () => 'user_caller',
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

type ListBody = {
  assignments: Array<{
    id: string
    project_id: string
    clerk_user_id: string
    role: string
    assignee_name: string | null
    assignee_email: string | null
  }>
}

describe('handleProjectAssignmentRoutes — GET /api/assignments (company-wide)', () => {
  it('returns every project assignment in one query, ordered by project then created_at', async () => {
    const pool = new FakePool()
    pool.assignments.push(
      {
        id: 'a-1',
        project_id: 'p-2',
        clerk_user_id: 'user_b',
        role: 'worker',
        assigned_by_clerk_user_id: null,
        created_at: '2026-05-01T00:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'a-2',
        project_id: 'p-1',
        clerk_user_id: 'user_a',
        role: 'foreman',
        assigned_by_clerk_user_id: null,
        created_at: '2026-05-02T00:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'a-3',
        project_id: 'p-1',
        clerk_user_id: 'user_c',
        role: 'worker',
        assigned_by_clerk_user_id: null,
        created_at: '2026-05-01T00:00:00.000Z',
        deleted_at: null,
      },
    )
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as ListBody
    // p-1 before p-2; within p-1, a-3 (earlier created_at) before a-2.
    expect(body.assignments.map((a) => a.id)).toEqual(['a-3', 'a-2', 'a-1'])
  })

  it('resolves assignee_name and assignee_email from the clerk_users mirror', async () => {
    const pool = new FakePool()
    pool.clerkUsers.push({
      clerk_user_id: 'user_a',
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
      deleted_at: null,
    })
    pool.assignments.push({
      id: 'a-1',
      project_id: 'p-1',
      clerk_user_id: 'user_a',
      role: 'foreman',
      assigned_by_clerk_user_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    const body = responses[0]?.body as ListBody
    expect(body.assignments[0]?.assignee_name).toBe('Jane Doe')
    expect(body.assignments[0]?.assignee_email).toBe('jane@example.com')
  })

  it('leaves assignee_name null when no clerk_users row maps the id (client falls back to the id)', async () => {
    const pool = new FakePool()
    pool.assignments.push({
      id: 'a-1',
      project_id: 'p-1',
      clerk_user_id: 'user_unmapped',
      role: 'worker',
      assigned_by_clerk_user_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    const body = responses[0]?.body as ListBody
    expect(body.assignments[0]?.assignee_name).toBeNull()
    expect(body.assignments[0]?.assignee_email).toBeNull()
    expect(body.assignments[0]?.clerk_user_id).toBe('user_unmapped')
  })

  it('ignores a soft-deleted clerk_users row (treats the identity as unmapped)', async () => {
    const pool = new FakePool()
    pool.clerkUsers.push({
      clerk_user_id: 'user_a',
      email: 'old@example.com',
      first_name: 'Old',
      last_name: 'Name',
      deleted_at: '2026-05-03T00:00:00.000Z',
    })
    pool.assignments.push({
      id: 'a-1',
      project_id: 'p-1',
      clerk_user_id: 'user_a',
      role: 'worker',
      assigned_by_clerk_user_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    const body = responses[0]?.body as ListBody
    expect(body.assignments[0]?.assignee_name).toBeNull()
    expect(body.assignments[0]?.assignee_email).toBeNull()
  })

  it('omits soft-deleted assignments', async () => {
    const pool = new FakePool()
    pool.assignments.push(
      {
        id: 'a-live',
        project_id: 'p-1',
        clerk_user_id: 'user_a',
        role: 'foreman',
        assigned_by_clerk_user_id: null,
        created_at: '2026-05-01T00:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'a-removed',
        project_id: 'p-1',
        clerk_user_id: 'user_b',
        role: 'worker',
        assigned_by_clerk_user_id: null,
        created_at: '2026-05-02T00:00:00.000Z',
        deleted_at: '2026-05-05T00:00:00.000Z',
      },
    )
    const { ctx, responses } = makeCtx(pool)

    await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    const body = responses[0]?.body as ListBody
    expect(body.assignments.map((a) => a.id)).toEqual(['a-live'])
  })

  it('is open to any company member (read is not role-gated)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { role: 'bookkeeper' })

    const handled = await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/assignments'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as ListBody).assignments).toEqual([])
  })
})

describe('handleProjectAssignmentRoutes — GET /api/projects/:id/assignments resolves names too', () => {
  it('includes assignee_name on the per-project list', async () => {
    const pool = new FakePool()
    pool.clerkUsers.push({
      clerk_user_id: 'user_a',
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: null,
      deleted_at: null,
    })
    pool.assignments.push({
      id: 'a-1',
      project_id: 'p-1',
      clerk_user_id: 'user_a',
      role: 'foreman',
      assigned_by_clerk_user_id: null,
      created_at: '2026-05-01T00:00:00.000Z',
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)

    // projectBelongsToCompany runs against pool.query directly — but the
    // per-project GET checks it first. Stub it via the projects lookup.
    pool.query = ((sql: string, params: unknown[] = []) => {
      const t = sql.trim()
      if (/from projects where company_id/i.test(t)) {
        return Promise.resolve({ rows: [{ id: params[1] }], rowCount: 1 })
      }
      return FakePool.prototype.query.call(pool, sql, params)
    }) as typeof pool.query

    await handleProjectAssignmentRoutes({ method: 'GET' } as never, buildUrl('/api/projects/p-1/assignments'), ctx)
    const body = responses[0]?.body as ListBody
    // last_name null → name is just the first name.
    expect(body.assignments[0]?.assignee_name).toBe('Jane')
  })
})

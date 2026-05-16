import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { handleCompanyRoutes, type CompanyRouteCtx } from './companies.js'

// Route-level coverage for the per-company QBO overtime mapping
// (PATCH /api/companies/:id/settings). The endpoint backs the
// `ot_service_item_code` column added in migration 070 — see
// docker/postgres/init/070_labor_ot_service_item_code.sql.
//
// The fake pool below answers the four query shapes the route runs:
//   1. role lookup on company_memberships
//   2. service_items existence check (validates the code before write)
//   3. companies SELECT for the GET endpoint + the PATCH "before" snapshot
//   4. companies UPDATE for the PATCH
//   5. audit_events INSERT (recordAudit, fires through entityType='company')
//
// Other shapes throw so a regression in the route surfaces as a
// noisy test failure rather than a silent no-op.

type CompanyRow = { id: string; ot_service_item_code: string | null; modules?: Record<string, boolean> }
type ServiceItemRow = { company_id: string; code: string }
type MembershipRow = { company_id: string; clerk_user_id: string; role: string }

class FakePool {
  companies: CompanyRow[] = []
  serviceItems: ServiceItemRow[] = []
  memberships: MembershipRow[] = []
  audit: Array<{ entityType: string; action: string; before: unknown; after: unknown }> = []

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim()

    if (/^select role from company_memberships/i.test(trimmed)) {
      const [companyId, userId] = params as [string, string]
      const m = this.memberships.find((r) => r.company_id === companyId && r.clerk_user_id === userId)
      return { rows: m ? [{ role: m.role }] : [], rowCount: m ? 1 : 0 }
    }

    if (/^select code from service_items/i.test(trimmed)) {
      const [companyId, code] = params as [string, string]
      const r = this.serviceItems.find((x) => x.company_id === companyId && x.code === code)
      return { rows: r ? [{ code: r.code }] : [], rowCount: r ? 1 : 0 }
    }

    if (/^select ot_service_item_code from companies/i.test(trimmed)) {
      const [id] = params as [string]
      const c = this.companies.find((x) => x.id === id)
      return {
        rows: c ? [{ ot_service_item_code: c.ot_service_item_code }] : [],
        rowCount: c ? 1 : 0,
      }
    }

    if (/^update companies set ot_service_item_code/i.test(trimmed)) {
      const [id, code] = params as [string, string | null]
      const c = this.companies.find((x) => x.id === id)
      if (!c) return { rows: [], rowCount: 0 }
      c.ot_service_item_code = code
      return { rows: [{ ot_service_item_code: c.ot_service_item_code }], rowCount: 1 }
    }

    if (/^\s*insert into audit_events/i.test(trimmed)) {
      const [, , , entityType, , action, beforeJson, afterJson] = params as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
      ]
      this.audit.push({
        entityType,
        action,
        before: beforeJson ? JSON.parse(beforeJson) : null,
        after: afterJson ? JSON.parse(afterJson) : null,
      })
      return { rows: [], rowCount: 0 }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  userId = 'user_admin',
  body: Record<string, unknown> = {},
): {
  ctx: CompanyRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      userId,
      sendJson: (status, b) => {
        responses.push({ status, body: b })
      },
      readBody: async () => body,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function seedAdmin(pool: FakePool, companyId = 'co-1', userId = 'user_admin', code: string | null = null) {
  pool.companies.push({ id: companyId, ot_service_item_code: code })
  pool.memberships.push({ company_id: companyId, clerk_user_id: userId, role: 'admin' })
}

describe('PATCH /api/companies/:id/settings — ot_service_item_code', () => {
  it('accepts a valid service_items.code and persists it', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    pool.serviceItems.push({ company_id: 'co-1', code: 'LBR-OT' })
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 'LBR-OT' })

    const handled = await handleCompanyRoutes(
      { method: 'PATCH' } as never,
      buildUrl('/api/companies/co-1/settings'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: 'LBR-OT' })
    expect(pool.companies[0]?.ot_service_item_code).toBe('LBR-OT')
    expect(pool.audit[0]?.entityType).toBe('company')
    expect(pool.audit[0]?.action).toBe('update_settings')
  })

  it('accepts null to clear the OT mapping', async () => {
    const pool = new FakePool()
    seedAdmin(pool, 'co-1', 'user_admin', 'LBR-OT')
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: null })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: null })
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('normalizes empty string to null', async () => {
    const pool = new FakePool()
    seedAdmin(pool, 'co-1', 'user_admin', 'LBR-OT')
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: '' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('rejects an unknown service_items.code with 400', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 'NOPE' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('rejects non-string non-null values with 400', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 42 })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('requires the ot_service_item_code key in the body (400 when omitted)', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', {})

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects non-admin members with 403', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_member', role: 'member' })
    pool.serviceItems.push({ company_id: 'co-1', code: 'LBR-OT' })
    const { ctx, responses } = makeCtx(pool, 'user_member', { ot_service_item_code: 'LBR-OT' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })
})

describe('GET /api/companies/:id/settings', () => {
  it('returns the current ot_service_item_code for any member', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: 'LBR-OT' })
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_member', role: 'member' })
    const { ctx, responses } = makeCtx(pool, 'user_member')

    const handled = await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: 'LBR-OT' })
  })

  it('returns 403 for non-members', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    const { ctx, responses } = makeCtx(pool, 'user_stranger')

    await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(403)
  })
})

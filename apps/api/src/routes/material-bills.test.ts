import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleMaterialBillRoutes, type MaterialBillRouteCtx } from './material-bills.js'
import { makeTestRequirePermission } from './test-require-permission.js'

// ---------------------------------------------------------------------------
// material_bills CRUD — POST also bumps the parent project's version
// inside the same tx. The in-memory pg double mirrors that contract.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type BillRow = {
  id: string
  company_id: string
  project_id: string
  vendor_name: string
  amount: number
  bill_type: string
  description: string | null
  occurred_on: string | null
  version: number
  deleted_at: string | null
  created_at: string
}

class FakePool {
  projects: Row[] = []
  bills: BillRow[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []
  private nextBillId = 1

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

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // List per-project
    if (/^select id, project_id, vendor_name as vendor/i.test(sql) && /from material_bills/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.bills.filter((b) => b.company_id === companyId && b.project_id === projectId && !b.deleted_at)
      return { rows, rowCount: rows.length }
    }

    // Pre-create project-version check
    if (/^select version from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [{ version: project.version }] : [], rowCount: project ? 1 : 0 }
    }

    // Insert
    if (/^\s*insert into material_bills/i.test(sql)) {
      const [companyId, projectId, vendor, amount, billType, description, occurredOn] = params as [
        string,
        string,
        string,
        number,
        string,
        string | null,
        string | null,
      ]
      const row: BillRow = {
        id: `bill-${this.nextBillId++}`,
        company_id: companyId,
        project_id: projectId,
        vendor_name: vendor,
        amount,
        bill_type: billType,
        description,
        occurred_on: occurredOn ?? '2026-05-01',
        version: 1,
        deleted_at: null,
        created_at: new Date().toISOString(),
      }
      this.bills.push(row)
      return {
        rows: [{ ...row, vendor: row.vendor_name }],
        rowCount: 1,
      }
    }

    // PATCH update
    if (/^update material_bills/i.test(sql) && /set\s+vendor_name\s*=/i.test(sql)) {
      const [companyId, billId, vendor, amount, billType, description, occurredOn, expectedVersion] = params as [
        string,
        string,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
      ]
      const row = this.bills.find((b) => b.company_id === companyId && b.id === billId && !b.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      if (vendor !== null) row.vendor_name = vendor
      if (amount !== null) row.amount = amount
      if (billType !== null) row.bill_type = billType
      if (description !== null) row.description = description
      if (occurredOn !== null) row.occurred_on = occurredOn
      row.version += 1
      return { rows: [{ ...row, vendor: row.vendor_name }], rowCount: 1 }
    }

    // DELETE soft-delete
    if (/^update material_bills/i.test(sql) && /set deleted_at\s*=\s*now\(\)/i.test(sql)) {
      const [companyId, billId, expectedVersion] = params as [string, string, number | null]
      const row = this.bills.find((b) => b.company_id === companyId && b.id === billId && !b.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      row.deleted_at = new Date().toISOString()
      row.version += 1
      return { rows: [{ ...row, vendor: row.vendor_name }], rowCount: 1 }
    }

    // Parent project version bump
    if (/^update projects set version = version \+ 1/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const p = this.projects.find((pr) => pr.company_id === companyId && pr.id === projectId)
      if (p) p.version = (p.version as number) + 1
      return { rows: [], rowCount: p ? 1 : 0 }
    }

    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        company_id: params[0],
        entity_type: params[3],
        entity_id: params[4],
        mutation_type: params[5],
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.projects.push({
    id: PROJECT_ID,
    company_id: 'co-1',
    version: 1,
    ...overrides,
  })
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): {
  ctx: MaterialBillRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
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
      requirePermission: makeTestRequirePermission(role, responses),
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async (_table, _where, params, expectedVersion) => {
        const billId = params[1] as string
        const row = pool.bills.find((b) => b.id === billId && !b.deleted_at)
        if (!row) return true
        if (expectedVersion != null && row.version !== expectedVersion) {
          responses.push({ status: 409, body: { error: 'version conflict', current_version: row.version } })
          return false
        }
        return true
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleMaterialBillRoutes — GET /api/projects/:id/material-bills', () => {
  it('returns the bills scoped to (company, project)', async () => {
    const pool = new FakePool()
    seedProject(pool)
    pool.bills.push({
      id: 'bill-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      vendor_name: 'Acme',
      amount: 100,
      bill_type: 'material',
      description: null,
      occurred_on: '2026-05-01',
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    // Different project — must not leak
    pool.bills.push({
      id: 'bill-2',
      company_id: 'co-1',
      project_id: '22222222-2222-4222-8222-222222222222',
      vendor_name: 'Other',
      amount: 200,
      bill_type: 'sub',
      description: null,
      occurred_on: '2026-05-01',
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })

    const { ctx, responses } = makeCtx(pool)
    await handleMaterialBillRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { materialBills: Array<{ id: string }> }
    expect(body.materialBills).toHaveLength(1)
    expect(body.materialBills[0]?.id).toBe('bill-1')
  })
})

describe('handleMaterialBillRoutes — POST /api/projects/:id/material-bills', () => {
  it('rejects readers without write role with 403', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeCtx(pool, { vendor: 'Acme', amount: 100, bill_type: 'material' }, 'member')
    await handleMaterialBillRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('400s when vendor/amount/bill_type are missing', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeCtx(pool, { vendor: 'Acme' })
    await handleMaterialBillRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('inserts a bill, bumps the parent project version, and writes a sync_events row', async () => {
    const pool = new FakePool()
    seedProject(pool, { version: 4 })
    const { ctx, responses } = makeCtx(pool, {
      vendor: 'Acme Lumber',
      amount: 250.5,
      bill_type: 'material',
      description: 'studs',
      occurred_on: '2026-05-02',
    })
    await handleMaterialBillRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const created = responses[0]?.body as { id: string; vendor: string; amount: number }
    expect(created.vendor).toBe('Acme Lumber')
    expect(created.amount).toBe(250.5)
    expect(pool.bills).toHaveLength(1)
    // Parent project version bumped.
    expect(pool.projects[0]?.version).toBe(5)
    // Sync ledger row written for material_bill create.
    expect(pool.syncEvents.length).toBeGreaterThan(0)
  })

  it('returns 409 when expected_version disagrees with the project row', async () => {
    const pool = new FakePool()
    seedProject(pool, { version: 7 })
    const { ctx, responses } = makeCtx(pool, {
      vendor: 'Acme',
      amount: 1,
      bill_type: 'material',
      expected_version: 1, // stale
    })
    await handleMaterialBillRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { current_version: number }
    expect(body.current_version).toBe(7)
  })

  it('returns 404 when expected_version is supplied for a project that does not exist', async () => {
    const pool = new FakePool()
    // No project seeded.
    const { ctx, responses } = makeCtx(pool, {
      vendor: 'Acme',
      amount: 1,
      bill_type: 'material',
      expected_version: 1,
    })
    await handleMaterialBillRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/material-bills`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleMaterialBillRoutes — PATCH /api/material-bills/:id', () => {
  it('updates the bill, bumps version, and bumps the parent project version', async () => {
    const pool = new FakePool()
    seedProject(pool, { version: 2 })
    pool.bills.push({
      id: 'bill-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      vendor_name: 'Old Vendor',
      amount: 100,
      bill_type: 'material',
      description: null,
      occurred_on: '2026-05-01',
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { vendor: 'New Vendor', amount: 150 })
    await handleMaterialBillRoutes({ method: 'PATCH' } as never, buildUrl('/api/material-bills/bill-1'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.bills[0]?.vendor_name).toBe('New Vendor')
    expect(pool.bills[0]?.amount).toBe(150)
    expect(pool.bills[0]?.version).toBe(2)
    expect(pool.projects[0]?.version).toBe(3)
  })

  it('returns 404 for an unknown bill', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { vendor: 'x' })
    await handleMaterialBillRoutes({ method: 'PATCH' } as never, buildUrl('/api/material-bills/bill-missing'), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 409 on expected_version mismatch', async () => {
    const pool = new FakePool()
    seedProject(pool)
    pool.bills.push({
      id: 'bill-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      vendor_name: 'V',
      amount: 1,
      bill_type: 'material',
      description: null,
      occurred_on: '2026-05-01',
      version: 5,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { vendor: 'new', expected_version: 1 })
    await handleMaterialBillRoutes({ method: 'PATCH' } as never, buildUrl('/api/material-bills/bill-1'), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})

describe('handleMaterialBillRoutes — DELETE /api/material-bills/:id', () => {
  it('soft-deletes the bill and bumps the parent project version', async () => {
    const pool = new FakePool()
    seedProject(pool, { version: 3 })
    pool.bills.push({
      id: 'bill-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      vendor_name: 'V',
      amount: 1,
      bill_type: 'material',
      description: null,
      occurred_on: '2026-05-01',
      version: 1,
      deleted_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleMaterialBillRoutes({ method: 'DELETE' } as never, buildUrl('/api/material-bills/bill-1'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.bills[0]?.deleted_at).not.toBeNull()
    expect(pool.projects[0]?.version).toBe(4)
  })
})

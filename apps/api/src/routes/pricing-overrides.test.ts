import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handlePricingOverrideRoutes, type PricingOverrideRouteCtx } from './pricing-overrides.js'

// In-memory pg double for the project/customer pricing-override routes. Matches
// the route's SQL by substring (upsert / soft-delete / list) plus the
// recordMutationLedger inserts. Mirrors the stub style of estimate-line-patch.test.ts.

type OverrideRow = {
  id: string
  company_id: string
  scope_id: string
  service_item_code: string
  rate: number
  unit: string
  version: number
  deleted_at: string | null
}

let idSeq = 0

class FakePool {
  rows: OverrideRow[] = []
  syncEvents: unknown[] = []
  outbox: unknown[] = []

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
    if (/^(begin|commit|rollback)/i.test(sql) || /^select set_config/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    // ---- Company scope (company_pricing_overrides) -----------------------
    // No scope-id column/param: insert = [company, code, rate, unit?],
    // update = [company, code], list = [company]. Stored with scope_id = ''.
    if (/^insert into company_pricing_overrides/i.test(sql)) {
      const [companyId, code, rate, explicitUnit] = params as [string, string, number, string | null]
      const existing = this.rows.find(
        (r) => r.company_id === companyId && r.scope_id === '' && r.service_item_code === code,
      )
      if (existing) {
        existing.rate = Number(rate)
        if (explicitUnit) existing.unit = explicitUnit
        existing.deleted_at = null
        existing.version += 1
      } else {
        this.rows.push({
          id: `ovr-${++idSeq}`,
          company_id: companyId,
          scope_id: '',
          service_item_code: code,
          rate: Number(rate),
          unit: explicitUnit ?? 'sqft',
          version: 1,
          deleted_at: null,
        })
      }
      const row = this.rows.find(
        (r) => r.company_id === companyId && r.scope_id === '' && r.service_item_code === code,
      )!
      return {
        rows: [
          {
            id: row.id,
            service_item_code: row.service_item_code,
            rate: row.rate,
            unit: row.unit,
            version: row.version,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      }
    }
    if (/^update company_pricing_overrides/i.test(sql)) {
      const [companyId, code] = params as [string, string]
      const row = this.rows.find(
        (r) => r.company_id === companyId && r.scope_id === '' && r.service_item_code === code && r.deleted_at === null,
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.deleted_at = '2026-01-02T00:00:00.000Z'
      return { rows: [{ id: row.id, service_item_code: row.service_item_code }], rowCount: 1 }
    }
    if (/from company_pricing_overrides/i.test(sql) && /order by service_item_code/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.rows
        .filter((r) => r.company_id === companyId && r.scope_id === '' && r.deleted_at === null)
        .sort((a, b) => a.service_item_code.localeCompare(b.service_item_code))
        .map((r) => ({
          id: r.id,
          service_item_code: r.service_item_code,
          rate: r.rate,
          unit: r.unit,
          version: r.version,
          updated_at: '2026-01-01T00:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }

    // Upsert. Company-scope inserts omit the scope-id column/param, so they
    // carry one fewer positional value — collapse both into a common shape
    // (scope_id = '' for the company rate book) so the row store is uniform.
    if (/^insert into (project|customer)_pricing_overrides/i.test(sql)) {
      const [companyId, scopeId, code, rate, explicitUnit] = params as [string, string, string, number, string | null]
      const existing = this.rows.find(
        (r) => r.company_id === companyId && r.scope_id === scopeId && r.service_item_code === code,
      )
      if (existing) {
        existing.rate = Number(rate)
        if (explicitUnit) existing.unit = explicitUnit
        existing.deleted_at = null
        existing.version += 1
      } else {
        this.rows.push({
          id: `ovr-${++idSeq}`,
          company_id: companyId,
          scope_id: scopeId,
          service_item_code: code,
          rate: Number(rate),
          unit: explicitUnit ?? 'sqft',
          version: 1,
          deleted_at: null,
        })
      }
      const row = this.rows.find(
        (r) => r.company_id === companyId && r.scope_id === scopeId && r.service_item_code === code,
      )!
      return {
        rows: [
          {
            id: row.id,
            service_item_code: row.service_item_code,
            rate: row.rate,
            unit: row.unit,
            version: row.version,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      }
    }

    // Soft-delete
    if (/^update (project|customer)_pricing_overrides/i.test(sql)) {
      const [companyId, scopeId, code] = params as [string, string, string]
      const row = this.rows.find(
        (r) =>
          r.company_id === companyId && r.scope_id === scopeId && r.service_item_code === code && r.deleted_at === null,
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.deleted_at = '2026-01-02T00:00:00.000Z'
      return { rows: [{ id: row.id, service_item_code: row.service_item_code }], rowCount: 1 }
    }

    // List
    if (/from (project|customer)_pricing_overrides/i.test(sql) && /order by service_item_code/i.test(sql)) {
      const [companyId, scopeId] = params as [string, string]
      const rows = this.rows
        .filter((r) => r.company_id === companyId && r.scope_id === scopeId && r.deleted_at === null)
        .sort((a, b) => a.service_item_code.localeCompare(b.service_item_code))
        .map((r) => ({
          id: r.id,
          service_item_code: r.service_item_code,
          rate: r.rate,
          unit: r.unit,
          version: r.version,
          updated_at: '2026-01-01T00:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }

    if (/^insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, opts: { role?: boolean } = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  const ctx: PricingOverrideRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    requireRole: () => opts.role ?? true,
    readBody: async () => (reads.shift() ?? {}) as Record<string, unknown>,
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
  }
  return { ctx, responses, reads }
}

const url = (p: string) => new URL(`http://localhost${p}`)

describe('handlePricingOverrideRoutes', () => {
  it('upserts a project override, then lists it', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'Air Barrier', rate: 6.5, unit: 'sqft' })

    const handled = await handlePricingOverrideRoutes(
      { method: 'PUT' } as never,
      url('/api/projects/p-1/pricing-overrides'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const saved = (responses[0]?.body as { override: { rate: number; version: number } }).override
    expect(saved.rate).toBe(6.5)
    expect(saved.version).toBe(1)

    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    const list = (responses[1]?.body as { overrides: Array<{ service_item_code: string; rate: number }> }).overrides
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ service_item_code: 'Air Barrier', rate: 6.5 })
  })

  it('updates an existing override on conflict (version increments, rate changes)', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'EPS', rate: 4 })
    reads.push({ service_item_code: 'EPS', rate: 5.25 })
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    const second = (responses[1]?.body as { override: { rate: number; version: number } }).override
    expect(second.rate).toBe(5.25)
    expect(second.version).toBe(2)
    expect(pool.rows.filter((r) => r.deleted_at === null)).toHaveLength(1)
  })

  it('soft-deletes an override so the list drops it', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'Basecoat', rate: 2.5 })
    reads.push({ service_item_code: 'Basecoat' })
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'DELETE' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    const list = (responses[2]?.body as { overrides: unknown[] }).overrides
    expect(list).toHaveLength(0)
  })

  it('routes customer-scope overrides to the customer table', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'EPS', rate: 3.75 })
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/customers/c-9/pricing-overrides'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(pool.rows[0]?.scope_id).toBe('c-9')
  })

  it('upserts a company override, lists it, then soft-deletes it', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'Air Barrier', rate: 5.25, unit: 'sqft' })

    const handled = await handlePricingOverrideRoutes(
      { method: 'PUT' } as never,
      url('/api/company/pricing-overrides'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const saved = (responses[0]?.body as { override: { rate: number; version: number } }).override
    expect(saved.rate).toBe(5.25)
    expect(saved.version).toBe(1)
    // Company rows carry no scope id (the tenant root is implicit).
    expect(pool.rows[0]?.scope_id).toBe('')

    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/company/pricing-overrides'), ctx)
    const list = (responses[1]?.body as { overrides: Array<{ service_item_code: string; rate: number }> }).overrides
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ service_item_code: 'Air Barrier', rate: 5.25 })

    reads.push({ service_item_code: 'Air Barrier' })
    await handlePricingOverrideRoutes({ method: 'DELETE' } as never, url('/api/company/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/company/pricing-overrides'), ctx)
    const afterDelete = (responses[3]?.body as { overrides: unknown[] }).overrides
    expect(afterDelete).toHaveLength(0)
  })

  it('updates an existing company override on conflict (version increments)', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'EPS', rate: 4 })
    reads.push({ service_item_code: 'EPS', rate: 6 })
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/company/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/company/pricing-overrides'), ctx)
    const second = (responses[1]?.body as { override: { rate: number; version: number } }).override
    expect(second.rate).toBe(6)
    expect(second.version).toBe(2)
    expect(pool.rows.filter((r) => r.deleted_at === null)).toHaveLength(1)
  })

  it('keeps company and project rate books separate', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ service_item_code: 'EPS', rate: 4 }) // company
    reads.push({ service_item_code: 'EPS', rate: 9 }) // project p-1
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/company/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)

    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/company/pricing-overrides'), ctx)
    const companyList = (responses[2]?.body as { overrides: Array<{ rate: number }> }).overrides
    expect(companyList).toHaveLength(1)
    expect(companyList[0]?.rate).toBe(4)

    await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    const projectList = (responses[3]?.body as { overrides: Array<{ rate: number }> }).overrides
    expect(projectList).toHaveLength(1)
    expect(projectList[0]?.rate).toBe(9)
  })

  it('rejects a missing code or a negative rate', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ rate: 5 })
    reads.push({ service_item_code: 'EPS', rate: -1 })
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    await handlePricingOverrideRoutes({ method: 'PUT' } as never, url('/api/projects/p-1/pricing-overrides'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(responses[1]?.status).toBe(400)
  })

  it('ignores unrelated paths', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    const handled = await handlePricingOverrideRoutes({ method: 'GET' } as never, url('/api/projects/p-1/summary'), ctx)
    expect(handled).toBe(false)
  })
})

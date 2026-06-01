import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleServiceItemRoutes, type ServiceItemRouteCtx } from './service-items.js'
import { makeTestRequirePermission } from './test-require-permission.js'

// In-memory pg double for the /api/service-items routes (U11 — labor_multiplier,
// status, and the rate-history trail). Matches the route's SQL by substring:
// the GET items+history queries, the POST upsert, the PATCH update + prior-rate
// snapshot, the rate-history insert, plus the ledger sync_events / mutation_outbox
// no-ops. Mirrors the stub style of pricing-overrides.test.ts.

type ItemRow = {
  company_id: string
  code: string
  name: string
  category: string
  unit: string
  default_rate: number | null
  source: string
  labor_multiplier: number
  status: string
  version: number
  deleted_at: string | null
}

type RateRow = {
  company_id: string
  service_item_code: string
  rate: number | null
  unit: string
  recorded_at: string
}

let rateSeq = 0

class FakePool {
  items: ItemRow[] = []
  rateHistory: RateRow[] = []

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

    // ---- GET: items list (grouped, with labor_multiplier + status) ---------
    if (/from service_items si/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.items
        .filter((r) => r.company_id === companyId && r.deleted_at === null)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({
          code: r.code,
          name: r.name,
          category: r.category,
          unit: r.unit,
          default_rate: r.default_rate,
          source: r.source,
          version: r.version,
          labor_multiplier: r.labor_multiplier,
          status: r.status,
          divisions: [],
        }))
      return { rows, rowCount: rows.length }
    }

    // ---- GET: per-item rate-history trail ----------------------------------
    if (/from service_item_rate_history/i.test(sql) && /row_number\(\)/i.test(sql)) {
      const [companyId, limit] = params as [string, number]
      const byCode = new Map<string, RateRow[]>()
      for (const r of this.rateHistory.filter((h) => h.company_id === companyId)) {
        const list = byCode.get(r.service_item_code) ?? []
        list.push(r)
        byCode.set(r.service_item_code, list)
      }
      const rows: Array<{ code: string; rate: number | null; unit: string; recorded_at: string }> = []
      for (const [code, list] of [...byCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const recent = [...list].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)).slice(0, Number(limit))
        for (const r of recent) rows.push({ code, rate: r.rate, unit: r.unit, recorded_at: r.recorded_at })
      }
      return { rows, rowCount: rows.length }
    }

    // ---- POST: upsert service item -----------------------------------------
    if (/^insert into service_items/i.test(sql)) {
      const [companyId, code, name, category, unit, defaultRate, source, multiplier, status] = params as [
        string,
        string,
        string,
        string,
        string,
        number | null,
        string | null,
        number | null,
        string | null,
      ]
      const existing = this.items.find((r) => r.company_id === companyId && r.code === code)
      if (existing && existing.deleted_at === null) {
        // Live duplicate: the WHERE deleted_at IS NOT NULL predicate suppresses
        // the UPDATE → no row returned (route maps to 409).
        return { rows: [], rowCount: 0 }
      }
      if (existing) {
        existing.name = name
        existing.category = category
        existing.unit = unit
        existing.default_rate = defaultRate
        existing.source = source ?? 'manual'
        existing.labor_multiplier = multiplier ?? 1.0
        existing.status = status ?? 'active'
        existing.deleted_at = null
        existing.version += 1
        return {
          rows: [{ ...existing, inserted: false }],
          rowCount: 1,
        }
      }
      const row: ItemRow = {
        company_id: companyId,
        code,
        name,
        category,
        unit,
        default_rate: defaultRate,
        source: source ?? 'manual',
        labor_multiplier: multiplier ?? 1.0,
        status: status ?? 'active',
        version: 1,
        deleted_at: null,
      }
      this.items.push(row)
      return { rows: [{ ...row, inserted: true }], rowCount: 1 }
    }

    // service_item_divisions auto-curation (no-op for the test)
    if (/^insert into service_item_divisions/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    // ---- PATCH: prior-rate snapshot ----------------------------------------
    if (/^select default_rate from service_items/i.test(sql)) {
      const [companyId, code] = params as [string, string]
      const row = this.items.find((r) => r.company_id === companyId && r.code === code)
      return { rows: row ? [{ default_rate: row.default_rate }] : [], rowCount: row ? 1 : 0 }
    }

    // ---- PATCH: update service item ----------------------------------------
    if (/^update service_items/i.test(sql) && /default_rate = coalesce/i.test(sql)) {
      const [companyId, code, name, category, unit, defaultRate, multiplier, status, expectedVersion] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        string | null,
        number | null,
      ]
      const row = this.items.find((r) => r.company_id === companyId && r.code === code && r.deleted_at === null)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 }
      if (name != null) row.name = name
      if (category != null) row.category = category
      if (unit != null) row.unit = unit
      if (defaultRate != null) row.default_rate = defaultRate
      if (multiplier != null) row.labor_multiplier = multiplier
      if (status != null) row.status = status
      row.version += 1
      return { rows: [{ ...row }], rowCount: 1 }
    }

    // ---- rate-history insert -----------------------------------------------
    if (/^insert into service_item_rate_history/i.test(sql)) {
      const [companyId, code, rate, unit] = params as [string, string, number | null, string | null]
      rateSeq += 1
      this.rateHistory.push({
        company_id: companyId,
        service_item_code: code,
        rate: rate == null ? null : Number(rate),
        unit: unit ?? 'ea',
        // Monotonic timestamps so ordering is deterministic.
        recorded_at: new Date(Date.UTC(2026, 0, 1, 0, 0, rateSeq)).toISOString(),
      })
      return { rows: [], rowCount: 1 }
    }

    // ledger no-ops
    if (/^insert into sync_events/i.test(sql)) return { rows: [], rowCount: 1 }
    if (/^insert into mutation_outbox/i.test(sql)) return { rows: [], rowCount: 1 }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, opts: { role?: boolean } = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  const ctx: ServiceItemRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    requireRole: () => opts.role ?? true,
    requirePermission: makeTestRequirePermission('admin', responses),
    readBody: async () => (reads.shift() ?? {}) as Record<string, unknown>,
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
    checkVersion: async () => true,
  }
  return { ctx, responses, reads }
}

const url = (p: string) => new URL(`http://localhost${p}`)

describe('handleServiceItemRoutes — pricing detail (U11)', () => {
  it('creates an item, seeds a rate-history row, and GET returns multiplier/status/history', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ code: 'EPS-2', name: 'EPS Board 2"', category: 'material', unit: 'sqft', default_rate: 2.95 })

    await handleServiceItemRoutes({ method: 'POST' } as never, url('/api/service-items'), ctx)
    expect(responses[0]?.status).toBe(201)
    expect(pool.rateHistory).toHaveLength(1)
    expect(pool.rateHistory[0]?.rate).toBe(2.95)

    await handleServiceItemRoutes({ method: 'GET' } as never, url('/api/service-items'), ctx)
    const list = (responses[1]?.body as { serviceItems: Array<Record<string, unknown>> }).serviceItems
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'EPS-2', labor_multiplier: 1.0, status: 'active' })
    expect((list[0]?.rate_history as unknown[]).length).toBe(1)
  })

  it('persists labor_multiplier and status on create', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({
      code: 'EPS-2',
      name: 'EPS Board 2"',
      unit: 'sqft',
      default_rate: 3.45,
      labor_multiplier: 1.25,
      status: 'seasonal',
    })
    await handleServiceItemRoutes({ method: 'POST' } as never, url('/api/service-items'), ctx)
    expect(responses[0]?.status).toBe(201)
    const created = responses[0]?.body as Record<string, unknown>
    expect(created.labor_multiplier).toBe(1.25)
    expect(created.status).toBe('seasonal')
  })

  it('appends a rate-history row only when the cost changes on PATCH', async () => {
    const pool = new FakePool()
    const { ctx, reads } = makeCtx(pool)
    reads.push({ code: 'EPS-2', name: 'EPS Board', unit: 'sqft', default_rate: 2.95 })
    await handleServiceItemRoutes({ method: 'POST' } as never, url('/api/service-items'), ctx)
    expect(pool.rateHistory).toHaveLength(1) // seed

    // Name-only PATCH (no rate change) → no new history row.
    reads.push({ name: 'EPS Board 2 inch', expected_version: 1 })
    await handleServiceItemRoutes({ method: 'PATCH' } as never, url('/api/service-items/EPS-2'), ctx)
    expect(pool.rateHistory).toHaveLength(1)

    // Rate change PATCH → appends one history row.
    reads.push({ default_rate: 3.62, expected_version: 2 })
    await handleServiceItemRoutes({ method: 'PATCH' } as never, url('/api/service-items/EPS-2'), ctx)
    expect(pool.rateHistory).toHaveLength(2)
    expect(pool.rateHistory[1]?.rate).toBe(3.62)
  })

  it('updates status and labor_multiplier via PATCH without touching the rate trail', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ code: 'EPS-2', name: 'EPS Board', unit: 'sqft', default_rate: 3.45 })
    await handleServiceItemRoutes({ method: 'POST' } as never, url('/api/service-items'), ctx)

    reads.push({ status: 'retired', labor_multiplier: 1.5, expected_version: 1 })
    await handleServiceItemRoutes({ method: 'PATCH' } as never, url('/api/service-items/EPS-2'), ctx)
    const patched = responses[1]?.body as Record<string, unknown>
    expect(patched.status).toBe('retired')
    expect(patched.labor_multiplier).toBe(1.5)
    expect(pool.rateHistory).toHaveLength(1) // unchanged — only the create seed
  })

  it('rejects an invalid status with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ code: 'EPS-2', name: 'EPS Board', status: 'discontinued' })
    await handleServiceItemRoutes({ method: 'POST' } as never, url('/api/service-items'), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

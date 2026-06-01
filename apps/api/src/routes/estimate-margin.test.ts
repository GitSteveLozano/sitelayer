import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleEstimateRoutes, type EstimateRouteCtx } from './estimate.js'

// ---------------------------------------------------------------------------
// In-memory pg double for POST /api/projects/:id/estimate/margin. The route
// reads the project cost basis via summarizeProject() then persists
// bid_total + target_margin_pct and reads scope-vs-bid back. We stub only the
// SQL those paths emit (matched by substring). Mirrors the stub style of
// estimate-shares.test.ts; not a general SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

class FakePool {
  project: Row = {
    id: PROJECT_ID,
    company_id: 'co-1',
    customer_id: null,
    name: 'Riverbend',
    customer_name: 'Smith',
    division_code: null,
    status: 'estimating',
    bid_total: 0,
    labor_rate: 50,
    target_sqft_per_hr: 0,
    bonus_pool: 0,
    target_margin_pct: null,
    version: 1,
  }
  laborEntries: Row[] = [] // hours * labor_rate = labor cost
  materialBills: Row[] = [] // { amount, bill_type }
  estimateLines: Row[] = [] // { amount }
  outbox: Row[] = []
  syncEvents: Row[] = []

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

    // summarizeProject project select
    if (/select id, company_id, customer_id, name/i.test(sql) && /from projects/i.test(sql)) {
      return { rows: [this.project], rowCount: 1 }
    }
    // summarizeProject: takeoff_measurements
    if (/from takeoff_measurements/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    // summarizeProject + getScopeVsBid: estimate_lines
    if (/from estimate_lines/i.test(sql)) {
      return { rows: this.estimateLines, rowCount: this.estimateLines.length }
    }
    // summarizeProject: labor_entries
    if (/from labor_entries/i.test(sql)) {
      return { rows: this.laborEntries, rowCount: this.laborEntries.length }
    }
    // summarizeProject: material_bills
    if (/from material_bills/i.test(sql)) {
      return { rows: this.materialBills, rowCount: this.materialBills.length }
    }
    // summarizeProject: bonus_rules
    if (/from bonus_rules/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    // getScopeVsBid project bid_total read
    if (/select bid_total from projects/i.test(sql)) {
      return { rows: [{ bid_total: this.project.bid_total }], rowCount: 1 }
    }
    // resolveDefaultDraftId (takeoff-drafts) — return no draft
    if (/from takeoff_drafts/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    // the margin update
    if (/update projects/i.test(sql) && /set target_margin_pct = \$1/.test(sql)) {
      const [marginPct, bidTotal] = params as [number, number]
      this.project.target_margin_pct = marginPct
      this.project.bid_total = bidTotal
      this.project.version = (this.project.version as number) + 1
      return {
        rows: [{ id: PROJECT_ID, bid_total: bidTotal, version: this.project.version }],
        rowCount: 1,
      }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, body: Record<string, unknown>, overrides: Partial<EstimateRouteCtx> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const ctx: EstimateRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
    currentUserId: 'u-1',
    requireRole: () => true,
    readBody: async () => body,
    sendJson: (status, b) => responses.push({ status, body: b }),
    sendPdf: async () => undefined,
    sendFileContent: () => undefined,
    ...overrides,
  }
  return { ctx, responses }
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('POST /api/projects/:id/estimate/margin (SET_MARGIN reprice)', () => {
  it('reprices bid_total off the cost basis and persists target_margin_pct', async () => {
    const pool = new FakePool()
    // cost basis = labor (2h * $50 = $100) + materials ($500) = $600
    pool.laborEntries = [{ hours: 2 }]
    pool.materialBills = [{ amount: 500, bill_type: 'material' }]
    const { ctx, responses } = makeCtx(pool, { event: 'SET_MARGIN', target_margin_pct: 0.4 })

    const handled = await handleEstimateRoutes(
      { method: 'POST' } as never,
      url(`/api/projects/${PROJECT_ID}/estimate/margin`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { bid_total: number; target_margin_pct: number; cost: number }
    // bid = 600 / (1 - 0.4) = 1000
    expect(body.cost).toBe(600)
    expect(body.bid_total).toBe(1000)
    expect(body.target_margin_pct).toBeCloseTo(0.4, 4)
    // Persisted on the project row.
    expect(pool.project.bid_total).toBe(1000)
    expect(pool.project.target_margin_pct).toBeCloseTo(0.4, 4)
    // Enqueued a set_margin ledger row.
    expect(pool.outbox.some((o) => ((o as { params: unknown[] }).params[5] as string) === 'set_margin')).toBe(true)
  })

  it('rejects a margin outside [0, 1)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'SET_MARGIN', target_margin_pct: 1.5 })
    await handleEstimateRoutes({ method: 'POST' } as never, url(`/api/projects/${PROJECT_ID}/estimate/margin`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects an unsupported event', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'NOPE', target_margin_pct: 0.2 })
    await handleEstimateRoutes({ method: 'POST' } as never, url(`/api/projects/${PROJECT_ID}/estimate/margin`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns a zero bid when there is no cost basis', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'SET_MARGIN', target_margin_pct: 0.3 })
    await handleEstimateRoutes({ method: 'POST' } as never, url(`/api/projects/${PROJECT_ID}/estimate/margin`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { bid_total: number; cost: number }
    expect(body.cost).toBe(0)
    expect(body.bid_total).toBe(0)
  })
})

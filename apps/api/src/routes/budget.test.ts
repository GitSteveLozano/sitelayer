import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleBudgetRoutes, type BudgetRouteCtx } from './budget.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const SNAP_ID = '33333333-3333-4333-8333-333333333333'

interface FakeState {
  projectExists: boolean
  // estimate_lines rolled up by service_item_code → { material, labor, qty, unit, division }
  estimateRollup: Array<{
    service_item_code: string
    division_code: string | null
    unit: string
    qty: string
    material_amount: string
    labor_amount: string
  }>
  // existing max version (0 = no prior freeze)
  maxVersion: number
  // latest snapshot for variance read (null = not frozen)
  latestSnapshot: Record<string, unknown> | null
  budgetLines: Array<Record<string, unknown>>
  laborActuals: Array<{ service_item_code: string; labor_cents: string }>
  materialActualCents: string
}

/**
 * Fake pool that satisfies withMutationTx (begin / set_config / commit) +
 * withCompanyClient (begin read only / set_config / commit) and answers each
 * query the budget route issues, matched by a SQL fragment. Records the
 * inserts so the test can assert the frozen split + immutability (a re-freeze
 * never UPDATEs an existing snapshot — it only ever INSERTs a new version).
 */
class FakePool {
  state: FakeState = {
    projectExists: true,
    estimateRollup: [],
    maxVersion: 0,
    latestSnapshot: null,
    budgetLines: [],
    laborActuals: [],
    materialActualCents: '0',
  }

  insertedSnapshots: Array<Record<string, unknown>> = []
  insertedLines: Array<Record<string, unknown>> = []
  sawUpdateOrDelete = false

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim().toLowerCase()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('update ') || sql.startsWith('delete ')) {
      this.sawUpdateOrDelete = true
      throw new Error('budget route must never UPDATE/DELETE a snapshot')
    }

    // project existence guard
    if (sql.includes('from projects') && sql.includes('select id') && !sql.includes('labor_entries')) {
      return { rows: this.state.projectExists ? [{ id: PROJECT_ID }] : [], rowCount: this.state.projectExists ? 1 : 0 }
    }
    // estimate rollup
    if (sql.includes('from estimate_lines')) {
      return { rows: this.state.estimateRollup, rowCount: this.state.estimateRollup.length }
    }
    // next version
    if (sql.includes('coalesce(max(version)')) {
      return { rows: [{ next_version: this.state.maxVersion + 1 }], rowCount: 1 }
    }
    // snapshot header insert
    if (sql.startsWith('insert into budget_snapshots')) {
      const version = Number(params[2])
      const row = {
        id: SNAP_ID,
        company_id: COMPANY_ID,
        project_id: PROJECT_ID,
        version,
        frozen_at: '2026-06-02T00:00:00Z',
        frozen_by: String(params[3] ?? ''),
        note: (params[4] as string | null) ?? null,
        material_total: String(params[5]),
        labor_total: String(params[6]),
        budget_total: String(params[7]),
        created_at: '2026-06-02T00:00:00Z',
      }
      this.insertedSnapshots.push(row)
      return { rows: [row], rowCount: 1 }
    }
    // snapshot line insert
    if (sql.startsWith('insert into budget_snapshot_lines')) {
      const row = {
        id: `line-${this.insertedLines.length + 1}`,
        cost_code: (params[2] as string | null) ?? null,
        division_code: (params[3] as string | null) ?? null,
        service_item_code: String(params[4]),
        qty: String(params[5]),
        unit: String(params[6]),
        material_amount: String(params[7]),
        labor_amount: String(params[8]),
      }
      this.insertedLines.push(row)
      return { rows: [row], rowCount: 1 }
    }
    // ledger writes (sync_events / mutation_outbox)
    if (sql.startsWith('insert into sync_events') || sql.startsWith('insert into mutation_outbox')) {
      return { rows: [], rowCount: 1 }
    }

    // variance reads ---------------------------------------------------------
    if (sql.includes('from budget_snapshots')) {
      const rows = this.state.latestSnapshot ? [this.state.latestSnapshot] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('from budget_snapshot_lines')) {
      return { rows: this.state.budgetLines, rowCount: this.state.budgetLines.length }
    }
    if (sql.includes('from labor_entries')) {
      return { rows: this.state.laborActuals, rowCount: this.state.laborActuals.length }
    }
    if (sql.includes('from material_bills')) {
      return { rows: [{ material_cents: this.state.materialActualCents }], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool): {
  ctx: BudgetRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', role: 'admin', created_at: '' },
      currentUserId: 'user-1',
      requireRole: () => true,
      readBody: async () => ({}),
      sendJson: (status, body) => responses.push({ status, body }),
    },
  }
}

const buildUrl = (path: string): URL => new URL(`http://localhost${path}`)
const mockReq = (method: string) => ({ method, headers: {} }) as never

describe('handleBudgetRoutes — POST /api/projects/:id/budget/freeze', () => {
  it('rolls estimate_lines up by cost code and freezes an immutable snapshot (material/labor split)', async () => {
    const pool = new FakePool()
    pool.state.estimateRollup = [
      // material line + labor line for the same code already split by the SQL
      {
        service_item_code: 'PNT-100',
        division_code: 'D1',
        unit: 'sqft',
        qty: '120',
        material_amount: '600',
        labor_amount: '400',
      },
      {
        service_item_code: 'DRY-200',
        division_code: 'D2',
        unit: 'lf',
        qty: '50',
        material_amount: '250',
        labor_amount: '0',
      },
    ]
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleBudgetRoutes(
      mockReq('POST'),
      buildUrl(`/api/projects/${PROJECT_ID}/budget/freeze`),
      ctx,
    )

    expect(handled).toBe(true)
    expect(pool.sawUpdateOrDelete).toBe(false) // immutable: insert-only
    const res = responses[0]!
    expect(res.status).toBe(201)
    const body = res.body as { snapshot: Record<string, unknown>; lines: unknown[] }
    expect(body.snapshot.version).toBe(1)
    expect(body.snapshot.material_total).toBe('850.00') // 600 + 250
    expect(body.snapshot.labor_total).toBe('400.00')
    expect(body.snapshot.budget_total).toBe('1250.00')
    expect(body.lines).toHaveLength(2)
    // cost_code is populated from division_code
    expect(pool.insertedLines[0]).toMatchObject({
      service_item_code: 'PNT-100',
      cost_code: 'D1',
      labor_amount: '400.00',
    })
  })

  it('re-freeze mints the NEXT version and never mutates the prior snapshot', async () => {
    const pool = new FakePool()
    pool.state.maxVersion = 1 // a v1 snapshot already exists
    pool.state.estimateRollup = [
      {
        service_item_code: 'PNT-100',
        division_code: 'D1',
        unit: 'sqft',
        qty: '140',
        material_amount: '700',
        labor_amount: '500',
      },
    ]
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/budget/freeze`), ctx)

    expect(pool.sawUpdateOrDelete).toBe(false)
    const body = responses[0]!.body as { snapshot: Record<string, unknown> }
    expect(body.snapshot.version).toBe(2) // change-order freeze → new version
  })

  it('400s when there are no estimate lines to freeze', async () => {
    const pool = new FakePool()
    pool.state.estimateRollup = []
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/budget/freeze`), ctx)

    expect(responses[0]).toEqual({
      status: 400,
      body: { error: 'no estimate lines to freeze — recompute the estimate first' },
    })
  })

  it('404s when the project is not in the company scope', async () => {
    const pool = new FakePool()
    pool.state.projectExists = false
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('POST'), buildUrl(`/api/projects/${PROJECT_ID}/budget/freeze`), ctx)

    expect(responses[0]).toEqual({ status: 404, body: { error: 'project not found' } })
  })

  it('400s on a non-uuid project id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('POST'), buildUrl('/api/projects/not-a-uuid/budget/freeze'), ctx)

    expect(responses[0]).toEqual({ status: 400, body: { error: 'project id must be a valid uuid' } })
  })
})

describe('handleBudgetRoutes — GET /api/projects/:id/budget/variance', () => {
  it('reports frozen:false with live material actuals when no snapshot exists', async () => {
    const pool = new FakePool()
    pool.state.latestSnapshot = null
    pool.state.materialActualCents = '12345'
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('GET'), buildUrl(`/api/projects/${PROJECT_ID}/budget/variance`), ctx)

    const body = responses[0]!.body as { frozen: boolean; cost_codes: unknown[]; summary: Record<string, number> }
    expect(responses[0]!.status).toBe(200)
    expect(body.frozen).toBe(false)
    expect(body.cost_codes).toEqual([])
    expect(body.summary.actual_total_cents).toBe(12345)
  })

  it('merges frozen BUDGET vs ACTUALS per cost code with ordinal confidence', async () => {
    const pool = new FakePool()
    pool.state.latestSnapshot = {
      id: SNAP_ID,
      company_id: COMPANY_ID,
      project_id: PROJECT_ID,
      version: 1,
      frozen_at: '2026-06-01T00:00:00Z',
      frozen_by: 'user-1',
      note: null,
      material_total: '850.00',
      labor_total: '400.00',
      budget_total: '1250.00',
      created_at: '2026-06-01T00:00:00Z',
    }
    pool.state.budgetLines = [
      {
        id: 'l1',
        cost_code: 'D1',
        division_code: 'D1',
        service_item_code: 'PNT-100',
        qty: '120',
        unit: 'sqft',
        material_amount: '600.00',
        labor_amount: '400.00',
      },
    ]
    // labor actuals: PNT-100 logged $4.50 over budget labor ($400 → $450), plus
    // an off-budget code the estimate never carried.
    pool.state.laborActuals = [
      { service_item_code: 'PNT-100', labor_cents: '45000' },
      { service_item_code: 'EXTRA-9', labor_cents: '5000' },
    ]
    pool.state.materialActualCents = '70000' // $700 material spend (project-level)
    const { ctx, responses } = makeCtx(pool)

    await handleBudgetRoutes(mockReq('GET'), buildUrl(`/api/projects/${PROJECT_ID}/budget/variance`), ctx)

    const body = responses[0]!.body as {
      frozen: boolean
      cost_codes: Array<{
        service_item_code: string
        budget_total_cents: number
        actual_labor_cents: number
        actual_total_cents: number
        variance_cents: number
        confidence: string
      }>
      unallocated_material_cents: number
      summary: { budget_total_cents: number; actual_total_cents: number; variance_cents: number }
    }
    expect(body.frozen).toBe(true)
    // PNT-100: budget 100000c, actual labor 45000c → variance -55000 (under, since
    // material actuals aren't cost-coded). off-budget EXTRA-9 appended.
    const pnt = body.cost_codes.find((c) => c.service_item_code === 'PNT-100')!
    expect(pnt.budget_total_cents).toBe(100000)
    expect(pnt.actual_total_cents).toBe(45000)
    expect(pnt.variance_cents).toBe(-55000)
    const extra = body.cost_codes.find((c) => c.service_item_code === 'EXTRA-9')!
    expect(extra.budget_total_cents).toBe(0)
    expect(extra.actual_labor_cents).toBe(5000)
    expect(extra.confidence).toBe('low') // pure overage on an unbudgeted code
    // material is project-level
    expect(body.unallocated_material_cents).toBe(70000)
    // summary: budget 125000c; actuals = labor 50000 + material 70000 = 120000;
    // variance = 120000 - 125000 = -5000.
    expect(body.summary.budget_total_cents).toBe(125000)
    expect(body.summary.actual_total_cents).toBe(120000)
    expect(body.summary.variance_cents).toBe(-5000)
  })
})

describe('handleBudgetRoutes — routing', () => {
  it('does not handle unrelated paths or methods', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    const wrongPath = await handleBudgetRoutes(mockReq('GET'), buildUrl(`/api/projects/${PROJECT_ID}/estimate`), ctx)
    const wrongMethod = await handleBudgetRoutes(
      mockReq('DELETE'),
      buildUrl(`/api/projects/${PROJECT_ID}/budget/freeze`),
      ctx,
    )

    expect(wrongPath).toBe(false)
    expect(wrongMethod).toBe(false)
    expect(responses).toEqual([])
  })
})

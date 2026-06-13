import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalContractsRoutes } from './rental-contracts.js'
import type {
  RentalInventoryRouteCtx,
  JobRentalContractRow,
  JobRentalLineRow,
  RentalBillingRunRow,
} from './rental-inventory.types.js'

// ---------------------------------------------------------------------------
// Rental contracts CRUD + the billing-run preview/create path — the live
// customer-money path that materializes a `rental_billing_run` (the row the
// workflow surface in rental-billing-state.ts then transitions and pushes to
// QBO). The WorkflowSnapshot state_version 409 is exercised in
// rental-billing-state.test.ts; this module's own optimistic-concurrency guard
// is the `version`-based PATCH (via patchVersionedEntity → ctx.checkVersion),
// covered below.
//
// Load-bearing assertions:
//   1. POST .../billing-runs/preview returns a computed amount (subtotal +
//      per-line amount) from the deterministic domain calc — no row written.
//   2. POST .../billing-runs persists a rental_billing_runs row (+ its lines)
//      and returns 201.
//   3. PATCH /api/rental-contracts/:id with a stale expected_version 409s via
//      ctx.checkVersion and writes nothing.
//   4. Company-scoping: GET .../rental-contracts only returns the calling
//      company's contracts (the company_id = $1 WHERE).
//
// Mirrors the fake-pool route-test idiom in rental-billing-state.test.ts.
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROJECT_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp'
const LINE_ID = 'llllllll-llll-4lll-8lll-llllllllllll'
const ITEM_ID = 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii'

type Role = 'admin' | 'office' | 'member'

class FakePool {
  contracts: JobRentalContractRow[] = []
  lines: JobRentalLineRow[] = []
  runs: RentalBillingRunRow[] = []
  runLines: Array<Record<string, unknown>> = []
  syncEvents = 0
  outbox = 0
  auditEvents = 0
  // When true, an update to job_rental_contracts (the PATCH path) matches zero
  // rows — simulating a stale optimistic-concurrency version.
  versionConflict = false

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

    // loadProject — select id, customer_id from projects ...
    if (/^select id, customer_id from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const found = this.contracts.some((c) => c.company_id === companyId && c.project_id === projectId)
      if (found || projectId === PROJECT_ID) {
        return { rows: [{ id: projectId, customer_id: 'cust-1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // loadContractBillingData — contract select.
    if (/from job_rental_contracts/i.test(sql) && /^select/i.test(sql)) {
      const [companyId, contractId] = params as [string, string]
      const row = this.contracts.find((c) => c.company_id === companyId && c.id === contractId && !c.deleted_at)
      // GET list path (per-project): where company_id = $1 and project_id = $2
      if (/project_id = \$2/i.test(sql)) {
        const rows = this.contracts.filter(
          (c) => c.company_id === companyId && c.project_id === params[1] && !c.deleted_at,
        )
        return { rows, rowCount: rows.length }
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // loadContractBillingData — lines select (join inventory_items).
    if (/from job_rental_lines l/i.test(sql)) {
      const [companyId, contractId] = params as [string, string]
      const rows = this.lines.filter((l) => l.company_id === companyId && l.contract_id === contractId && !l.deleted_at)
      return { rows, rowCount: rows.length }
    }

    // loadContractBillingData — rate tiers (none seeded).
    if (/from rental_rate_tiers/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    // duplicate-run probe: select 1 from rental_billing_runs ... period_start ...
    if (/^select 1 from rental_billing_runs/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }

    if (/^insert into job_rental_contracts/i.test(sql)) {
      const row = makeContractRow({ id: CONTRACT_ID, company_id: params[0] as string, project_id: params[1] as string })
      this.contracts.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // PATCH update — returns the row unless versionConflict is set.
    if (/^update job_rental_contracts/i.test(sql) && /set\b/i.test(sql) && /customer_id = coalesce/i.test(sql)) {
      if (this.versionConflict) return { rows: [], rowCount: 0 }
      const [companyId, contractId] = params as [string, string]
      const row = this.contracts.find((c) => c.company_id === companyId && c.id === contractId)
      if (!row) return { rows: [], rowCount: 0 }
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    // billing-run create — contract bump (last_billed_through / next_billing_date).
    if (/^update job_rental_contracts/i.test(sql)) {
      const [companyId, contractId] = params as [string, string]
      const row = this.contracts.find((c) => c.company_id === companyId && c.id === contractId)
      if (!row) return { rows: [], rowCount: 0 }
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^insert into rental_billing_runs/i.test(sql)) {
      const row = makeRunRow({
        company_id: params[0] as string,
        contract_id: params[1] as string,
        project_id: params[2] as string,
        customer_id: params[3] as string | null,
        period_start: params[4] as string,
        period_end: params[5] as string,
        subtotal: String(params[6]),
      })
      this.runs.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^insert into rental_billing_run_lines/i.test(sql)) {
      const row: Record<string, unknown> = {
        id: `rl-${this.runLines.length + 1}`,
        company_id: params[0],
        billing_run_id: params[1],
        contract_line_id: params[2],
        inventory_item_id: params[3],
        quantity: params[4],
        agreed_rate: params[5],
        amount: params[10],
        created_at: '2026-06-13T00:00:00.000Z',
      }
      this.runLines.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // job_rental_lines bump after billing.
    if (/^update job_rental_lines/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }

    if (/^insert into sync_events/i.test(sql)) {
      this.syncEvents += 1
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into mutation_outbox/i.test(sql)) {
      this.outbox += 1
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into audit_events/i.test(sql)) {
      this.auditEvents += 1
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeContractRow(overrides: Partial<JobRentalContractRow> = {}): JobRentalContractRow {
  return {
    id: CONTRACT_ID,
    company_id: 'co-a',
    project_id: PROJECT_ID,
    customer_id: 'cust-1',
    billing_cycle_days: 10,
    billing_mode: 'arrears',
    billing_start_date: '2026-05-01',
    last_billed_through: null,
    next_billing_date: '2026-05-11',
    status: 'active',
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeLineRow(overrides: Partial<JobRentalLineRow> = {}): JobRentalLineRow {
  return {
    id: LINE_ID,
    company_id: 'co-a',
    contract_id: CONTRACT_ID,
    inventory_item_id: ITEM_ID,
    item_code: 'SCAF-100',
    item_description: 'Scaffold frame',
    quantity: '1',
    agreed_rate: '10',
    rate_unit: 'day',
    on_rent_date: '2026-05-01',
    off_rent_date: null,
    last_billed_through: null,
    billable: true,
    taxable: true,
    status: 'active',
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeRunRow(overrides: Partial<RentalBillingRunRow> = {}): RentalBillingRunRow {
  return {
    id: 'run-1',
    company_id: 'co-a',
    contract_id: CONTRACT_ID,
    project_id: PROJECT_ID,
    customer_id: 'cust-1',
    period_start: '2026-05-01',
    period_end: '2026-05-10',
    status: 'generated',
    state_version: 1,
    subtotal: '100',
    qbo_invoice_id: null,
    approved_at: null,
    approved_by: null,
    posted_at: null,
    failed_at: null,
    error: null,
    workflow_engine: 'postgres',
    workflow_run_id: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
    ...overrides,
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: Role = 'admin',
  companyId = 'co-a',
  checkVersion: RentalInventoryRouteCtx['checkVersion'] = async () => true,
): { ctx: RentalInventoryRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: companyId, slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if ((allowed as readonly string[]).includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion,
      storage: {} as RentalInventoryRouteCtx['storage'],
      maxMovementPhotoBytes: 25 * 1024 * 1024,
      movementPhotoDownloadPresigned: false,
      sendFileContent: () => {},
      sendFileRedirect: () => {},
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleRentalContractsRoutes — billing-run preview', () => {
  it('returns a computed subtotal + per-line amount without writing a run', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow())
    pool.lines.push(makeLineRow())
    // cycle 10 days from 2026-05-01 → period 05-01..05-10, due 05-11; qty 1 @
    // $10/day * 10 days = $100.
    const { ctx, responses } = makeCtx(pool, { reference_date: '2026-05-20' })
    await handleRentalContractsRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}/billing-runs/preview`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const preview = (responses[0]?.body as { preview: { subtotal: number; is_due: boolean; lines: unknown[] } }).preview
    expect(preview.subtotal).toBe(100)
    expect(preview.is_due).toBe(true)
    expect(preview.lines).toHaveLength(1)
    // preview writes no run.
    expect(pool.runs).toHaveLength(0)
  })

  it('404s for an unknown contract', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { reference_date: '2026-05-20' })
    await handleRentalContractsRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}/billing-runs/preview`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleRentalContractsRoutes — billing-run create', () => {
  it('persists a rental_billing_runs row (+ its lines) and returns 201', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow())
    pool.lines.push(makeLineRow())
    const { ctx, responses } = makeCtx(pool, { reference_date: '2026-05-20' })
    await handleRentalContractsRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}/billing-runs`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.runs).toHaveLength(1)
    expect(pool.runs[0]?.subtotal).toBe('100')
    expect(pool.runLines).toHaveLength(1)
    const body = responses[0]?.body as { billingRun: RentalBillingRunRow; lines: unknown[] }
    expect(body.billingRun.status).toBe('generated')
    expect(body.lines).toHaveLength(1)
  })

  it('rejects a non-admin/office caller with 403 and writes no run', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow())
    pool.lines.push(makeLineRow())
    const { ctx, responses } = makeCtx(pool, { reference_date: '2026-05-20' }, 'member')
    await handleRentalContractsRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}/billing-runs`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
    expect(pool.runs).toHaveLength(0)
  })

  it('400s when the run is not yet due (without force)', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow())
    pool.lines.push(makeLineRow())
    // reference before due date 2026-05-11 → not due.
    const { ctx, responses } = makeCtx(pool, { reference_date: '2026-05-05' })
    await handleRentalContractsRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}/billing-runs`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
    expect(pool.runs).toHaveLength(0)
  })
})

describe('handleRentalContractsRoutes — PATCH optimistic concurrency', () => {
  it('409s on a stale expected_version via ctx.checkVersion and writes nothing', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow({ version: 5 }))
    const responses: Array<{ status: number; body: unknown }> = []
    // The update matches zero rows (stale version); the route then delegates to
    // checkVersion, which — on a real stale version — sends the 409 itself and
    // returns false. We simulate that contract here.
    pool.versionConflict = true
    const { ctx } = makeCtx(pool, { status: 'paused', expected_version: 2 }, 'admin', 'co-a', async () => {
      responses.push({ status: 409, body: { error: 'version conflict' } })
      return false
    })
    // Re-point sendJson at our shared responses array so we observe any 404.
    ctx.sendJson = (status, body) => responses.push({ status, body })
    await handleRentalContractsRoutes(
      { method: 'PATCH' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}`),
      ctx,
    )
    // checkVersion(false) already emitted the 409; the route must NOT also 404.
    expect(responses.find((r) => r.status === 404)).toBeUndefined()
    expect(responses.some((r) => r.status === 409)).toBe(true)
    // version untouched (update matched zero rows).
    expect(pool.contracts[0]?.version).toBe(5)
  })

  it('200s and bumps version on a matching update', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow({ version: 1 }))
    const { ctx, responses } = makeCtx(pool, { status: 'paused', expected_version: 1 })
    await handleRentalContractsRoutes(
      { method: 'PATCH' } as never,
      buildUrl(`/api/rental-contracts/${CONTRACT_ID}`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.contracts[0]?.version).toBe(2)
  })
})

describe('handleRentalContractsRoutes — company-scoping', () => {
  it('GET only returns the calling company contracts', async () => {
    const pool = new FakePool()
    pool.contracts.push(makeContractRow({ company_id: 'co-a' }))
    // A contract owned by another company under the SAME project id.
    pool.contracts.push(makeContractRow({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', company_id: 'co-b' }))
    const { ctx, responses } = makeCtx(pool, {}, 'admin', 'co-b')
    await handleRentalContractsRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/rental-contracts`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const rows = (responses[0]?.body as { rentalContracts: JobRentalContractRow[] }).rentalContracts
    expect(rows).toHaveLength(1)
    expect(rows[0]?.company_id).toBe('co-b')
  })
})

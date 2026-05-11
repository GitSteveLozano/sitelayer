import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleProjectRoutes, type ProjectRouteCtx } from './projects.js'

// ---------------------------------------------------------------------------
// In-memory pg double for the GET /api/projects/:id/closeout snapshot
// endpoint and the POST /api/projects/:id/closeout round-trip. Mirrors the
// pattern in project-lifecycle.test.ts; not a general-purpose SQL emulator.
//
// The POST closeout handler does a `select ... for update`, an `update
// projects ... returning ...`, then a workflow_event_log + sync_events +
// mutation_outbox triple via withMutationTx. After commit it fires a
// best-effort `summarizeProject` rollup to decide whether to enqueue a
// margin-shortfall admin alert; those reads must succeed so the route
// returns 200, but their content is unimportant here.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type EstimateLineRow = {
  company_id: string
  project_id: string
  service_item_code: string
  division_code: string | null
  unit: string
  quantity: number
  amount?: number
}

type LaborEntryRow = {
  company_id: string
  project_id: string
  service_item_code: string
  division_code: string | null
  hours: number
  sqft_done: number
  deleted_at: string | null
}

type MaterialBillRow = {
  company_id: string
  project_id: string
  amount: number
  bill_type: string
  deleted_at: string | null
}

type RentalBillingRunRow = {
  company_id: string
  project_id: string
  subtotal: number
  status: string
  deleted_at: string | null
}

class FakePool {
  projects: Row[] = []
  workflowEvents: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []
  notifications: Row[] = []
  estimateLines: EstimateLineRow[] = []
  laborEntries: LaborEntryRow[] = []
  materialBills: MaterialBillRow[] = []
  rentalBillingRuns: RentalBillingRunRow[] = []

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
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return { rows: [], rowCount: 0 }
    }

    // ---- projects: labor-variance project guard (target_sqft_per_hr only) ----
    if (/select target_sqft_per_hr from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return {
        rows: project ? [{ target_sqft_per_hr: project.target_sqft_per_hr ?? null }] : [],
        rowCount: project ? 1 : 0,
      }
    }

    // ---- projects: closeout-summary project guard (bid_total + labor_rate) ----
    if (/select id, name, bid_total, labor_rate/i.test(sql) && /from\s+projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return {
        rows: project
          ? [
              {
                id: project.id,
                name: project.name,
                bid_total: project.bid_total ?? 0,
                labor_rate: project.labor_rate ?? 0,
              },
            ]
          : [],
        rowCount: project ? 1 : 0,
      }
    }

    // ---- projects: closeout-summary CTE rollup (four per-bucket sub-CTEs
    //      keyed by company_id + project_id). Detected via the
    //      rental_billing_runs reference, which the labor-variance CTE
    //      doesn't touch. ----
    if (/with est as/i.test(sql) && /from rental_billing_runs/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const estimateTotal = this.estimateLines
        .filter((r) => r.company_id === companyId && r.project_id === projectId)
        .reduce((sum, r) => sum + (Number(r.amount ?? 0) || 0), 0)
      const laborHours = this.laborEntries
        .filter((r) => r.company_id === companyId && r.project_id === projectId && !r.deleted_at)
        .reduce((sum, r) => sum + r.hours, 0)
      const materialsTotal = this.materialBills
        .filter((r) => r.company_id === companyId && r.project_id === projectId && !r.deleted_at)
        .reduce((sum, r) => sum + r.amount, 0)
      const rentalsTotal = this.rentalBillingRuns
        .filter(
          (r) => r.company_id === companyId && r.project_id === projectId && !r.deleted_at && r.status === 'posted',
        )
        .reduce((sum, r) => sum + r.subtotal, 0)
      return {
        rows: [
          {
            estimate_total: String(estimateTotal),
            labor_hours: String(laborHours),
            materials_total: String(materialsTotal),
            rentals_total: String(rentalsTotal),
          },
        ],
        rowCount: 1,
      }
    }

    // ---- projects: labor-variance aggregation (FULL OUTER JOIN on
    //      per-service-item-code sums of estimate_lines + labor_entries) ----
    if (/with est as/i.test(sql) && /from estimate_lines/i.test(sql) && /from labor_entries/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const estRows = this.estimateLines.filter((r) => r.company_id === companyId && r.project_id === projectId)
      const actRows = this.laborEntries.filter(
        (r) => r.company_id === companyId && r.project_id === projectId && !r.deleted_at,
      )
      const estByCode = new Map<string, { division_code: string | null; unit: string; estimated_quantity: number }>()
      for (const r of estRows) {
        const bucket = estByCode.get(r.service_item_code) ?? {
          division_code: r.division_code,
          unit: r.unit,
          estimated_quantity: 0,
        }
        bucket.estimated_quantity += r.quantity
        if (r.division_code) bucket.division_code = r.division_code
        if (r.unit) bucket.unit = r.unit
        estByCode.set(r.service_item_code, bucket)
      }
      const actByCode = new Map<
        string,
        { division_code: string | null; actual_quantity: number; actual_hours: number }
      >()
      for (const r of actRows) {
        const bucket = actByCode.get(r.service_item_code) ?? {
          division_code: r.division_code,
          actual_quantity: 0,
          actual_hours: 0,
        }
        bucket.actual_quantity += r.sqft_done
        bucket.actual_hours += r.hours
        if (r.division_code) bucket.division_code = r.division_code
        actByCode.set(r.service_item_code, bucket)
      }
      const codes = new Set<string>([...estByCode.keys(), ...actByCode.keys()])
      const rows: Array<Record<string, unknown>> = []
      for (const code of codes) {
        const e = estByCode.get(code)
        const a = actByCode.get(code)
        rows.push({
          service_item_code: code,
          division_code: e?.division_code ?? a?.division_code ?? null,
          unit: e?.unit ?? null,
          estimated_quantity: String(e?.estimated_quantity ?? 0),
          actual_quantity: String(a?.actual_quantity ?? 0),
          actual_hours: String(a?.actual_hours ?? 0),
        })
      }
      return { rows, rowCount: rows.length }
    }

    // ---- projects: snapshot select (GET handler) ----
    if (/select id, company_id, status, state_version/i.test(sql) && /from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: locking select (POST closeout) ----
    if (
      /select id, status, state_version, closed_at, closed_by, summary_locked_at, version/i.test(sql) &&
      /from projects/i.test(sql)
    ) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: idempotent already-completed read inside the tx ----
    if (
      /select id, customer_id, name, customer_name, division_code, status, bid_total/i.test(sql) &&
      /from projects/i.test(sql) &&
      !/update projects/i.test(sql)
    ) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: update to completed (POST closeout) ----
    if (/^update projects/i.test(sql) && /set\s+status\s*=\s*'completed'/i.test(sql)) {
      // params: [companyId, projectId, expectedVersion, nextStateVersion, closedAt, closedBy]
      const companyId = params[0] as string
      const projectId = params[1] as string
      const expectedVersion = params[2] as number | null
      const nextStateVersion = params[3] as number
      const closedAt = params[4] as string
      const closedBy = params[5] as string
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && project.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
      project.status = 'completed'
      project.state_version = nextStateVersion
      project.closed_at = project.closed_at ?? closedAt
      project.closed_by = project.closed_by ?? closedBy
      project.summary_locked_at = project.summary_locked_at ?? closedAt
      project.version = (project.version as number) + 1
      project.updated_at = new Date().toISOString()
      return { rows: [project], rowCount: 1 }
    }

    // ---- workflow_event_log ----
    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        company_id: params[0],
        workflow_name: params[1],
        schema_version: params[2],
        entity_type: params[3],
        entity_id: params[4],
        state_version: params[5],
        event_type: params[6],
        event_payload: params[7],
        snapshot_after: params[8],
        actor_user_id: params[9],
      })
      return { rows: [], rowCount: 1 }
    }

    // ---- sync_events ----
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    // ---- mutation_outbox ----
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        company_id: params[0],
        device_id: params[1],
        actor_user_id: params[2] ?? null,
        entity_type: params[3],
        entity_id: params[4],
        mutation_type: params[5],
        idempotency_key: params[7],
      })
      return { rows: [], rowCount: 1 }
    }

    // ---- audit_events ----
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    // ---- summarizeProject reads (post-commit margin-alert path) ----
    // Project select for summary (different column set than the snapshot
    // select above) — falls through to here when the snapshot regex
    // doesn't match.
    if (/^select id, company_id, customer_id, name, customer_name, division_code, status, bid_total/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/from takeoff_measurements/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from estimate_lines/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from labor_entries/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from material_bills/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from bonus_rules/i.test(sql)) return { rows: [], rowCount: 0 }

    // ---- listCompanyAdminIds / enqueueNotification (margin-shortfall) ----
    if (/from company_memberships/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/^\s*insert into notifications/i.test(sql)) {
      this.notifications.push({ params })
      return { rows: [{ id: 'notif-1' }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
): {
  ctx: ProjectRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
      currentUserId: 'u-1',
      requireRole: () => true,
      readBody: async () => body,
      sendJson: (status: number, response: unknown) => {
        responses.push({ status, body: response })
      },
      checkVersion: async () => true,
    },
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.projects.push({
    id: PROJECT_ID,
    company_id: 'co-1',
    customer_id: null,
    name: 'Riverbend',
    customer_name: 'Acme Co',
    division_code: 'D4',
    status: 'active',
    state_version: 1,
    bid_total: 1000,
    labor_rate: 0,
    target_sqft_per_hr: null,
    bonus_pool: 0,
    closed_at: null,
    closed_by: null,
    summary_locked_at: null,
    workflow_engine: 'postgres',
    workflow_run_id: null,
    version: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleProjectRoutes — GET /api/projects/:id/closeout', () => {
  it('returns a WorkflowSnapshot with state="active", state_version, and a CLOSEOUT next event for an active project', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleProjectRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/closeout`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const snapshot = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string; label: string }>
      context: { id: string; status: string; closed_at: string | null }
    }
    expect(snapshot.state).toBe('active')
    expect(snapshot.state_version).toBe(1)
    expect(snapshot.next_events).toEqual([{ type: 'CLOSEOUT', label: 'Mark project complete' }])
    expect(snapshot.context.id).toBe(PROJECT_ID)
    expect(snapshot.context.status).toBe('active')
    expect(snapshot.context.closed_at).toBeNull()
  })

  it('returns state="completed" with no next_events when the project is already closed', async () => {
    const pool = new FakePool()
    seedProject(pool, {
      status: 'completed',
      state_version: 2,
      closed_at: '2026-05-01T00:00:00.000Z',
      closed_by: 'u-1',
      summary_locked_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const snapshot = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { closed_at: string | null }
    }
    expect(snapshot.state).toBe('completed')
    expect(snapshot.state_version).toBe(2)
    expect(snapshot.next_events).toEqual([])
    expect(snapshot.context.closed_at).toBe('2026-05-01T00:00:00.000Z')
  })

  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('POST + GET round-trips: state advances from active to completed after a successful closeout', async () => {
    const pool = new FakePool()
    seedProject(pool)

    // 1) GET before — active, version 1.
    const before = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), before.ctx)
    const beforeSnap = before.responses[0]?.body as { state: string; state_version: number }
    expect(beforeSnap.state).toBe('active')
    expect(beforeSnap.state_version).toBe(1)

    // 2) POST closeout.
    const postCtx = makeCtx(pool, {})
    await handleProjectRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/closeout`),
      postCtx.ctx,
    )
    expect(postCtx.responses[0]?.status, JSON.stringify(postCtx.responses[0]?.body)).toBe(200)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('project_closeout')
    expect(pool.workflowEvents[0]?.event_type).toBe('CLOSEOUT')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)

    // 3) GET after — completed, version bumped, no next_events.
    const after = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), after.ctx)
    const afterSnap = after.responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<unknown>
      context: { closed_at: string | null; closed_by: string | null }
    }
    expect(afterSnap.state).toBe('completed')
    expect(afterSnap.state_version).toBe(2)
    expect(afterSnap.next_events).toEqual([])
    expect(afterSnap.context.closed_at).toBeTruthy()
    expect(afterSnap.context.closed_by).toBe('u-1')
  })
})

// ---------------------------------------------------------------------------
// GET /api/projects/:id/labor-variance
// Per-service-item planned-vs-actual rollup. The endpoint hits the
// fake pool through the variance regex above; the route's own filter
// + sort happens in JS after the SQL aggregate. These tests exercise
// that JS path against shaped fixtures.
// ---------------------------------------------------------------------------

type VarianceRow = {
  service_item_code: string
  division_code: string | null
  unit: string
  estimated_quantity: number
  actual_quantity: number
  estimated_hours: number
  actual_hours: number
  quantity_variance_pct: number
  hours_variance_pct: number
}

function seedEstimateLine(
  pool: FakePool,
  overrides: Partial<EstimateLineRow> & {
    service_item_code: string
    quantity: number
  },
) {
  pool.estimateLines.push({
    company_id: 'co-1',
    project_id: PROJECT_ID,
    service_item_code: overrides.service_item_code,
    division_code: overrides.division_code ?? null,
    unit: overrides.unit ?? 'sqft',
    quantity: overrides.quantity,
  })
}

function seedLaborEntry(
  pool: FakePool,
  overrides: Partial<LaborEntryRow> & {
    service_item_code: string
    hours: number
    sqft_done: number
  },
) {
  pool.laborEntries.push({
    company_id: 'co-1',
    project_id: PROJECT_ID,
    service_item_code: overrides.service_item_code,
    division_code: overrides.division_code ?? null,
    hours: overrides.hours,
    sqft_done: overrides.sqft_done,
    deleted_at: overrides.deleted_at ?? null,
  })
}

describe('handleProjectRoutes — GET /api/projects/:id/labor-variance', () => {
  it('returns an empty variance array for a project with no estimate or labor data', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 100 })
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleProjectRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect((responses[0]?.body as { variance: VarianceRow[] }).variance).toEqual([])
  })

  it('computes variance for a code with matching estimate + labor entries', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 100 })
    seedEstimateLine(pool, { service_item_code: 'D4-PAINT', division_code: 'D4', unit: 'sqft', quantity: 1000 })
    seedLaborEntry(pool, { service_item_code: 'D4-PAINT', division_code: 'D4', hours: 12, sqft_done: 1200 })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const variance = (responses[0]?.body as { variance: VarianceRow[] }).variance
    expect(variance).toHaveLength(1)
    const row = variance[0]
    expect(row?.service_item_code).toBe('D4-PAINT')
    expect(row?.division_code).toBe('D4')
    expect(row?.unit).toBe('sqft')
    expect(row?.estimated_quantity).toBe(1000)
    expect(row?.actual_quantity).toBe(1200)
    // 1000 sqft / 100 sqft-per-hr = 10 estimated hours.
    expect(row?.estimated_hours).toBe(10)
    expect(row?.actual_hours).toBe(12)
    // (1200 − 1000) / 1000 × 100 = 20.
    expect(row?.quantity_variance_pct).toBe(20)
    // (12 − 10) / 10 × 100 = 20.
    expect(row?.hours_variance_pct).toBe(20)
  })

  it('returns estimate-only rows with actual=0 and negative variance', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 50 })
    seedEstimateLine(pool, { service_item_code: 'D4-PRIME', division_code: 'D4', unit: 'sqft', quantity: 500 })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    expect(responses[0]?.status).toBe(200)
    const variance = (responses[0]?.body as { variance: VarianceRow[] }).variance
    expect(variance).toHaveLength(1)
    const row = variance[0]
    expect(row?.service_item_code).toBe('D4-PRIME')
    expect(row?.estimated_quantity).toBe(500)
    expect(row?.actual_quantity).toBe(0)
    expect(row?.actual_hours).toBe(0)
    // 500 / 50 = 10 estimated hours; actual 0 ⇒ -100% on both.
    expect(row?.estimated_hours).toBe(10)
    expect(row?.quantity_variance_pct).toBe(-100)
    expect(row?.hours_variance_pct).toBe(-100)
  })

  it('returns labor-only rows (no matching estimate_lines) with estimated_quantity sentinel of 0', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 100 })
    seedLaborEntry(pool, { service_item_code: 'D4-CAULK', division_code: 'D4', hours: 4, sqft_done: 80 })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    expect(responses[0]?.status).toBe(200)
    const variance = (responses[0]?.body as { variance: VarianceRow[] }).variance
    expect(variance).toHaveLength(1)
    const row = variance[0]
    expect(row?.service_item_code).toBe('D4-CAULK')
    expect(row?.estimated_quantity).toBe(0)
    expect(row?.actual_quantity).toBe(80)
    expect(row?.estimated_hours).toBe(0)
    expect(row?.actual_hours).toBe(4)
    // No estimate basis — variance pcts fall through to 0.
    expect(row?.quantity_variance_pct).toBe(0)
    expect(row?.hours_variance_pct).toBe(0)
    // unit is null on the labor-only branch (no estimate_lines row to
    // pull it from); the route normalizes that to empty string.
    expect(row?.unit).toBe('')
  })

  it('does not leak rows from another company (tenant isolation)', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 100 })
    // Belongs to a different company on the same project_id (extremely
    // unlikely with uuids, but the dispatcher guards on company_id so we
    // assert it explicitly).
    pool.estimateLines.push({
      company_id: 'co-other',
      project_id: PROJECT_ID,
      service_item_code: 'D4-PAINT',
      division_code: 'D4',
      unit: 'sqft',
      quantity: 999,
    })
    pool.laborEntries.push({
      company_id: 'co-other',
      project_id: PROJECT_ID,
      service_item_code: 'D4-PAINT',
      division_code: 'D4',
      hours: 50,
      sqft_done: 999,
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { variance: VarianceRow[] }).variance).toEqual([])
  })

  it('sorts worst-offender first by absolute hours_variance_pct', async () => {
    const pool = new FakePool()
    seedProject(pool, { target_sqft_per_hr: 100 })
    // 1000 estimate / 100 = 10 hr est, 11 hr act → +10%.
    seedEstimateLine(pool, { service_item_code: 'A', quantity: 1000 })
    seedLaborEntry(pool, { service_item_code: 'A', hours: 11, sqft_done: 1000 })
    // 1000 estimate / 100 = 10 hr est, 30 hr act → +200%.
    seedEstimateLine(pool, { service_item_code: 'B', quantity: 1000 })
    seedLaborEntry(pool, { service_item_code: 'B', hours: 30, sqft_done: 1000 })
    // 1000 estimate / 100 = 10 hr est, 5 hr act → -50%.
    seedEstimateLine(pool, { service_item_code: 'C', quantity: 1000 })
    seedLaborEntry(pool, { service_item_code: 'C', hours: 5, sqft_done: 1000 })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    const variance = (responses[0]?.body as { variance: VarianceRow[] }).variance
    expect(variance.map((r) => r.service_item_code)).toEqual(['B', 'C', 'A'])
  })

  it('returns 404 when the project does not belong to the current company', async () => {
    const pool = new FakePool()
    // No seedProject call — projects table empty for co-1.
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/labor-variance`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('rejects non-uuid project ids with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/not-a-uuid/labor-variance`), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/projects/:id/closeout-summary
// Bid → actual rollup across labor / materials / rentals + computed margin.
// Single round-trip; the route runs four sub-CTEs and folds them in JS.
// These tests exercise the fold (labor_hours × labor_rate, margin math)
// and the tenant / posted-only filters that the SQL clauses enforce.
// ---------------------------------------------------------------------------

type CloseoutSummaryResponse = {
  project: { id: string; name: string }
  bid: number
  estimate_total: number
  labor_hours: number
  labor_rate: number
  labor_actual: number
  materials_actual: number
  rentals_actual: number
  total_actual: number
  margin: number
  margin_pct: number
}

function seedEstimateLineAmount(
  pool: FakePool,
  overrides: { service_item_code: string; quantity: number; amount: number; unit?: string },
) {
  pool.estimateLines.push({
    company_id: 'co-1',
    project_id: PROJECT_ID,
    service_item_code: overrides.service_item_code,
    division_code: null,
    unit: overrides.unit ?? 'sqft',
    quantity: overrides.quantity,
    amount: overrides.amount,
  })
}

function seedMaterialBill(pool: FakePool, overrides: Partial<MaterialBillRow> & { amount: number }) {
  pool.materialBills.push({
    company_id: 'co-1',
    project_id: PROJECT_ID,
    amount: overrides.amount,
    bill_type: overrides.bill_type ?? 'material',
    deleted_at: overrides.deleted_at ?? null,
  })
}

function seedRentalBillingRun(
  pool: FakePool,
  overrides: Partial<RentalBillingRunRow> & { subtotal: number; status: string },
) {
  pool.rentalBillingRuns.push({
    company_id: 'co-1',
    project_id: PROJECT_ID,
    subtotal: overrides.subtotal,
    status: overrides.status,
    deleted_at: overrides.deleted_at ?? null,
  })
}

describe('handleProjectRoutes — GET /api/projects/:id/closeout-summary', () => {
  it('returns all zeros and 0% margin for an empty project (no bid, no actuals)', async () => {
    const pool = new FakePool()
    seedProject(pool, { bid_total: 0, labor_rate: 0 })
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleProjectRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const body = responses[0]?.body as CloseoutSummaryResponse
    expect(body.bid).toBe(0)
    expect(body.estimate_total).toBe(0)
    expect(body.labor_hours).toBe(0)
    expect(body.labor_actual).toBe(0)
    expect(body.materials_actual).toBe(0)
    expect(body.rentals_actual).toBe(0)
    expect(body.total_actual).toBe(0)
    expect(body.margin).toBe(0)
    expect(body.margin_pct).toBe(0)
  })

  it('computes labor + materials + rentals actuals + margin for a project with each bucket', async () => {
    const pool = new FakePool()
    // bid 10000, labor_rate 50.
    seedProject(pool, { bid_total: 10000, labor_rate: 50 })
    // Estimate baseline: 2 lines summing to 9500.
    seedEstimateLineAmount(pool, { service_item_code: 'A', quantity: 100, amount: 5000 })
    seedEstimateLineAmount(pool, { service_item_code: 'B', quantity: 50, amount: 4500 })
    // Labor: 40 hours × $50/hr = $2000 actual labor.
    pool.laborEntries.push({
      company_id: 'co-1',
      project_id: PROJECT_ID,
      service_item_code: 'A',
      division_code: null,
      hours: 25,
      sqft_done: 0,
      deleted_at: null,
    })
    pool.laborEntries.push({
      company_id: 'co-1',
      project_id: PROJECT_ID,
      service_item_code: 'B',
      division_code: null,
      hours: 15,
      sqft_done: 0,
      deleted_at: null,
    })
    // Materials: $1500 + $250 = $1750.
    seedMaterialBill(pool, { amount: 1500, bill_type: 'material' })
    seedMaterialBill(pool, { amount: 250, bill_type: 'sub' })
    // Rentals: one posted ($800), one generated ($999 — must NOT count).
    seedRentalBillingRun(pool, { subtotal: 800, status: 'posted' })
    seedRentalBillingRun(pool, { subtotal: 999, status: 'generated' })

    const { ctx, responses } = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as CloseoutSummaryResponse
    expect(body.bid).toBe(10000)
    expect(body.estimate_total).toBe(9500)
    expect(body.labor_hours).toBe(40)
    expect(body.labor_rate).toBe(50)
    expect(body.labor_actual).toBe(2000)
    expect(body.materials_actual).toBe(1750)
    expect(body.rentals_actual).toBe(800)
    expect(body.total_actual).toBe(4550)
    expect(body.margin).toBe(5450)
    // 5450 / 10000 = 54.5%.
    expect(body.margin_pct).toBe(54.5)
  })

  it('only counts posted rental_billing_runs (generated / approved / failed / voided excluded)', async () => {
    const pool = new FakePool()
    seedProject(pool, { bid_total: 5000, labor_rate: 0 })
    // One run in every non-posted state — none should count.
    seedRentalBillingRun(pool, { subtotal: 100, status: 'generated' })
    seedRentalBillingRun(pool, { subtotal: 200, status: 'approved' })
    seedRentalBillingRun(pool, { subtotal: 300, status: 'posting' })
    seedRentalBillingRun(pool, { subtotal: 400, status: 'failed' })
    seedRentalBillingRun(pool, { subtotal: 500, status: 'voided' })
    // And one posted that should count.
    seedRentalBillingRun(pool, { subtotal: 750, status: 'posted' })

    const { ctx, responses } = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as CloseoutSummaryResponse
    expect(body.rentals_actual).toBe(750)
    expect(body.total_actual).toBe(750)
    expect(body.margin).toBe(4250)
  })

  it('does not leak rows from another company (tenant isolation)', async () => {
    const pool = new FakePool()
    seedProject(pool, { bid_total: 1000, labor_rate: 0 })
    // All belong to co-other — the route's company_id filter should
    // strip them.
    pool.estimateLines.push({
      company_id: 'co-other',
      project_id: PROJECT_ID,
      service_item_code: 'X',
      division_code: null,
      unit: 'sqft',
      quantity: 100,
      amount: 9999,
    })
    pool.materialBills.push({
      company_id: 'co-other',
      project_id: PROJECT_ID,
      amount: 8888,
      bill_type: 'material',
      deleted_at: null,
    })
    pool.rentalBillingRuns.push({
      company_id: 'co-other',
      project_id: PROJECT_ID,
      subtotal: 7777,
      status: 'posted',
      deleted_at: null,
    })

    const { ctx, responses } = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as CloseoutSummaryResponse
    expect(body.estimate_total).toBe(0)
    expect(body.materials_actual).toBe(0)
    expect(body.rentals_actual).toBe(0)
    expect(body.total_actual).toBe(0)
  })

  it('returns 404 when the project does not belong to the current company', async () => {
    const pool = new FakePool()
    // No seedProject — empty projects table.
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('rejects non-uuid project ids with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/not-a-uuid/closeout-summary`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('skips deleted material bills and labor entries (soft-delete filter)', async () => {
    const pool = new FakePool()
    seedProject(pool, { bid_total: 1000, labor_rate: 100 })
    pool.laborEntries.push({
      company_id: 'co-1',
      project_id: PROJECT_ID,
      service_item_code: 'A',
      division_code: null,
      hours: 5,
      sqft_done: 0,
      deleted_at: '2026-05-01T00:00:00.000Z',
    })
    seedMaterialBill(pool, { amount: 200, bill_type: 'material', deleted_at: '2026-05-01T00:00:00.000Z' })

    const { ctx, responses } = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout-summary`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as CloseoutSummaryResponse
    expect(body.labor_hours).toBe(0)
    expect(body.labor_actual).toBe(0)
    expect(body.materials_actual).toBe(0)
    expect(body.margin).toBe(1000)
    expect(body.margin_pct).toBe(100)
  })
})

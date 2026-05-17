import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalBillingStateRoutes } from './rental-billing-state.js'
import type { RentalInventoryRouteCtx, RentalBillingRunRow } from './rental-inventory.types.js'

// ---------------------------------------------------------------------------
// Rental billing workflow surface — list / snapshot / events. The route is
// the canonical example of the deterministic-workflow pattern; we assert
// the version-conflict guard, the workflow_event_log row, and the
// POST_REQUESTED → mutation_outbox stable-key hand-off to the worker.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  runs: RentalBillingRunRow[] = []
  lines: Array<{
    company_id: string
    billing_run_id: string
    id: string
    contract_line_id: string
    inventory_item_id: string
  }> = []
  workflowEvents: Array<{
    event_type: string
    state_version: number
    entity_id: string
    workflow_name: string
  }> = []
  syncEvents: Row[] = []
  outbox: Array<{
    mutation_type: string
    idempotency_key: string
    entity_type: string
    entity_id: string
  }> = []
  auditEvents: Row[] = []

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

    if (/from rental_billing_runs/i.test(sql) && /where/i.test(sql)) {
      // select for update / select by id / select list
      const [companyId, secondParam] = params as [string, string?]
      if (sql.includes('for update') || /id = \$2/i.test(sql)) {
        const run = this.runs.find((r) => r.company_id === companyId && r.id === secondParam && !r.deleted_at)
        return { rows: run ? [run] : [], rowCount: run ? 1 : 0 }
      }
      // GET list
      const stateFilter = sql.includes('status = $2') ? (params[1] as string) : null
      const rows = this.runs.filter((r) => {
        if (r.company_id !== companyId || r.deleted_at) return false
        if (stateFilter && r.status !== stateFilter) return false
        return true
      })
      return { rows, rowCount: rows.length }
    }

    if (/from rental_billing_run_lines/i.test(sql)) {
      const [companyId, runId] = params as [string, string]
      const rows = this.lines.filter((l) => l.company_id === companyId && l.billing_run_id === runId)
      return { rows, rowCount: rows.length }
    }

    if (/^update rental_billing_runs/i.test(sql)) {
      const [companyId, runId, status, stateVersion, approvedAt, approvedBy, postedAt, failedAt, error, qboInvoiceId] =
        params as [
          string,
          string,
          string,
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      const run = this.runs.find((r) => r.company_id === companyId && r.id === runId)
      if (!run) return { rows: [], rowCount: 0 }
      run.status = status
      run.state_version = stateVersion
      run.approved_at = approvedAt
      run.approved_by = approvedBy
      run.posted_at = postedAt
      run.failed_at = failedAt
      run.error = error
      run.qbo_invoice_id = qboInvoiceId
      run.version += 1
      run.updated_at = new Date().toISOString()
      return { rows: [run], rowCount: 1 }
    }

    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        workflow_name: params[1] as string,
        entity_id: params[4] as string,
        state_version: params[5] as number,
        event_type: params[6] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        mutation_type: params[5] as string,
        idempotency_key: params[7] as string,
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

const RUN_ID = 'r1111111-1111-4111-8111-111111111111'

function seedRun(pool: FakePool, overrides: Partial<RentalBillingRunRow> = {}): RentalBillingRunRow {
  const row: RentalBillingRunRow = {
    id: RUN_ID,
    company_id: 'co-1',
    contract_id: 'c-1',
    project_id: 'p-1',
    customer_id: 'cust-1',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    status: 'generated',
    state_version: 1,
    subtotal: '1000.00',
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
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
  pool.runs.push(row)
  return row
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): { ctx: RentalInventoryRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async () => true,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleRentalBillingStateRoutes — GET /api/rental-billing-runs', () => {
  it('returns the company runs, optionally filtered by state', async () => {
    const pool = new FakePool()
    seedRun(pool, { id: 'r-1' as string, status: 'generated' })
    seedRun(pool, { id: 'r-2' as string, status: 'posted' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalBillingStateRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/rental-billing-runs?state=posted'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { billingRuns: Array<{ status: string }> }
    expect(body.billingRuns).toHaveLength(1)
    expect(body.billingRuns[0]?.status).toBe('posted')
  })
})

describe('handleRentalBillingStateRoutes — GET /api/rental-billing-runs/:id', () => {
  it('returns a WorkflowSnapshot with state, state_version, and next_events', async () => {
    const pool = new FakePool()
    seedRun(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleRentalBillingStateRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
    }
    expect(snap.state).toBe('generated')
    expect(snap.state_version).toBe(1)
    expect(snap.next_events.map((e) => e.type).sort()).toEqual(['APPROVE', 'VOID'])
  })

  it('returns 404 for an unknown run id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleRentalBillingStateRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })
})

describe('handleRentalBillingStateRoutes — POST /api/rental-billing-runs/:id/events', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    seedRun(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 }, 'member')
    await handleRentalBillingStateRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('APPROVE: transitions generated → approved and writes a workflow_event_log row', async () => {
    const pool = new FakePool()
    seedRun(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleRentalBillingStateRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.runs[0]?.status).toBe('approved')
    expect(pool.runs[0]?.state_version).toBe(2)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.event_type).toBe('APPROVE')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('rental_billing_run')
    // APPROVE does not enqueue the QBO push outbox row.
    expect(pool.outbox.some((r) => r.mutation_type === 'post_qbo_invoice')).toBe(false)
  })

  it('POST_REQUESTED: enqueues a stable-keyed post_qbo_invoice outbox row', async () => {
    const pool = new FakePool()
    seedRun(pool, {
      status: 'approved',
      state_version: 2,
      approved_at: '2026-05-02T00:00:00.000Z',
      approved_by: 'u-1',
    })
    const { ctx, responses } = makeCtx(pool, { event: 'POST_REQUESTED', state_version: 2 })
    await handleRentalBillingStateRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.runs[0]?.status).toBe('posting')
    const pushRow = pool.outbox.find((r) => r.mutation_type === 'post_qbo_invoice')
    expect(pushRow).toBeDefined()
    // Per-run key (NOT per state_version) so retries collapse onto the
    // same outbox row.
    expect(pushRow?.idempotency_key).toBe(`rental_billing_run:post:${RUN_ID}`)
    expect(pushRow?.entity_type).toBe('rental_billing_run')
  })

  it('returns 409 on stale state_version without writing the outbox row', async () => {
    const pool = new FakePool()
    seedRun(pool, { state_version: 5 })
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleRentalBillingStateRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    expect(pool.outbox).toHaveLength(0)
  })

  it('returns 409 on illegal transition (POST_REQUESTED from generated)', async () => {
    const pool = new FakePool()
    seedRun(pool, { status: 'generated', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'POST_REQUESTED', state_version: 1 })
    await handleRentalBillingStateRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-billing-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })
})

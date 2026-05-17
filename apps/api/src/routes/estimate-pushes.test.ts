import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleEstimatePushRoutes, type EstimatePushRouteCtx } from './estimate-pushes.js'

// ---------------------------------------------------------------------------
// estimate-push workflow surface — create (snapshot lines), list, snapshot,
// events. The route ID is the entry-point for the QBO estimate push,
// so the most consequential assertions are the snapshot capture and the
// POST_REQUESTED → mutation_outbox stable-key contract.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type EstimatePushRow = {
  id: string
  company_id: string
  project_id: string
  customer_id: string | null
  status: string
  state_version: number
  subtotal: string
  qbo_estimate_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type EstimateLineRow = {
  id: string
  company_id: string
  project_id: string
  service_item_code: string | null
  quantity: string
  rate: string
  amount: string
  division_code: string | null
  created_at: string
}

class FakePool {
  projects: Array<{ id: string; company_id: string; customer_id: string | null }> = []
  estimateLines: EstimateLineRow[] = []
  pushes: EstimatePushRow[] = []
  pushLines: Array<{
    id: string
    company_id: string
    estimate_push_id: string
    source_estimate_line_id: string | null
    description: string
    service_item_code: string | null
    division_code: string | null
    quantity: string
    unit_price: string
    amount: string
    taxable: boolean
    sort_order: number
    created_at: string
  }> = []
  workflowEvents: Array<{ event_type: string; state_version: number }> = []
  syncEvents: Row[] = []
  outbox: Array<{ mutation_type: string; idempotency_key: string }> = []
  auditEvents: Row[] = []
  private nextPushId = 1
  private nextLineId = 1

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

    if (/select id, customer_id from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const p = this.projects.find((pr) => pr.company_id === companyId && pr.id === projectId)
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 }
    }

    if (/select id, status from estimate_pushes/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const open = this.pushes.find(
        (p) =>
          p.company_id === companyId &&
          p.project_id === projectId &&
          !p.deleted_at &&
          p.status !== 'posted' &&
          p.status !== 'voided',
      )
      return { rows: open ? [{ id: open.id, status: open.status }] : [], rowCount: open ? 1 : 0 }
    }

    if (/from estimate_lines/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.estimateLines.filter((l) => l.company_id === companyId && l.project_id === projectId)
      return { rows, rowCount: rows.length }
    }

    if (/^insert into estimate_pushes/i.test(sql)) {
      const [companyId, projectId, customerId, subtotal] = params as [string, string, string | null, string]
      const row: EstimatePushRow = {
        id: `ep-${this.nextPushId++}`,
        company_id: companyId,
        project_id: projectId,
        customer_id: customerId,
        status: 'drafted',
        state_version: 1,
        subtotal,
        qbo_estimate_id: null,
        reviewed_at: null,
        reviewed_by: null,
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
        workflow_engine: 'postgres',
        workflow_run_id: null,
        version: 1,
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.pushes.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^insert into estimate_push_lines/i.test(sql)) {
      const [
        companyId,
        pushId,
        sourceId,
        description,
        serviceItemCode,
        divisionCode,
        quantity,
        unitPrice,
        amount,
        taxable,
        sortOrder,
      ] = params as [
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        number,
        number,
        number,
        boolean,
        number,
      ]
      const row = {
        id: `epl-${this.nextLineId++}`,
        company_id: companyId,
        estimate_push_id: pushId,
        source_estimate_line_id: sourceId,
        description,
        service_item_code: serviceItemCode,
        division_code: divisionCode,
        quantity: String(quantity),
        unit_price: String(unitPrice),
        amount: String(amount),
        taxable,
        sort_order: sortOrder,
        created_at: new Date().toISOString(),
      }
      this.pushLines.push(row)
      return { rows: [], rowCount: 1 }
    }

    if (/from estimate_push_lines/i.test(sql)) {
      const [companyId, pushId] = params as [string, string]
      const rows = this.pushLines.filter((l) => l.company_id === companyId && l.estimate_push_id === pushId)
      return { rows, rowCount: rows.length }
    }

    if (/from estimate_pushes/i.test(sql) && /select\s/i.test(sql)) {
      // List + detail + for-update
      if (sql.includes('id = $2')) {
        const [companyId, id] = params as [string, string]
        const row = this.pushes.find((p) => p.company_id === companyId && p.id === id && !p.deleted_at)
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      const [companyId] = params as [string]
      let rows = this.pushes.filter((p) => p.company_id === companyId && !p.deleted_at)
      if (params.length > 1 && typeof params[1] === 'string' && /status = \$2/i.test(sql)) {
        rows = rows.filter((p) => p.status === (params[1] as string))
      }
      return { rows, rowCount: rows.length }
    }

    if (/^update estimate_pushes/i.test(sql) && /set status = \$3/i.test(sql)) {
      const [
        companyId,
        id,
        status,
        stateVersion,
        reviewedAt,
        reviewedBy,
        approvedAt,
        approvedBy,
        postedAt,
        failedAt,
        error,
        qboEstimateId,
      ] = params as [
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
        string | null,
        string | null,
      ]
      const row = this.pushes.find((p) => p.company_id === companyId && p.id === id && !p.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.reviewed_at = reviewedAt
      row.reviewed_by = reviewedBy
      row.approved_at = approvedAt
      row.approved_by = approvedBy
      row.posted_at = postedAt
      row.failed_at = failedAt
      row.error = error
      row.qbo_estimate_id = qboEstimateId
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
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

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): { ctx: EstimatePushRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleEstimatePushRoutes — POST /api/projects/:id/estimate-pushes', () => {
  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleEstimatePushRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/estimate-pushes`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('400s when the project has no estimate_lines', async () => {
    const pool = new FakePool()
    pool.projects.push({ id: PROJECT_ID, company_id: 'co-1', customer_id: 'cust-1' })
    const { ctx, responses } = makeCtx(pool)
    await handleEstimatePushRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/estimate-pushes`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('snapshots the estimate_lines into a new estimate_push in state drafted', async () => {
    const pool = new FakePool()
    pool.projects.push({ id: PROJECT_ID, company_id: 'co-1', customer_id: 'cust-1' })
    pool.estimateLines.push({
      id: 'el-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      service_item_code: 'D4-PAINT',
      quantity: '100',
      rate: '5',
      amount: '500',
      division_code: 'D4',
      created_at: '2026-05-01T00:00:00.000Z',
    })
    pool.estimateLines.push({
      id: 'el-2',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      service_item_code: 'D4-CAULK',
      quantity: '50',
      rate: '2',
      amount: '100',
      division_code: 'D4',
      created_at: '2026-05-01T01:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleEstimatePushRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/estimate-pushes`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.pushes).toHaveLength(1)
    expect(pool.pushes[0]?.status).toBe('drafted')
    expect(pool.pushes[0]?.subtotal).toBe('600.00')
    expect(pool.pushLines).toHaveLength(2)
  })

  it('returns 409 when a non-terminal push already exists for the project', async () => {
    const pool = new FakePool()
    pool.projects.push({ id: PROJECT_ID, company_id: 'co-1', customer_id: null })
    pool.pushes.push({
      id: 'ep-open',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      customer_id: null,
      status: 'drafted',
      state_version: 1,
      subtotal: '0',
      qbo_estimate_id: null,
      reviewed_at: null,
      reviewed_by: null,
      approved_at: null,
      approved_by: null,
      posted_at: null,
      failed_at: null,
      error: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      version: 1,
      deleted_at: null,
      created_at: '',
      updated_at: '',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleEstimatePushRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/estimate-pushes`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { open_estimate_push_id: string }
    expect(body.open_estimate_push_id).toBe('ep-open')
  })
})

describe('handleEstimatePushRoutes — POST /api/estimate-pushes/:id/events', () => {
  function seedPush(pool: FakePool, status = 'drafted', stateVersion = 1) {
    pool.pushes.push({
      id: 'ep-1',
      company_id: 'co-1',
      project_id: PROJECT_ID,
      customer_id: null,
      status,
      state_version: stateVersion,
      subtotal: '1000',
      qbo_estimate_id: null,
      reviewed_at: null,
      reviewed_by: null,
      approved_at: null,
      approved_by: null,
      posted_at: null,
      failed_at: null,
      error: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      version: 1,
      deleted_at: null,
      created_at: '',
      updated_at: '',
    })
  }

  it('REVIEW: drafted → reviewed + workflow_event_log row', async () => {
    const pool = new FakePool()
    seedPush(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'REVIEW', state_version: 1 })
    await handleEstimatePushRoutes({ method: 'POST' } as never, buildUrl('/api/estimate-pushes/ep-1/events'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.pushes[0]?.status).toBe('reviewed')
    expect(pool.workflowEvents[0]?.event_type).toBe('REVIEW')
  })

  it('POST_REQUESTED: enqueues post_qbo_estimate with a per-run idempotency key', async () => {
    const pool = new FakePool()
    seedPush(pool, 'approved', 3)
    const { ctx, responses } = makeCtx(pool, { event: 'POST_REQUESTED', state_version: 3 })
    await handleEstimatePushRoutes({ method: 'POST' } as never, buildUrl('/api/estimate-pushes/ep-1/events'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const pushRow = pool.outbox.find((r) => r.mutation_type === 'post_qbo_estimate')
    expect(pushRow).toBeDefined()
    expect(pushRow?.idempotency_key).toBe('estimate_push:post:ep-1')
  })

  it('returns 409 on stale state_version', async () => {
    const pool = new FakePool()
    seedPush(pool, 'drafted', 7)
    const { ctx, responses } = makeCtx(pool, { event: 'REVIEW', state_version: 1 })
    await handleEstimatePushRoutes({ method: 'POST' } as never, buildUrl('/api/estimate-pushes/ep-1/events'), ctx)
    expect(responses[0]?.status).toBe(409)
  })

  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    seedPush(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'REVIEW', state_version: 1 }, 'member')
    await handleEstimatePushRoutes({ method: 'POST' } as never, buildUrl('/api/estimate-pushes/ep-1/events'), ctx)
    expect(responses[0]?.status).toBe(403)
  })
})

import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleLaborPayrollRunRoutes, type LaborPayrollRouteCtx } from './labor-payroll-runs.js'

// ---------------------------------------------------------------------------
// labor_payroll_runs workflow surface — list / detail / create / events.
// Mirrors the rental-billing fake; covers the POST_REQUESTED stable
// idempotency-key contract and the no-eligible-entries 400.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type RunRow = {
  id: string
  company_id: string
  period_start: string
  period_end: string
  state: string
  state_version: number
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  qbo_payroll_batch_ref: string[] | null
  covered_labor_entry_ids: string[]
  total_hours: string
  total_cents: string
  time_review_run_id: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  origin: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

class FakePool {
  runs: RunRow[] = []
  laborEntries: Array<{
    id: string
    company_id: string
    hours: string
    occurred_on: string
    payroll_run_id: string | null
    review_locked_at: string | null
    worker_id: string | null
  }> = []
  workflowEvents: Array<{ event_type: string; state_version: number; entity_id: string }> = []
  syncEvents: Row[] = []
  outbox: Array<{ mutation_type: string; idempotency_key: string }> = []
  auditEvents: Row[] = []
  private nextRunId = 1

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

    // Pre-insert duplicate check
    if (/select id from labor_payroll_runs/i.test(sql) && /period_start = \$2/i.test(sql)) {
      const [companyId, periodStart, periodEnd] = params as [string, string, string]
      const existing = this.runs.find(
        (r) =>
          r.company_id === companyId && r.period_start === periodStart && r.period_end === periodEnd && !r.deleted_at,
      )
      return { rows: existing ? [{ id: existing.id }] : [], rowCount: existing ? 1 : 0 }
    }

    // Eligible labor entries
    if (/from labor_entries le/i.test(sql)) {
      const [companyId, periodStart, periodEnd] = params as [string, string, string]
      const rows = this.laborEntries
        .filter(
          (l) =>
            l.company_id === companyId &&
            l.review_locked_at !== null &&
            l.payroll_run_id === null &&
            l.occurred_on >= periodStart &&
            l.occurred_on <= periodEnd,
        )
        .map((l) => ({
          id: l.id,
          worker_id: l.worker_id,
          hours: l.hours,
          occurred_on: l.occurred_on,
          payroll_run_id: l.payroll_run_id,
          review_locked_at: l.review_locked_at,
          base_hourly_cents: 5000,
          insurance_pct: '10',
          benefits_pct: '20',
        }))
      return { rows, rowCount: rows.length }
    }

    // List
    if (
      /from labor_payroll_runs/i.test(sql) &&
      /select\s/i.test(sql) &&
      !/for update/i.test(sql) &&
      /order by/i.test(sql)
    ) {
      const [companyId] = params as [string]
      let rows = this.runs.filter((r) => r.company_id === companyId && !r.deleted_at)
      // Try to apply state filter when present
      if (params.length > 1 && typeof params[1] === 'string' && /state = \$2/i.test(sql)) {
        rows = rows.filter((r) => r.state === (params[1] as string))
      }
      return { rows, rowCount: rows.length }
    }

    // Detail / lock select
    if (/from labor_payroll_runs/i.test(sql) && /id = \$2/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.runs.find((r) => r.company_id === companyId && r.id === id && !r.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // Insert new run
    if (/^insert into labor_payroll_runs/i.test(sql)) {
      const [companyId, periodStart, periodEnd, coveredIds, totalHours, totalCents, timeReviewRunId] = params as [
        string,
        string,
        string,
        string[],
        string,
        string,
        string | null,
      ]
      const row: RunRow = {
        id: `lpr-${this.nextRunId++}`,
        company_id: companyId,
        period_start: periodStart,
        period_end: periodEnd,
        state: 'generated',
        state_version: 1,
        approved_at: null,
        approved_by_user_id: null,
        posted_at: null,
        failed_at: null,
        error_message: null,
        qbo_payroll_batch_ref: null,
        covered_labor_entry_ids: coveredIds,
        total_hours: totalHours,
        total_cents: totalCents,
        time_review_run_id: timeReviewRunId,
        workflow_engine: 'postgres',
        workflow_run_id: null,
        version: 1,
        origin: null,
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.runs.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // Claim labor entries
    if (/^update labor_entries/i.test(sql) && /set payroll_run_id/i.test(sql)) {
      const [, runId, ids] = params as [string, string, string[]]
      for (const entry of this.laborEntries) {
        if (ids.includes(entry.id) && entry.payroll_run_id === null) {
          entry.payroll_run_id = runId
        }
      }
      return { rows: [], rowCount: 0 }
    }

    // Update existing run on event
    if (/^update labor_payroll_runs/i.test(sql) && /set state = \$3/i.test(sql)) {
      const [companyId, id, state, stateVersion, approvedAt, approvedBy, postedAt, failedAt, errorMessage, qboRef] =
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
      const row = this.runs.find((r) => r.company_id === companyId && r.id === id && !r.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.state = state
      row.state_version = stateVersion
      row.approved_at = approvedAt
      row.approved_by_user_id = approvedBy
      row.posted_at = postedAt
      row.failed_at = failedAt
      row.error_message = errorMessage
      row.qbo_payroll_batch_ref = qboRef ? (JSON.parse(qboRef) as string[]) : null
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
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

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'foreman' | 'member' = 'admin',
): { ctx: LaborPayrollRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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

describe('handleLaborPayrollRunRoutes — POST /api/labor-payroll-runs', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' }, 'foreman')
    await handleLaborPayrollRunRoutes({ method: 'POST' } as never, buildUrl('/api/labor-payroll-runs'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('400s when period_start/period_end are missing or malformed', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { period_start: 'bad', period_end: '2026-05-07' })
    await handleLaborPayrollRunRoutes({ method: 'POST' } as never, buildUrl('/api/labor-payroll-runs'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('400s when no eligible labor entries exist for the period', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' })
    await handleLaborPayrollRunRoutes({ method: 'POST' } as never, buildUrl('/api/labor-payroll-runs'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('creates a new run and claims the eligible entries', async () => {
    const pool = new FakePool()
    pool.laborEntries.push({
      id: '11111111-1111-4111-8111-111111111111',
      company_id: 'co-1',
      hours: '8',
      occurred_on: '2026-05-02',
      payroll_run_id: null,
      review_locked_at: '2026-05-03T00:00:00.000Z',
      worker_id: 'w-1',
    })
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' })
    await handleLaborPayrollRunRoutes({ method: 'POST' } as never, buildUrl('/api/labor-payroll-runs'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.runs).toHaveLength(1)
    expect(pool.runs[0]?.state).toBe('generated')
    expect(pool.runs[0]?.covered_labor_entry_ids).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(pool.laborEntries[0]?.payroll_run_id).toBe(pool.runs[0]?.id)
  })

  it('returns 409 when a non-deleted run already covers the same period', async () => {
    const pool = new FakePool()
    pool.runs.push({
      id: 'lpr-existing',
      company_id: 'co-1',
      period_start: '2026-05-01',
      period_end: '2026-05-07',
      state: 'generated',
      state_version: 1,
      approved_at: null,
      approved_by_user_id: null,
      posted_at: null,
      failed_at: null,
      error_message: null,
      qbo_payroll_batch_ref: null,
      covered_labor_entry_ids: [],
      total_hours: '0',
      total_cents: '0',
      time_review_run_id: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      version: 1,
      origin: null,
      deleted_at: null,
      created_at: '',
      updated_at: '',
    })
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' })
    await handleLaborPayrollRunRoutes({ method: 'POST' } as never, buildUrl('/api/labor-payroll-runs'), ctx)
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { existing_run_id: string }
    expect(body.existing_run_id).toBe('lpr-existing')
  })
})

describe('handleLaborPayrollRunRoutes — POST /api/labor-payroll-runs/:id/events', () => {
  function seedGeneratedRun(pool: FakePool) {
    pool.runs.push({
      id: '11111111-1111-4111-8111-111111111111',
      company_id: 'co-1',
      period_start: '2026-05-01',
      period_end: '2026-05-07',
      state: 'generated',
      state_version: 1,
      approved_at: null,
      approved_by_user_id: null,
      posted_at: null,
      failed_at: null,
      error_message: null,
      qbo_payroll_batch_ref: null,
      covered_labor_entry_ids: ['e-1'],
      total_hours: '8',
      total_cents: '50000',
      time_review_run_id: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      version: 1,
      origin: null,
      deleted_at: null,
      created_at: '',
      updated_at: '',
    })
  }

  it('APPROVE: generated → approved + workflow_event_log', async () => {
    const pool = new FakePool()
    seedGeneratedRun(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleLaborPayrollRunRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/labor-payroll-runs/11111111-1111-4111-8111-111111111111/events'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.runs[0]?.state).toBe('approved')
    expect(pool.workflowEvents[0]?.event_type).toBe('APPROVE')
    expect(pool.outbox.find((r) => r.mutation_type === 'post_qbo_time_activities')).toBeUndefined()
  })

  it('POST_REQUESTED: enqueues post_qbo_time_activities with a per-run idempotency key', async () => {
    const pool = new FakePool()
    seedGeneratedRun(pool)
    pool.runs[0]!.state = 'approved'
    pool.runs[0]!.state_version = 2
    const { ctx, responses } = makeCtx(pool, { event: 'POST_REQUESTED', state_version: 2 })
    await handleLaborPayrollRunRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/labor-payroll-runs/11111111-1111-4111-8111-111111111111/events'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const pushRow = pool.outbox.find((r) => r.mutation_type === 'post_qbo_time_activities')
    expect(pushRow).toBeDefined()
    expect(pushRow?.idempotency_key).toBe('labor_payroll_run:post:11111111-1111-4111-8111-111111111111')
  })

  it('returns 409 on stale state_version', async () => {
    const pool = new FakePool()
    seedGeneratedRun(pool)
    pool.runs[0]!.state_version = 7
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleLaborPayrollRunRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/labor-payroll-runs/11111111-1111-4111-8111-111111111111/events'),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })

  it('returns 404 for a missing run', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleLaborPayrollRunRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/labor-payroll-runs/11111111-1111-4111-8111-111111111111/events'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })
})

import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleTimeReviewRunRoutes, type TimeReviewRouteCtx } from './time-review-runs.js'

// ---------------------------------------------------------------------------
// time_review_runs workflow surface. The most consequential assertions are
// the create-with-anomaly-count + the APPROVE → lock_labor_entries outbox
// row keyed per state_version (so APPROVE → REOPEN → APPROVE produces
// three distinct rows).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type RunRow = {
  id: string
  company_id: string
  project_id: string | null
  period_start: string
  period_end: string
  state: 'pending' | 'approved' | 'rejected'
  state_version: number
  covered_entry_ids: string[]
  total_hours: string
  total_entries: number
  anomaly_count: number
  reviewer_user_id: string | null
  approved_at: string | null
  rejected_at: string | null
  rejection_reason: string | null
  reopened_at: string | null
  workflow_engine: string
  workflow_run_id: string | null
  origin: string | null
  created_at: string
  updated_at: string
}

class FakePool {
  runs: RunRow[] = []
  laborEntries: Array<{
    id: string
    company_id: string
    project_id: string | null
    hours: string
    review_locked_at: string | null
    occurred_on: string
    deleted_at: string | null
  }> = []
  workflowEvents: Array<{ event_type: string; state_version: number }> = []
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

    if (/from labor_entries/i.test(sql) && /over_eight/i.test(sql)) {
      const [companyId, projectId, periodStart, periodEnd] = params as [string, string, string, string]
      const rows = this.laborEntries
        .filter(
          (l) =>
            l.company_id === companyId &&
            !l.deleted_at &&
            l.review_locked_at === null &&
            (projectId === '' || l.project_id === projectId) &&
            l.occurred_on >= periodStart &&
            l.occurred_on <= periodEnd,
        )
        .map((l) => ({ id: l.id, hours: l.hours, over_eight: Number(l.hours) > 8 }))
      return { rows, rowCount: rows.length }
    }

    if (/^insert into time_review_runs/i.test(sql)) {
      const [companyId, projectId, periodStart, periodEnd, coveredEntryIds, totalHours, totalEntries, anomalyCount] =
        params as [string, string | null, string, string, string[], string, number, number]
      const row: RunRow = {
        id: `tr-${this.nextRunId++}`,
        company_id: companyId,
        project_id: projectId,
        period_start: periodStart,
        period_end: periodEnd,
        state: 'pending',
        state_version: 1,
        covered_entry_ids: coveredEntryIds,
        total_hours: totalHours,
        total_entries: totalEntries,
        anomaly_count: anomalyCount,
        reviewer_user_id: null,
        approved_at: null,
        rejected_at: null,
        rejection_reason: null,
        reopened_at: null,
        workflow_engine: 'postgres',
        workflow_run_id: null,
        origin: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.runs.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/from time_review_runs/i.test(sql) && /select\s/i.test(sql) && /id = \$2/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.runs.find((r) => r.company_id === companyId && r.id === id)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (/from time_review_runs/i.test(sql) && /select\s/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.runs.filter((r) => r.company_id === companyId)
      return { rows, rowCount: rows.length }
    }

    if (/^update time_review_runs/i.test(sql)) {
      const [companyId, id, state, stateVersion, reviewerUserId, approvedAt, rejectedAt, rejectionReason, reopenedAt] =
        params as [
          string,
          string,
          'pending' | 'approved' | 'rejected',
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      const row = this.runs.find((r) => r.company_id === companyId && r.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.state = state
      row.state_version = stateVersion
      row.reviewer_user_id = reviewerUserId
      row.approved_at = approvedAt
      row.rejected_at = rejectedAt
      row.rejection_reason = rejectionReason
      row.reopened_at = reopenedAt
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

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'foreman' | 'member' = 'admin',
): { ctx: TimeReviewRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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

const RUN_ID = '11111111-1111-4111-8111-111111111111'

describe('handleTimeReviewRunRoutes — POST /api/time-review-runs', () => {
  it('rejects member callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' }, 'member')
    await handleTimeReviewRunRoutes({ method: 'POST' } as never, buildUrl('/api/time-review-runs'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('400s when period_start/period_end are not YYYY-MM-DD', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { period_start: 'nope' })
    await handleTimeReviewRunRoutes({ method: 'POST' } as never, buildUrl('/api/time-review-runs'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('creates a pending run, computes total_hours and surfaces the hours>8 anomaly count', async () => {
    const pool = new FakePool()
    pool.laborEntries.push({
      id: '11111111-aaaa-4aaa-8aaa-111111111111',
      company_id: 'co-1',
      project_id: null,
      hours: '8',
      review_locked_at: null,
      occurred_on: '2026-05-02',
      deleted_at: null,
    })
    pool.laborEntries.push({
      id: '22222222-aaaa-4aaa-8aaa-222222222222',
      company_id: 'co-1',
      project_id: null,
      hours: '11',
      review_locked_at: null,
      occurred_on: '2026-05-03',
      deleted_at: null,
    })
    const { ctx, responses } = makeCtx(pool, { period_start: '2026-05-01', period_end: '2026-05-07' })
    await handleTimeReviewRunRoutes({ method: 'POST' } as never, buildUrl('/api/time-review-runs'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    expect(pool.runs).toHaveLength(1)
    expect(pool.runs[0]?.total_entries).toBe(2)
    expect(pool.runs[0]?.total_hours).toBe('19.00')
    expect(pool.runs[0]?.anomaly_count).toBe(1)
  })
})

describe('handleTimeReviewRunRoutes — POST /api/time-review-runs/:id/events', () => {
  function seedPending(pool: FakePool) {
    pool.runs.push({
      id: RUN_ID,
      company_id: 'co-1',
      project_id: null,
      period_start: '2026-05-01',
      period_end: '2026-05-07',
      state: 'pending',
      state_version: 1,
      covered_entry_ids: ['e-1', 'e-2'],
      total_hours: '16',
      total_entries: 2,
      anomaly_count: 0,
      reviewer_user_id: null,
      approved_at: null,
      rejected_at: null,
      rejection_reason: null,
      reopened_at: null,
      workflow_engine: 'postgres',
      workflow_run_id: null,
      origin: null,
      created_at: '',
      updated_at: '',
    })
  }

  it('APPROVE: emits lock_labor_entries outbox row keyed per state_version', async () => {
    const pool = new FakePool()
    seedPending(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleTimeReviewRunRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/time-review-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.runs[0]?.state).toBe('approved')
    const lockRow = pool.outbox.find((r) => r.mutation_type === 'lock_labor_entries')
    expect(lockRow).toBeDefined()
    // Per-state_version key — APPROVE → REOPEN → APPROVE produces three rows.
    expect(lockRow?.idempotency_key).toBe(`time_review:lock:${RUN_ID}:2`)
  })

  it('REJECT: pending → rejected; does NOT emit a lock_labor_entries outbox row', async () => {
    const pool = new FakePool()
    seedPending(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'REJECT', state_version: 1, reason: 'over-hours' })
    await handleTimeReviewRunRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/time-review-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.runs[0]?.state).toBe('rejected')
    expect(pool.runs[0]?.rejection_reason).toBe('over-hours')
    expect(pool.outbox.find((r) => r.mutation_type === 'lock_labor_entries')).toBeUndefined()
  })

  it('returns 409 on stale state_version without writing the lock outbox row', async () => {
    const pool = new FakePool()
    seedPending(pool)
    pool.runs[0]!.state_version = 5
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleTimeReviewRunRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/time-review-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    expect(pool.outbox.find((r) => r.mutation_type === 'lock_labor_entries')).toBeUndefined()
  })

  it('returns 404 for an unknown run', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleTimeReviewRunRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/time-review-runs/${RUN_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('400s when id is not a uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { event: 'APPROVE', state_version: 1 })
    await handleTimeReviewRunRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/time-review-runs/not-a-uuid/events'),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })
})

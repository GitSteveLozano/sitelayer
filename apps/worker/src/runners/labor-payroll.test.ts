import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { CircuitBreaker } from '@sitelayer/queue'
import { createLogger } from '@sitelayer/logger'
import { createLaborPayrollRunner } from './labor-payroll.js'

// Unit tests for the labor-payroll runner. Exercises both:
//   - drainPushes      → wraps processLaborPayrollPush
//   - drainGenerateBridge → wraps processGenerateLaborPayrollRun (time-review
//     APPROVE → labor_payroll_run materialization)
//
// QBO_LIVE_LABOR_PAYROLL stays unset so we use the deterministic stub.

const testLogger = createLogger('labor-payroll-runner-test', { level: 'silent' })

type FakeRow = QueryResultRow

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

type Responder = (sql: string, params: ReadonlyArray<unknown>) => Partial<QueryResult<FakeRow>> | Error | undefined

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makePool(responder: Responder): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  function makeClient(): PoolClient {
    const idx = released.length
    released.push(false)
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params: params ?? [] })
        const r = responder(sql, params ?? [])
        if (r instanceof Error) throw r
        return buildResponse(r ?? {})
      }) as unknown as PoolClient['query'],
      release: vi.fn(() => {
        released[idx] = true
      }) as unknown as PoolClient['release'],
    }
    return client as PoolClient
  }
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => makeClient()) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, calls, released }
}

function makeBreaker(): CircuitBreaker {
  return new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 })
}

const RUN_ID = 'fedcba98-7654-3210-fedc-ba9876543210'

describe('createLaborPayrollRunner — drainPushes', () => {
  const originalEnv = process.env.QBO_LIVE_LABOR_PAYROLL

  beforeEach(() => {
    delete process.env.QBO_LIVE_LABOR_PAYROLL
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QBO_LIVE_LABOR_PAYROLL
    else process.env.QBO_LIVE_LABOR_PAYROLL = originalEnv
  })

  it('empty pass — returns zero summary when no outbox rows are claimed', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
      return { rows: [] }
    }
    const { pool, released } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainPushes('co-1')
    expect(summary).toEqual({ processed: 0, posted: 0, failed: 0, skipped: 0 })
    expect(released[0]).toBe(true)
  })

  it('happy path — stub push returns synthetic ids, run transitions to posted', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: RUN_ID,
      payload: { covered_labor_entry_ids: ['e1', 'e2'] },
      attempt_count: 1,
    }
    const lockedRow = {
      id: RUN_ID,
      state: 'posting',
      state_version: 2,
      qbo_payroll_batch_ref: null,
      approved_at: null,
      approved_by_user_id: null,
      posted_at: null,
      failed_at: null,
      error_message: null,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('select qbo_payroll_batch_ref, state from labor_payroll_runs')) {
        return { rows: [{ qbo_payroll_batch_ref: null, state: 'posting' }], rowCount: 1 }
      }
      if (sql.includes('for update') && sql.includes('labor_payroll_runs')) {
        return { rows: [lockedRow], rowCount: 1 }
      }
      if (sql.includes('update labor_payroll_runs') && sql.includes("'posted'")) {
        return {
          rows: [
            { ...lockedRow, state: 'posted', state_version: 3, qbo_payroll_batch_ref: ['STUB-TA-x-1', 'STUB-TA-x-2'] },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainPushes('co-1')
    expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

    // The posted-state update writes a JSON array of TimeActivity ids.
    const update = calls.find((c) => c.sql.includes('update labor_payroll_runs') && c.sql.includes("'posted'"))
    expect(update).toBeDefined()
    const ids = JSON.parse(String(update!.params[4])) as string[]
    expect(ids).toHaveLength(2) // one per covered_labor_entry_ids
    expect(ids[0]).toMatch(/^STUB-TA-fedcba98-/)

    // workflow_event_log row + sync_events row + applied outbox.
    expect(calls.find((c) => c.sql.includes('insert into workflow_event_log'))).toBeDefined()
    expect(calls.find((c) => c.sql.includes('insert into sync_events'))).toBeDefined()
    expect(calls.find((c) => c.sql.includes("update mutation_outbox set status = 'applied'"))).toBeDefined()
  })

  it('failure path — labor_payroll_run missing → outbox marked failed', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'missing-run',
      payload: {},
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('select qbo_payroll_batch_ref, state from labor_payroll_runs')) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainPushes('co-1')
    expect(summary.failed).toBe(1)
    expect(calls.find((c) => c.sql.includes("update mutation_outbox set status = 'failed'"))).toBeDefined()
  })

  it('idempotency — qbo_payroll_batch_ref already set → skipped without second push', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: RUN_ID,
      payload: { covered_labor_entry_ids: ['e1'] },
      attempt_count: 2,
    }
    const existing = {
      id: RUN_ID,
      state: 'posting',
      state_version: 2,
      qbo_payroll_batch_ref: ['QBO-TA-1', 'QBO-TA-2'],
      approved_at: null,
      approved_by_user_id: null,
      posted_at: null,
      failed_at: null,
      error_message: null,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('select qbo_payroll_batch_ref, state from labor_payroll_runs')) {
        return {
          rows: [{ qbo_payroll_batch_ref: ['QBO-TA-1', 'QBO-TA-2'], state: 'posting' }],
          rowCount: 1,
        }
      }
      if (sql.includes('for update') && sql.includes('labor_payroll_runs')) {
        return { rows: [existing], rowCount: 1 }
      }
      if (sql.includes('update labor_payroll_runs') && sql.includes("'posted'")) {
        return { rows: [{ ...existing, state: 'posted', state_version: 3 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainPushes('co-1')
    expect(summary).toEqual({ processed: 1, posted: 0, failed: 0, skipped: 1 })

    const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
    expect(syncInsert).toBeDefined()
    const payload = JSON.parse(String(syncInsert!.params[2]))
    expect(payload.idempotent_replay).toBe(true)
    expect(payload.external_ids).toEqual(['QBO-TA-1', 'QBO-TA-2'])
  })
})

describe('createLaborPayrollRunner — drainGenerateBridge', () => {
  it('empty pass — no approved time_review_runs → zero summary', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from time_review_runs')) return { rows: [], rowCount: 0 }
      return { rows: [] }
    }
    const { pool, released } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainGenerateBridge('co-1')
    expect(summary).toEqual({ processed: 0, generated: 0, skipped: 0, failed: 0 })
    expect(released[0]).toBe(true)
  })

  it('skips a candidate whose covered entries are not yet all locked (race with lock_labor_entries)', async () => {
    const candidate = {
      id: 'tr-1',
      period_start: '2026-05-01',
      period_end: '2026-05-07',
      covered_entry_ids: ['e1', 'e2'],
    }
    const responder: Responder = (sql) => {
      if (sql.includes('from time_review_runs')) return { rows: [candidate], rowCount: 1 }
      if (sql.includes('from labor_entries')) {
        // e1 locked, e2 still unlocked → defer
        return {
          rows: [
            {
              id: 'e1',
              review_locked_at: '2026-05-08T00:00:00Z',
              payroll_run_id: null,
              worker_id: 'w1',
              hours: '8',
              base_hourly_cents: 5000,
              insurance_pct: '10',
              benefits_pct: '5',
            },
            {
              id: 'e2',
              review_locked_at: null,
              payroll_run_id: null,
              worker_id: 'w1',
              hours: '4',
              base_hourly_cents: 5000,
              insurance_pct: '10',
              benefits_pct: '5',
            },
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool } = makePool(responder)
    const runner = createLaborPayrollRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
    const summary = await runner.drainGenerateBridge('co-1')
    expect(summary.skipped).toBe(1)
    expect(summary.generated).toBe(0)
  })
})

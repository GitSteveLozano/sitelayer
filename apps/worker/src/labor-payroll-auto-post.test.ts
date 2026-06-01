import { describe, expect, it, vi } from 'vitest'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import {
  AUTO_POST_ACTOR,
  isAutoPostWindowOpen,
  parseTimeOfDayMinutes,
  processLaborPayrollAutoPost,
  type LaborPayrollAutoPostPolicy,
} from './labor-payroll-auto-post.js'

// ---------------------------------------------------------------------------
// Pure clock-window helper (no DB) — fully unit-testable.
// ---------------------------------------------------------------------------

describe('parseTimeOfDayMinutes', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTimeOfDayMinutes('17:00')).toBe(17 * 60)
    expect(parseTimeOfDayMinutes('09:30')).toBe(9 * 60 + 30)
    expect(parseTimeOfDayMinutes('17:00:00')).toBe(17 * 60)
    expect(parseTimeOfDayMinutes('0:05')).toBe(5)
  })

  it('returns null on malformed / out-of-range values', () => {
    expect(parseTimeOfDayMinutes('')).toBeNull()
    expect(parseTimeOfDayMinutes('nope')).toBeNull()
    expect(parseTimeOfDayMinutes('25:00')).toBeNull()
    expect(parseTimeOfDayMinutes('17:99')).toBeNull()
  })
})

describe('isAutoPostWindowOpen', () => {
  const enabled = (over: Partial<LaborPayrollAutoPostPolicy> = {}): LaborPayrollAutoPostPolicy => ({
    enabled: true,
    weekday: 5, // Friday (ISO)
    after: '17:00',
    ...over,
  })

  // 2026-05-29 is a Friday (ISO weekday 5).
  const fri = (h: number, m = 0) => new Date(2026, 4, 29, h, m, 0)
  const sat = (h: number, m = 0) => new Date(2026, 4, 30, h, m, 0)

  it('closed when policy disabled', () => {
    expect(isAutoPostWindowOpen(enabled({ enabled: false }), fri(18))).toBe(false)
  })

  it('closed when weekday or after unset', () => {
    expect(isAutoPostWindowOpen(enabled({ weekday: null }), fri(18))).toBe(false)
    expect(isAutoPostWindowOpen(enabled({ after: null }), fri(18))).toBe(false)
  })

  it('closed on the wrong weekday', () => {
    expect(isAutoPostWindowOpen(enabled(), sat(18))).toBe(false)
  })

  it('closed before the after-time on the right weekday', () => {
    expect(isAutoPostWindowOpen(enabled(), fri(16, 59))).toBe(false)
  })

  it('open at/after the after-time on the right weekday', () => {
    expect(isAutoPostWindowOpen(enabled(), fri(17, 0))).toBe(true)
    expect(isAutoPostWindowOpen(enabled(), fri(23, 59))).toBe(true)
  })

  it('maps Sunday to ISO weekday 7', () => {
    // 2026-05-31 is a Sunday.
    const sun = new Date(2026, 4, 31, 18, 0, 0)
    expect(isAutoPostWindowOpen(enabled({ weekday: 7 }), sun)).toBe(true)
    expect(isAutoPostWindowOpen(enabled({ weekday: 1 }), sun)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Drain — fake PoolClient driven by a SQL responder.
// ---------------------------------------------------------------------------

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

function makeClient(responder: Responder): { client: PoolClient; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ sql, params: params ?? [] })
      const r = responder(sql, params ?? [])
      if (r instanceof Error) throw r
      return buildResponse(r ?? {})
    }) as unknown as PoolClient['query'],
  }
  return { client: client as PoolClient, calls }
}

const POLICY_ENABLED_OPEN = {
  labor_payroll_auto_post_enabled: true,
  labor_payroll_auto_post_weekday: 5,
  labor_payroll_auto_post_after: '17:00',
}
// 2026-05-29 17:30 = Friday, after 17:00 → window OPEN.
const NOW_OPEN = new Date(2026, 4, 29, 17, 30, 0)

const RUN_ID = 'fedcba98-7654-3210-fedc-ba9876543210'

function generatedRow() {
  return {
    id: RUN_ID,
    state: 'generated',
    state_version: 1,
    approved_at: null,
    approved_by_user_id: null,
    posted_at: null,
    failed_at: null,
    error_message: null,
    qbo_payroll_batch_ref: null,
    auto_posted: false,
    covered_labor_entry_ids: ['e1', 'e2'],
    period_start: '2026-05-18',
    period_end: '2026-05-24',
    total_hours: '40.00',
    total_cents: '200000',
  }
}

describe('processLaborPayrollAutoPost — window gating', () => {
  it('no-op when policy disabled', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('from companies')) {
        return { rows: [{ ...POLICY_ENABLED_OPEN, labor_payroll_auto_post_enabled: false }], rowCount: 1 }
      }
      return { rows: [] }
    })
    const summary = await processLaborPayrollAutoPost(client, 'co-1', { now: NOW_OPEN })
    expect(summary.windowClosed).toBe(true)
    expect(summary.processed).toBe(0)
    // Only the policy read ran — never touched labor_payroll_runs.
    expect(calls.find((c) => c.sql.includes('from labor_payroll_runs'))).toBeUndefined()
  })

  it('no-op when clock window closed (wrong day)', async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes('from companies')) return { rows: [POLICY_ENABLED_OPEN], rowCount: 1 }
      return { rows: [] }
    })
    // 2026-05-28 is a Thursday → wrong weekday.
    const summary = await processLaborPayrollAutoPost(client, 'co-1', { now: new Date(2026, 4, 28, 18, 0, 0) })
    expect(summary.windowClosed).toBe(true)
  })
})

describe('processLaborPayrollAutoPost — cadence', () => {
  it('auto-approves a generated run (generated → approved, auto_posted=true)', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from companies')) return { rows: [POLICY_ENABLED_OPEN], rowCount: 1 }
      if (sql.includes("state = 'generated'")) return { rows: [{ id: RUN_ID }], rowCount: 1 }
      if (sql.includes("state = 'approved'")) return { rows: [], rowCount: 0 }
      if (sql.includes('for update')) return { rows: [generatedRow()], rowCount: 1 }
      if (sql.includes('update labor_payroll_runs')) {
        return {
          rows: [{ ...generatedRow(), state: 'approved', state_version: 2, auto_posted: true }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    }
    const { client, calls } = makeClient(responder)
    const summary = await processLaborPayrollAutoPost(client, 'co-1', { now: NOW_OPEN })
    expect(summary.windowClosed).toBe(false)
    expect(summary.approved).toBe(1)
    expect(summary.posted).toBe(0)
    expect(summary.failed).toBe(0)

    // Persisted the AUTO_APPROVE transition (approved, auto_posted=true, synthetic actor).
    const update = calls.find((c) => c.sql.includes('update labor_payroll_runs'))
    expect(update).toBeDefined()
    expect(update!.params[2]).toBe('approved') // state
    expect(update!.params[3]).toBe(2) // state_version
    expect(update!.params[5]).toBe(AUTO_POST_ACTOR) // approved_by_user_id
    expect(update!.params[6]).toBe(true) // auto_posted

    // Wrote the workflow_event_log row with eventType AUTO_APPROVE.
    const logInsert = calls.find((c) => c.sql.includes('insert into workflow_event_log'))
    expect(logInsert).toBeDefined()
    expect(logInsert!.params.includes('AUTO_APPROVE')).toBe(true)
  })

  it('auto-post-requests an auto-approved run + enqueues the SAME-keyed outbox row', async () => {
    const approvedRow = {
      ...generatedRow(),
      state: 'approved',
      state_version: 2,
      auto_posted: true,
      approved_at: '2026-05-29T17:30:00.000Z',
      approved_by_user_id: AUTO_POST_ACTOR,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('from companies')) return { rows: [POLICY_ENABLED_OPEN], rowCount: 1 }
      if (sql.includes("state = 'generated'")) return { rows: [], rowCount: 0 }
      if (sql.includes("state = 'approved'")) return { rows: [{ id: RUN_ID }], rowCount: 1 }
      if (sql.includes('for update')) return { rows: [approvedRow], rowCount: 1 }
      if (sql.includes('update labor_payroll_runs')) {
        return { rows: [{ ...approvedRow, state: 'posting', state_version: 3 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    const { client, calls } = makeClient(responder)
    const summary = await processLaborPayrollAutoPost(client, 'co-1', { now: NOW_OPEN })
    expect(summary.approved).toBe(0)
    expect(summary.posted).toBe(1)
    expect(summary.failed).toBe(0)

    // posting transition persisted.
    const update = calls.find((c) => c.sql.includes('update labor_payroll_runs'))
    expect(update!.params[2]).toBe('posting')

    // Outbox row enqueued via recordLedger with the human-path idempotency key.
    const outboxInsert = calls.find((c) => c.sql.includes('insert into mutation_outbox'))
    expect(outboxInsert).toBeDefined()
    expect(outboxInsert!.params.includes(`labor_payroll_run:post:${RUN_ID}`)).toBe(true)
    expect(outboxInsert!.params.includes('post_qbo_time_activities')).toBe(true)
    // Conflict clause = idempotent upsert, never a duplicate.
    expect(outboxInsert!.sql).toContain('on conflict (company_id, idempotency_key) do update')

    // AUTO_POST_REQUESTED logged.
    const logInsert = calls.find((c) => c.sql.includes('insert into workflow_event_log'))
    expect(logInsert!.params.includes('AUTO_POST_REQUESTED')).toBe(true)
  })

  it('skips a run that raced a human action (state changed under the lock)', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from companies')) return { rows: [POLICY_ENABLED_OPEN], rowCount: 1 }
      if (sql.includes("state = 'generated'")) return { rows: [{ id: RUN_ID }], rowCount: 1 }
      if (sql.includes("state = 'approved'")) return { rows: [], rowCount: 0 }
      // Locked row is no longer 'generated' (human VOID landed first).
      if (sql.includes('for update')) return { rows: [{ ...generatedRow(), state: 'voided' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    const { client, calls } = makeClient(responder)
    const summary = await processLaborPayrollAutoPost(client, 'co-1', { now: NOW_OPEN })
    expect(summary.skipped).toBe(1)
    expect(summary.approved).toBe(0)
    // Never wrote a transition for the raced run.
    expect(calls.find((c) => c.sql.includes('update labor_payroll_runs'))).toBeUndefined()
    // Committed the no-op tx.
    expect(calls.find((c) => c.sql === 'commit')).toBeDefined()
  })
})

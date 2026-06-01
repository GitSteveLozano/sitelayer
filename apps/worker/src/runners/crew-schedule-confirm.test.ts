import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createCrewScheduleConfirmRunner } from './crew-schedule-confirm.js'

// Unit tests for the crew-schedule confirm runner. Drains the two declared
// crew_schedule side effects:
//
//   materialize_labor_entries — insert one confirmed labor_entry per crew
//                               worker + bump projects.version; idempotent
//                               (skip when labor_entries already exist for
//                               the day).
//   notify_foreman_decline    — insert a notifications row for the project
//                               foreman.

const testLogger = createLogger('crew-schedule-confirm-runner-test', { level: 'silent' })

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

describe('createCrewScheduleConfirmRunner — drain', () => {
  it('empty pass — no claimed rows → zero summary', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
      return { rows: [] }
    }
    const { pool, released } = makePool(responder)
    const runner = createCrewScheduleConfirmRunner({ pool, logger: testLogger })
    const summary = await runner.drain('co-1')
    expect(summary).toEqual({ processed: 0, materialized: 0, notified: 0, skipped: 0, failed: 0 })
    expect(released[0]).toBe(true)
  })

  it('materialize_labor_entries — inserts one labor_entry per crew worker + bumps project', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'sched-1',
      mutation_type: 'materialize_labor_entries',
      payload: {
        schedule_id: 'sched-1',
        project_id: 'proj-1',
        scheduled_for: '2026-05-15',
        confirmed_by: 'fm-1',
        entries: [
          { worker_id: 'w-1', service_item_code: 'SVC-1', hours: 8, occurred_on: '2026-05-15' },
          { worker_id: 'w-2', service_item_code: 'SVC-1', hours: 6, occurred_on: '2026-05-15' },
        ],
      },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('count(*)') && sql.includes('from labor_entries')) {
        return { rows: [{ n: 0 }], rowCount: 1 } // none yet → materialize
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createCrewScheduleConfirmRunner({ pool, logger: testLogger })
    const summary = await runner.drain('co-1')
    expect(summary).toEqual({ processed: 1, materialized: 1, notified: 0, skipped: 0, failed: 0 })

    const inserts = calls.filter((c) => c.sql.includes('insert into labor_entries'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]!.params[3]).toBe('SVC-1') // service_item_code
    expect(inserts[0]!.params[4]).toBe(8) // hours
    const bump = calls.find((c) => c.sql.includes('update projects set version'))
    expect(bump).toBeDefined()
    const applied = calls.find((c) => c.sql.includes('update mutation_outbox') && c.sql.includes("'applied'"))
    expect(applied).toBeDefined()
  })

  it('materialize_labor_entries — idempotent: existing entries skip insert/bump, still marks applied', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'sched-1',
      mutation_type: 'materialize_labor_entries',
      payload: {
        project_id: 'proj-1',
        scheduled_for: '2026-05-15',
        entries: [{ worker_id: 'w-1', service_item_code: 'SVC-1', hours: 8, occurred_on: '2026-05-15' }],
      },
      attempt_count: 2,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('count(*)') && sql.includes('from labor_entries')) {
        return { rows: [{ n: 2 }], rowCount: 1 } // already materialized
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createCrewScheduleConfirmRunner({ pool, logger: testLogger })
    const summary = await runner.drain('co-1')
    expect(summary).toEqual({ processed: 1, materialized: 1, notified: 0, skipped: 0, failed: 0 })
    // No new inserts, no project bump on the idempotent re-drain.
    expect(calls.find((c) => c.sql.includes('insert into labor_entries'))).toBeUndefined()
    expect(calls.find((c) => c.sql.includes('update projects set version'))).toBeUndefined()
    const applied = calls.find((c) => c.sql.includes('update mutation_outbox') && c.sql.includes("'applied'"))
    expect(applied).toBeDefined()
  })

  it('notify_foreman_decline — inserts a notification for the project foreman', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'sched-1',
      mutation_type: 'notify_foreman_decline',
      payload: { project_id: 'proj-1', scheduled_for: '2026-05-15', reason: 'double-booked', declined_by: 'w-1' },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('from project_assignments')) {
        return { rows: [{ clerk_user_id: 'fm-1' }], rowCount: 1 }
      }
      if (sql.includes('insert into notifications')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createCrewScheduleConfirmRunner({ pool, logger: testLogger })
    const summary = await runner.drain('co-1')
    expect(summary).toEqual({ processed: 1, materialized: 0, notified: 1, skipped: 0, failed: 0 })
    const insert = calls.find((c) => c.sql.includes('insert into notifications'))
    expect(insert).toBeDefined()
    expect(insert!.params[1]).toBe('fm-1')
    expect(insert!.params[2]).toBe('crew_schedule_declined')
    expect(String(insert!.params[4])).toMatch(/double-booked/)
  })

  it('failure path — DB error during materialize → outbox stays pending (retry), failed counter increments', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'sched-1',
      mutation_type: 'materialize_labor_entries',
      payload: {
        project_id: 'proj-1',
        scheduled_for: '2026-05-15',
        entries: [{ worker_id: 'w-1', service_item_code: 'SVC-1', hours: 8, occurred_on: '2026-05-15' }],
      },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('count(*)') && sql.includes('from labor_entries')) {
        return { rows: [{ n: 0 }], rowCount: 1 }
      }
      if (sql.includes('insert into labor_entries')) {
        return new Error('database connection lost')
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createCrewScheduleConfirmRunner({ pool, logger: testLogger })
    const summary = await runner.drain('co-1')
    expect(summary.failed).toBe(1)
    const recovery = calls.find(
      (c) => c.sql.includes('update mutation_outbox') && c.sql.includes('next_attempt_at') && c.sql.includes('error'),
    )
    expect(recovery).toBeDefined()
  })
})

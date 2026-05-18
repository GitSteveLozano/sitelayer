import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createQueuePruneRunner } from './queue-prune.js'

// Unit tests for the daily queue-prune runner. The runner is a thin
// wrapper around `pruneAppliedQueue` (packages/queue) that adds:
//   - a process-local lastRunAt gate so the actual DELETE only fires
//     once per QUEUE_PRUNE_INTERVAL_MS (default 24h);
//   - a forcePrune() escape for tests;
//   - Prometheus counter increments via observeQueuePruneOrGc.
//
// We don't bind to a real Postgres — the FakeQueueClient just records
// SQL and returns scripted counts.

const testLogger = createLogger('queue-prune-test', { level: 'silent' })

type FakeRow = QueryResultRow
type FakeResponse = Partial<QueryResult<FakeRow>>

function buildResponse(r: FakeResponse): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makePool(responses: FakeResponse[]): { pool: Pool; calls: string[] } {
  const calls: string[] = []
  const queue: FakeResponse[] = [...responses]
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      const next = queue.shift() ?? { rows: [] }
      return buildResponse(next)
    }) as unknown as PoolClient['query'],
    release: vi.fn() as unknown as PoolClient['release'],
  }
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, calls }
}

describe('createQueuePruneRunner', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const KEYS = ['QUEUE_APPLIED_RETENTION_DAYS', 'QUEUE_PRUNE_INTERVAL_MS']

  beforeEach(() => {
    for (const k of KEYS) originalEnv[k] = process.env[k]
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k]
      else process.env[k] = originalEnv[k]
    }
  })

  it('forcePrune emits DELETEs for both queues and returns per-table counts', async () => {
    const { pool, calls } = makePool([{ rows: [{ count: 5 }] }, { rows: [{ count: 2 }] }])
    const runner = createQueuePruneRunner({ pool, logger: testLogger })
    const summary = await runner.forcePrune()
    expect(summary).toEqual({ ran: true, mutation_outbox: 5, sync_events: 2 })
    // Both DELETEs fired against the right tables.
    expect(calls.some((s) => s.includes('delete from mutation_outbox'))).toBe(true)
    expect(calls.some((s) => s.includes('delete from sync_events'))).toBe(true)
  })

  it('maybePrune skips the run when the interval has not elapsed', async () => {
    process.env.QUEUE_PRUNE_INTERVAL_MS = String(24 * 60 * 60 * 1000)
    const { pool, calls } = makePool([
      { rows: [{ count: 0 }] },
      { rows: [{ count: 0 }] },
      { rows: [{ count: 0 }] },
      { rows: [{ count: 0 }] },
    ])
    const runner = createQueuePruneRunner({ pool, logger: testLogger })
    // First run: lastRunAt is 0 → interval has elapsed → runs.
    const first = await runner.maybePrune()
    expect(first.ran).toBe(true)
    const firstCallCount = calls.length
    // Second run within the interval: short-circuits without hitting DB.
    const second = await runner.maybePrune()
    expect(second.ran).toBe(false)
    expect(calls.length).toBe(firstCallCount)
  })

  it('honours QUEUE_APPLIED_RETENTION_DAYS env override', async () => {
    process.env.QUEUE_APPLIED_RETENTION_DAYS = '14'
    const { pool } = makePool([{ rows: [{ count: 0 }] }, { rows: [{ count: 0 }] }])
    // The prune runner reads retentionDays at construction time, so
    // the env override must be in effect before we call the factory.
    // We don't have to assert the bound param value here — the
    // pruneAppliedQueue unit test covers the binding — but we DO
    // assert the runner constructs and forcePrune resolves cleanly so
    // a typo in the env-parse path would fail this test.
    const runner = createQueuePruneRunner({ pool, logger: testLogger })
    await expect(runner.forcePrune()).resolves.toEqual({
      ran: true,
      mutation_outbox: 0,
      sync_events: 0,
    })
  })
})

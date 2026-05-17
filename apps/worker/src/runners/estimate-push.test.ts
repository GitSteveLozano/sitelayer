import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { CircuitBreaker } from '@sitelayer/queue'
import { createLogger } from '@sitelayer/logger'
import { createEstimatePushRunner } from './estimate-push.js'

// Unit tests for the estimate-push runner. The runner is a thin wrapper
// around @sitelayer/queue's `processEstimatePush`. We exercise:
//   - Empty pass (no outbox rows claimed → zero summary).
//   - Happy path (stub QBO push returns synthetic id, POST_SUCCEEDED emitted).
//   - Failure path (push fn throws, POST_FAILED path runs).
//   - Idempotency (qbo_estimate_id already set → POST_SUCCEEDED with existing id,
//     no second push).
//
// QBO_LIVE_ESTIMATE_PUSH stays unset so we use the deterministic stub. The
// runner.connect() returns a fake PoolClient whose .query is a programmable
// queue of responses indexed against SQL text fragments.

const testLogger = createLogger('estimate-push-runner-test', { level: 'silent' })

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

describe('createEstimatePushRunner', () => {
  const originalEnv = process.env.QBO_LIVE_ESTIMATE_PUSH

  beforeEach(() => {
    delete process.env.QBO_LIVE_ESTIMATE_PUSH
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QBO_LIVE_ESTIMATE_PUSH
    else process.env.QBO_LIVE_ESTIMATE_PUSH = originalEnv
  })

  describe('empty pass', () => {
    it('returns zero summary when no outbox rows are claimed', async () => {
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
        return { rows: [] }
      }
      const { pool, released } = makePool(responder)
      const drain = createEstimatePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 0, posted: 0, failed: 0, skipped: 0 })
      // Client released even when empty.
      expect(released[0]).toBe(true)
    })
  })

  describe('happy path (stub QBO)', () => {
    it('claims one row, runs stub push, emits POST_SUCCEEDED, marks outbox applied', async () => {
      // Sequence: BEGIN, claim (1 row), COMMIT, BEGIN, existence-check
      // (qbo_estimate_id NULL), [stub push, no SQL], lock-for-update (status=posting),
      // update to posted, workflow_event_log insert, sync_events insert,
      // mutation_outbox set 'applied', COMMIT.
      const claimedRow = {
        id: 'outbox-1',
        entity_id: 'push-1',
        payload: { estimate_push_id: 'push-1' },
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const lockedRow = {
        id: 'push-1',
        status: 'posting',
        state_version: 4,
        qbo_estimate_id: null,
        reviewed_at: null,
        reviewed_by: null,
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
      }
      const postedRow = { ...lockedRow, status: 'posted', state_version: 5, qbo_estimate_id: 'STUB-EST-push-1-x' }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_estimate_id, status from estimate_pushes')) {
          return { rows: [{ qbo_estimate_id: null, status: 'posting' }], rowCount: 1 }
        }
        if (sql.includes('for update') && sql.includes('estimate_pushes')) {
          return { rows: [lockedRow], rowCount: 1 }
        }
        if (sql.includes('update estimate_pushes') && sql.includes("'posted'")) {
          return { rows: [postedRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createEstimatePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

      // Workflow event row inserted.
      const wfInsert = calls.find((c) => c.sql.includes('insert into workflow_event_log'))
      expect(wfInsert).toBeDefined()
      // Sync event row inserted.
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      expect(syncInsert).toBeDefined()
      // Outbox marked applied.
      const appliedUpdate = calls.find((c) => c.sql.includes("update mutation_outbox set status = 'applied'"))
      expect(appliedUpdate).toBeDefined()
    })
  })

  describe('failure path', () => {
    it('emits POST_FAILED + marks outbox failed when estimate_push row vanished', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: 'push-missing',
        payload: {},
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_estimate_id, status from estimate_pushes')) {
          // entity vanished — empty result triggers the entity_not_found path
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createEstimatePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, posted: 0, failed: 1, skipped: 0 })
      // outbox marked failed
      const failedUpdate = calls.find((c) => c.sql.includes("update mutation_outbox set status = 'failed'"))
      expect(failedUpdate).toBeDefined()
    })
  })

  describe('idempotency', () => {
    it('skips QBO push when qbo_estimate_id already set (re-run is a no-op)', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: 'push-1',
        payload: {},
        attempt_count: 2,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const existingPushed = {
        id: 'push-1',
        status: 'posting',
        state_version: 4,
        qbo_estimate_id: 'qbo-EST-existing',
        reviewed_at: null,
        reviewed_by: null,
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
      }
      const postedRow = { ...existingPushed, status: 'posted', state_version: 5 }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_estimate_id, status from estimate_pushes')) {
          return {
            rows: [{ qbo_estimate_id: 'qbo-EST-existing', status: 'posting' }],
            rowCount: 1,
          }
        }
        if (sql.includes('for update') && sql.includes('estimate_pushes')) {
          return { rows: [existingPushed], rowCount: 1 }
        }
        if (sql.includes('update estimate_pushes') && sql.includes("'posted'")) {
          return { rows: [postedRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createEstimatePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, posted: 0, failed: 0, skipped: 1 })
      // The sync_events row tagged idempotent_replay
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      expect(syncInsert).toBeDefined()
      const payload = JSON.parse(String(syncInsert!.params[2]))
      expect(payload.idempotent_replay).toBe(true)
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { CircuitBreaker } from '@sitelayer/queue'
import { createLogger } from '@sitelayer/logger'
import { createRentalBillingPushRunner } from './rental-billing-push.js'

// Unit tests for the rental-billing-push runner.
//
// The runner is a thin wrapper around `processRentalBillingInvoicePush` from
// @sitelayer/queue. Stub mode (QBO_LIVE_RENTAL_INVOICE unset, the default)
// returns a DETERMINISTIC synthetic invoice id derived from `runId.slice(0,8)`
// — that "same runId → same stub id" contract is the load-bearing safety net
// for replay-after-crash. We verify the contract directly here.

const testLogger = createLogger('rental-billing-push-runner-test', { level: 'silent' })

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

const RUN_ID = 'abcdef12-3456-7890-abcd-ef1234567890'
const RUN_ID_PREFIX = RUN_ID.slice(0, 8) // 'abcdef12'

describe('createRentalBillingPushRunner', () => {
  const originalEnv = process.env.QBO_LIVE_RENTAL_INVOICE

  beforeEach(() => {
    delete process.env.QBO_LIVE_RENTAL_INVOICE
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QBO_LIVE_RENTAL_INVOICE
    else process.env.QBO_LIVE_RENTAL_INVOICE = originalEnv
  })

  describe('empty pass', () => {
    it('returns zero summary when no outbox rows are claimed', async () => {
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
        return { rows: [] }
      }
      const { pool, released } = makePool(responder)
      const drain = createRentalBillingPushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 0, posted: 0, failed: 0, skipped: 0 })
      expect(released[0]).toBe(true)
    })
  })

  describe('happy path (stub returns deterministic synthetic id)', () => {
    it('emits POST_SUCCEEDED with `STUB-INV-<runId.slice(0,8)>` and marks outbox applied', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: RUN_ID,
        payload: {},
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const lockedRow = {
        id: RUN_ID,
        status: 'posting',
        state_version: 3,
        qbo_invoice_id: null,
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
      }
      const postedRow = {
        ...lockedRow,
        status: 'posted',
        state_version: 4,
        qbo_invoice_id: `STUB-INV-${RUN_ID_PREFIX}`,
      }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_invoice_id, status from rental_billing_runs')) {
          return { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 }
        }
        if (sql.includes('for update') && sql.includes('rental_billing_runs')) {
          return { rows: [lockedRow], rowCount: 1 }
        }
        if (sql.includes('update rental_billing_runs') && sql.includes('qbo_invoice_id = $10')) {
          return { rows: [postedRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalBillingPushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

      // The deterministic stub id appears in the reducer snapshot update param ($10 = qbo_invoice_id).
      const update = calls.find(
        (c) => c.sql.includes('update rental_billing_runs') && c.sql.includes('qbo_invoice_id = $10'),
      )
      expect(update?.params[9]).toBe(`STUB-INV-${RUN_ID_PREFIX}`)

      // The sync_events insert payload also carries the same stub id.
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      expect(syncInsert).toBeDefined()
      const payload = JSON.parse(String(syncInsert!.params[2]))
      expect(payload.external_id).toBe(`STUB-INV-${RUN_ID_PREFIX}`)
    })

    it('produces the same synthetic id on re-run with the same runId (replay-safe)', async () => {
      // Run the drain twice with the same outbox row claim and check the
      // stub id remains stable. This is the "same runId → same stub id"
      // contract that lets a re-claim after crash recover safely.
      const claimedRow = {
        id: 'outbox-1',
        entity_id: RUN_ID,
        payload: {},
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const lockedRow = {
        id: RUN_ID,
        status: 'posting',
        state_version: 3,
        qbo_invoice_id: null,
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
      }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_invoice_id, status from rental_billing_runs')) {
          return { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 }
        }
        if (sql.includes('for update') && sql.includes('rental_billing_runs')) {
          return { rows: [lockedRow], rowCount: 1 }
        }
        if (sql.includes('update rental_billing_runs') && sql.includes('qbo_invoice_id = $10')) {
          return { rows: [{ ...lockedRow, status: 'posted', state_version: 4 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalBillingPushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      await drain('co-1')
      const update = calls.find(
        (c) => c.sql.includes('update rental_billing_runs') && c.sql.includes('qbo_invoice_id = $10'),
      )
      const observed = String(update!.params[9])

      // Second drain on the same runId.
      const { pool: pool2, calls: calls2 } = makePool(responder)
      const drain2 = createRentalBillingPushRunner({ pool: pool2, logger: testLogger, qboCircuit: makeBreaker() })
      await drain2('co-1')
      const update2 = calls2.find(
        (c) => c.sql.includes('update rental_billing_runs') && c.sql.includes('qbo_invoice_id = $10'),
      )
      const observed2 = String(update2!.params[9])

      expect(observed).toBe(observed2)
      expect(observed).toBe(`STUB-INV-${RUN_ID_PREFIX}`)
    })
  })

  describe('failure path', () => {
    it('marks outbox failed and counts a failure when run is missing', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: 'run-missing',
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
        if (sql.includes('select qbo_invoice_id, status from rental_billing_runs')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalBillingPushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary.failed).toBe(1)
      const failedUpdate = calls.find((c) => c.sql.includes("update mutation_outbox set status = 'failed'"))
      expect(failedUpdate).toBeDefined()
    })
  })

  describe('idempotency', () => {
    it('skips push when qbo_invoice_id is already present (state=posting)', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: RUN_ID,
        payload: {},
        attempt_count: 2,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }
      const existing = {
        id: RUN_ID,
        status: 'posting',
        state_version: 3,
        qbo_invoice_id: 'qbo-INV-prev',
        approved_at: null,
        approved_by: null,
        posted_at: null,
        failed_at: null,
        error: null,
      }
      const responder: Responder = (sql) => {
        if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (sql.includes('select qbo_invoice_id, status from rental_billing_runs')) {
          return { rows: [{ qbo_invoice_id: 'qbo-INV-prev', status: 'posting' }], rowCount: 1 }
        }
        if (sql.includes('for update') && sql.includes('rental_billing_runs')) {
          return { rows: [existing], rowCount: 1 }
        }
        if (sql.includes('update rental_billing_runs') && sql.includes('qbo_invoice_id = $10')) {
          return { rows: [{ ...existing, status: 'posted', state_version: 4 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalBillingPushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary.skipped).toBe(1)
      expect(summary.posted).toBe(0)
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      const payload = JSON.parse(String(syncInsert!.params[2]))
      expect(payload.idempotent_replay).toBe(true)
      expect(payload.external_id).toBe('qbo-INV-prev')
    })
  })
})

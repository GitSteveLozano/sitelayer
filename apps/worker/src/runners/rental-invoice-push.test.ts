import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { CircuitBreaker } from '@sitelayer/queue'
import { createLogger } from '@sitelayer/logger'
import { createRentalInvoicePushRunner } from './rental-invoice-push.js'

// Unit tests for the rental-invoice cadence push runner.
//
// MIRRORS rental-billing-push.test.ts. The runner is a thin wrapper around
// `processRentalInvoicePush` from @sitelayer/queue. Stub mode
// (QBO_LIVE_RENTAL_INVOICE unset, the default) returns a DETERMINISTIC
// synthetic invoice id derived from `rentalId.slice(0,8)` — that
// "same rentalId → same stub id" contract is the load-bearing safety net for
// replay-after-crash. We verify the contract + the INVOICE_QUEUED/INVOICE_POSTED
// cadence dispatch directly here.

const testLogger = createLogger('rental-invoice-push-runner-test', { level: 'silent' })

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

const RENTAL_ID = 'abcdef12-3456-7890-abcd-ef1234567890'
const RENTAL_ID_PREFIX = RENTAL_ID.slice(0, 8) // 'abcdef12'

describe('createRentalInvoicePushRunner', () => {
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
      const drain = createRentalInvoicePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 0, posted: 0, failed: 0, skipped: 0 })
      expect(released[0]).toBe(true)
    })
  })

  describe('happy path (stub returns deterministic synthetic id)', () => {
    it('dispatches INVOICE_QUEUED + INVOICE_POSTED with the stub id and marks outbox applied', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: RENTAL_ID,
        payload: { amount: 70, invoiced_through: '2026-01-08' },
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
        capture_session_id: null,
      }
      const lockedRental = {
        id: RENTAL_ID,
        status: 'returned',
        state_version: 5,
        returned_at: '2026-01-20T00:00:00.000Z',
        returned_by: 'u-1',
        closed_at: null,
        closed_by: null,
      }
      const responder: Responder = (sql) => {
        const s = sql.toLowerCase()
        if (s.includes('update mutation_outbox') && s.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (s.includes('select status, state_version from rentals')) {
          return { rows: [{ status: 'returned', state_version: 5 }], rowCount: 1 }
        }
        if (s.includes('for update') && s.includes('from rentals')) {
          return { rows: [lockedRental], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalInvoicePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

      const eventInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into workflow_event_log'))
      const eventTypes = eventInserts.map((c) => c.params[6]) // event_type is the 7th column
      expect(eventTypes).toContain('INVOICE_QUEUED')
      expect(eventTypes).toContain('INVOICE_POSTED')
      // INVOICE_QUEUED recorded at the locked state_version (5), POSTED at +1 (6).
      const queued = eventInserts.find((c) => c.params[6] === 'INVOICE_QUEUED')
      const posted = eventInserts.find((c) => c.params[6] === 'INVOICE_POSTED')
      expect(queued?.params[5]).toBe(5)
      expect(posted?.params[5]).toBe(6)
      expect(queued?.sql.toLowerCase()).toContain('on conflict (entity_id, workflow_name, state_version) do nothing')

      // The deterministic stub id lands in the sync_events audit payload.
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      expect(syncInsert).toBeDefined()
      const payload = JSON.parse(String(syncInsert!.params[2]))
      expect(payload.external_id).toBe(`STUB-RENT-INV-${RENTAL_ID_PREFIX}`)
    })
  })

  describe('idempotent replay', () => {
    it('skips (no push) when the rental already moved off returned', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: RENTAL_ID,
        payload: { amount: 70 },
        attempt_count: 2,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
        capture_session_id: null,
      }
      const responder: Responder = (sql) => {
        const s = sql.toLowerCase()
        if (s.includes('update mutation_outbox') && s.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (s.includes('select status, state_version from rentals')) {
          // Already cycled back / closed — pusher must NOT re-push.
          return { rows: [{ status: 'closed', state_version: 8 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalInvoicePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary.skipped).toBe(1)
      expect(summary.posted).toBe(0)
      const eventInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into workflow_event_log'))
      expect(eventInserts).toHaveLength(0)
      const syncInsert = calls.find((c) => c.sql.includes('insert into sync_events'))
      const payload = JSON.parse(String(syncInsert!.params[2]))
      expect(payload.idempotent_replay).toBe(true)
    })
  })

  describe('failure path', () => {
    it('marks outbox failed and counts a failure when the rental is missing', async () => {
      const claimedRow = {
        id: 'outbox-1',
        entity_id: 'rental-missing',
        payload: {},
        attempt_count: 1,
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
        capture_session_id: null,
      }
      const responder: Responder = (sql) => {
        const s = sql.toLowerCase()
        if (s.includes('update mutation_outbox') && s.includes("'processing'")) {
          return { rows: [claimedRow], rowCount: 1 }
        }
        if (s.includes('select status, state_version from rentals')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const drain = createRentalInvoicePushRunner({ pool, logger: testLogger, qboCircuit: makeBreaker() })
      const summary = await drain('co-1')
      expect(summary.failed).toBe(1)
      const failedUpdate = calls.find((c) => c.sql.includes("update mutation_outbox set status = 'failed'"))
      expect(failedUpdate).toBeDefined()
    })
  })
})

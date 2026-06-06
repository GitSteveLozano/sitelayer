import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createRentalInvoiceRunner } from './rental-invoice.js'

// Unit test for the rental-invoice runner's Phase 2 cadence ENQUEUE.
//
// Phase 1 emitted the INVOICE_QUEUED/INVOICE_POSTED cadence transitions inline.
// Phase 2 (this version) mirrors rental_billing_run: the runner bills a due
// rental and, for an already-RETURNED rental that produced a bill, enqueues a
// post_rental_invoice mutation_outbox row (idempotency-keyed on the rental's
// pre-push state_version). The dedicated pusher (rental-invoice-push.ts) then
// runs the gated QBO push and dispatches the cadence transitions. Here we
// drive the runner against a SQL-pattern-matching fake client and assert the
// enqueue happens for a RETURNED rental and NOT for an ACTIVE one.

const testLogger = createLogger('rental-invoice-runner-test', { level: 'silent' })

type FakeRow = QueryResultRow
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

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

function makePool(responder: Responder): { pool: Pool; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ sql, params: params ?? [] })
      const r = responder(sql, params ?? [])
      if (r instanceof Error) throw r
      return buildResponse(r ?? {})
    }) as unknown as PoolClient['query'],
    release: vi.fn() as unknown as PoolClient['release'],
  }
  const pool: Partial<Pool> = { connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'] }
  return { pool: pool as Pool, calls }
}

const COMPANY = 'co-1'
const RENTAL_ID = '00000000-0000-0000-0000-0000000000aa'

function dueRow(status: 'active' | 'returned'): FakeRow {
  // A rental due for invoicing: delivered a while ago, cadence elapsed, so
  // calculateRentalInvoice produces days>0 / amount>0 and a material_bill.
  return {
    id: RENTAL_ID,
    company_id: COMPANY,
    project_id: '00000000-0000-0000-0000-0000000000bb',
    customer_id: '00000000-0000-0000-0000-0000000000cc',
    item_description: 'Scaffold tower',
    daily_rate: '10.00',
    delivered_on: '2026-01-01',
    returned_on: status === 'returned' ? '2026-01-20' : null,
    next_invoice_at: '2026-01-08T00:00:00.000Z',
    invoice_cadence_days: 7,
    last_invoice_amount: null,
    last_invoiced_through: null,
    status,
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeResponder(status: 'active' | 'returned', stateVersion = 1): Responder {
  return (sql) => {
    const s = sql.toLowerCase()
    if (s.includes('from rentals') && s.includes('next_invoice_at <= now()')) {
      return { rows: [dueRow(status)] }
    }
    if (s.includes('insert into material_bills')) {
      return {
        rows: [
          {
            id: 'bill-1',
            project_id: 'p',
            vendor_name: 'v',
            amount: '70.00',
            bill_type: 'rental',
            description: 'd',
            occurred_on: '2026-01-08',
            created_at: 'now',
          },
        ],
      }
    }
    if (s.includes('select state_version, status from rentals')) {
      return { rows: [{ state_version: stateVersion, status }] }
    }
    if (s.includes('update rentals')) {
      // processRentalInvoice's clock-advance update.
      return { rows: [dueRow(status)] }
    }
    // recordLedger inserts, sync_events, begin/commit/guc, etc.
    return { rows: [] }
  }
}

describe('rental-invoice runner — Phase 2 cadence enqueue', () => {
  it('enqueues a post_rental_invoice outbox row for a RETURNED rental that bills', async () => {
    const { pool, calls } = makePool(makeResponder('returned', 5))
    const runner = createRentalInvoiceRunner({ pool, logger: testLogger })
    const summary = await runner(COMPANY)

    expect(summary.billed).toBe(1)

    // recordLedger writes the outbox row; mutation_type is the 6th param.
    const outboxInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into mutation_outbox'))
    const enqueue = outboxInserts.find((c) => c.params[5] === 'post_rental_invoice')
    expect(enqueue).toBeDefined()
    // idempotency_key (8th param) is versioned on the pre-push state_version (5).
    expect(enqueue?.params[7]).toBe(`rental:invoice_push:${RENTAL_ID}:5`)

    // The runner must NOT dispatch cadence transitions itself anymore — that's
    // the pusher's job. No workflow_event_log writes here.
    const eventInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into workflow_event_log'))
    expect(eventInserts).toHaveLength(0)
  })

  it('enqueues NO cadence push for an ACTIVE rental', async () => {
    const { pool, calls } = makePool(makeResponder('active', 3))
    const runner = createRentalInvoiceRunner({ pool, logger: testLogger })
    await runner(COMPANY)
    const outboxInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into mutation_outbox'))
    const enqueue = outboxInserts.find((c) => c.params[5] === 'post_rental_invoice')
    expect(enqueue).toBeUndefined()
  })
})

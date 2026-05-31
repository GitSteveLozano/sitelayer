import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createRentalInvoiceRunner } from './rental-invoice.js'

// Unit test for the rental-invoice runner's worker-only cadence dispatch
// (INVOICE_QUEUED / INVOICE_POSTED). The runner is a thin wrapper around
// @sitelayer/queue's fetchDueRentals/processRentalInvoice; here we drive it
// against a SQL-pattern-matching fake client and assert that an already-
// RETURNED rental that gets billed emits the two cadence event-log rows and
// advances state_version, while an ACTIVE rental emits none.

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
    if (s.startsWith('update rentals') || s.includes('update\n      rentals') || s.includes('update rentals')) {
      // processRentalInvoice's clock-advance update and our state_version bump.
      return { rows: [dueRow(status)] }
    }
    if (s.includes('select state_version, status from rentals')) {
      return { rows: [{ state_version: stateVersion, status }] }
    }
    // recordLedger inserts, sync_events, begin/commit/guc, etc.
    return { rows: [] }
  }
}

describe('rental-invoice runner — worker cadence dispatch', () => {
  it('emits INVOICE_QUEUED + INVOICE_POSTED for a RETURNED rental that bills', async () => {
    const { pool, calls } = makePool(makeResponder('returned', 5))
    const runner = createRentalInvoiceRunner({ pool, logger: testLogger })
    const summary = await runner(COMPANY)

    expect(summary.billed).toBe(1)
    const eventInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into workflow_event_log'))
    const eventTypes = eventInserts.map((c) => c.params[6]) // event_type is the 7th column
    expect(eventTypes).toContain('INVOICE_QUEUED')
    expect(eventTypes).toContain('INVOICE_POSTED')
    // INVOICE_QUEUED recorded at the row's state_version (5), POSTED at +1 (6).
    const queued = eventInserts.find((c) => c.params[6] === 'INVOICE_QUEUED')
    const posted = eventInserts.find((c) => c.params[6] === 'INVOICE_POSTED')
    expect(queued?.params[5]).toBe(5)
    expect(posted?.params[5]).toBe(6)
    // The conflict guard must be the idempotent worker variant.
    expect(queued?.sql.toLowerCase()).toContain('on conflict (entity_id, state_version) do nothing')
  })

  it('emits NO cadence events for an ACTIVE rental', async () => {
    const { pool, calls } = makePool(makeResponder('active', 3))
    const runner = createRentalInvoiceRunner({ pool, logger: testLogger })
    await runner(COMPANY)
    const eventInserts = calls.filter((c) => c.sql.toLowerCase().includes('insert into workflow_event_log'))
    expect(eventInserts).toHaveLength(0)
  })
})

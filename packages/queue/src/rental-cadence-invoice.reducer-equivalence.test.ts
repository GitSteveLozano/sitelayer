import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { transitionRentalWorkflow, type RentalWorkflowSnapshot } from '@sitelayer/workflows'
import { processRentalInvoicePush, type RentalInvoicePushFn } from './pushers/rental-cadence-invoice.js'
import type { QueueClient } from './index.js'

/**
 * The rental-cadence worker (Phase 2 of the `rental` workflow) has NO
 * independent transition table. For a `returned`-state rental, the cadence
 * cycle it walks — `returned → INVOICE_QUEUED → invoiced_pending →
 * INVOICE_POSTED → returned` — and the state_version it persists MUST equal the
 * pure reducer's output for the same two worker events. If the reducer's
 * cadence rule ever changes, this test breaks unless the worker follows —
 * which it does, because the pusher CALLS transitionRentalWorkflow. Twin of
 * rental-billing-invoice.reducer-equivalence.test.ts and
 * estimate-push.reducer-equivalence.test.ts.
 *
 * It also pins the two non-reducer guarantees the cadence path is responsible
 * for: the QBO invoice id is carried on BOTH workflow_event_log payloads, and a
 * rental that already moved off `returned` (idempotent replay / human CLOSE
 * race) is marked applied WITHOUT a re-push or any event-log write.
 */

type QueuedResponse<T extends QueryResultRow = QueryResultRow> = Pick<QueryResult<T>, 'rows' | 'rowCount'> | Error

class FakeQueueClient implements QueueClient {
  readonly calls: Array<{ text: string; values?: unknown[] }> = []

  constructor(private readonly responses: QueuedResponse[] = []) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    this.calls.push(values ? { text, values } : { text })
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return {
      rows: (response?.rows ?? []) as T[],
      rowCount: response?.rowCount ?? 0,
      command: '',
      oid: 0,
      fields: [],
    }
  }
}

const TX = { rows: [] as never[], rowCount: null as number | null }

const COMPANY = 'company-1'
const RENTAL_ID = 'rental-aa'

// A returned-state rental exactly as the cadence pusher locks it
// (FOR UPDATE select inside applyRentalCadenceTransitions).
const RETURNED_ROW = {
  id: RENTAL_ID,
  status: 'returned',
  state_version: 5,
  returned_at: '2026-01-20T00:00:00.000Z',
  returned_by: 'office-user',
  closed_at: null,
  closed_by: null,
}

function returnedSnapshot(): RentalWorkflowSnapshot {
  return {
    state: 'returned',
    state_version: RETURNED_ROW.state_version,
    returned_at: RETURNED_ROW.returned_at,
    returned_by: RETURNED_ROW.returned_by,
    closed_at: null,
    closed_by: null,
  }
}

/** Pull the UPDATE-rentals call (the state_version persist) bound values. */
function findStateVersionUpdate(client: FakeQueueClient): unknown[] {
  const call = client.calls.find((c) =>
    /update rentals set state_version = \$3, version = version \+ 1/i.test(c.text.replace(/\s+/g, ' ')),
  )
  expect(call, 'expected an UPDATE rentals ... set state_version=$3 call').toBeTruthy()
  return call!.values!
}

/** All workflow_event_log inserts the pusher issued, with their bound values. */
function eventLogInserts(client: FakeQueueClient): Array<{ text: string; values?: unknown[] }> {
  return client.calls.filter((c) => /insert into workflow_event_log/i.test(c.text))
}

describe('processRentalInvoicePush — cadence write equals reducer output', () => {
  it('returned rental: cadence advances state_version exactly two reducer steps, lands back at returned', async () => {
    const push: RentalInvoicePushFn = async () => ({ qbo_invoice_id: 'qbo-RENT-777' })

    const responses: QueuedResponse[] = [
      TX, // begin (claim)
      { rows: [{ id: 'outbox-1', entity_id: RENTAL_ID, payload: {}, attempt_count: 1 }], rowCount: 1 },
      TX, // commit (claim)
      TX, // begin (row work)
      { rows: [{ status: 'returned', state_version: 5 }], rowCount: 1 }, // existence check
      { rows: [RETURNED_ROW], rowCount: 1 }, // lock (FOR UPDATE) in applyRentalCadenceTransitions
      { rows: [], rowCount: 1 }, // workflow_event_log INVOICE_QUEUED
      { rows: [], rowCount: 1 }, // workflow_event_log INVOICE_POSTED
      { rows: [], rowCount: 1 }, // update rentals (state_version persist)
      { rows: [], rowCount: 1 }, // sync_events insert
      { rows: [], rowCount: 1 }, // mutation_outbox applied
      TX, // commit
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processRentalInvoicePush(client, COMPANY, push, 5)
    expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

    // Recompute the reducer output for the two cadence events.
    const queued = transitionRentalWorkflow(returnedSnapshot(), { type: 'INVOICE_QUEUED' })
    const posted = transitionRentalWorkflow(queued, { type: 'INVOICE_POSTED' })
    expect(queued.state).toBe('invoiced_pending')
    expect(posted.state).toBe('returned')
    expect(posted.state_version).toBe(7) // 5 → 6 → 7

    // The persisted state_version MUST equal the reducer's two-step output, and
    // the optimistic guard ($4) MUST be the version read under the lock.
    const updateValues = findStateVersionUpdate(client)
    expect(updateValues[0]).toBe(COMPANY)
    expect(updateValues[1]).toBe(RENTAL_ID)
    expect(updateValues[2]).toBe(posted.state_version) // $3 new state_version = 7
    expect(updateValues[3]).toBe(RETURNED_ROW.state_version) // $4 guard = pre-cadence version (5)

    // Two event-log rows, recorded at the pre-transition versions (5 then 6),
    // each carrying the QBO invoice id on its payload.
    const inserts = eventLogInserts(client)
    expect(inserts).toHaveLength(2)
    // buildWorkflowEventLogInsert binds: $6 stateVersion, $7 eventType,
    // $8 JSON.stringify(eventPayload). Parse the payload param (index 7).
    const payloads = inserts.map((c) => JSON.parse((c.values ?? [])[7] as string) as Record<string, unknown>)
    const stateVersions = inserts.map((c) => (c.values ?? [])[5] as number)
    // Each event is recorded at the PRE-transition state_version: 5 then 6.
    expect(stateVersions).toEqual([5, 6])
    expect(payloads[0]).toMatchObject({ type: 'INVOICE_QUEUED', qbo_invoice_id: 'qbo-RENT-777' })
    expect(payloads[1]).toMatchObject({ type: 'INVOICE_POSTED', qbo_invoice_id: 'qbo-RENT-777' })
  })

  it('idempotent replay: a rental already off `returned` is marked applied with no re-push and no event-log write', async () => {
    let pushed = 0
    const push: RentalInvoicePushFn = async () => {
      pushed += 1
      return { qbo_invoice_id: 'should-not-happen' }
    }

    const responses: QueuedResponse[] = [
      TX, // begin (claim)
      { rows: [{ id: 'outbox-1', entity_id: RENTAL_ID, payload: {}, attempt_count: 2 }], rowCount: 1 },
      TX, // commit (claim)
      TX, // begin (row work)
      { rows: [{ status: 'closed', state_version: 9 }], rowCount: 1 }, // existence check: NOT returned
      { rows: [], rowCount: 1 }, // sync_events (idempotent_replay audit)
      { rows: [], rowCount: 1 }, // mutation_outbox applied
      TX, // commit
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processRentalInvoicePush(client, COMPANY, push, 5)

    expect(summary).toEqual({ processed: 1, posted: 0, failed: 0, skipped: 1 })
    expect(pushed).toBe(0) // no QBO push for a superseded rental
    expect(eventLogInserts(client)).toHaveLength(0) // no cadence transitions recorded
    // The outbox row is still marked applied so the queue un-sticks.
    const applied = client.calls.find((c) =>
      /update mutation_outbox set status = 'applied'/i.test(c.text.replace(/\s+/g, ' ')),
    )
    expect(applied).toBeTruthy()
  })

  it('push failure: outbox row is failed and no state_version is persisted', async () => {
    const push: RentalInvoicePushFn = async () => {
      throw new Error('qbo exploded')
    }

    const responses: QueuedResponse[] = [
      TX, // begin (claim)
      { rows: [{ id: 'outbox-1', entity_id: RENTAL_ID, payload: {}, attempt_count: 1 }], rowCount: 1 },
      TX, // commit (claim)
      TX, // begin (row work)
      { rows: [{ status: 'returned', state_version: 5 }], rowCount: 1 }, // existence check
      // push() throws here
      TX, // rollback after push throws
      TX, // begin (failed-sync_event audit)
      { rows: [], rowCount: 1 }, // sync_events (invoice_failed)
      TX, // commit (audit)
      { rows: [], rowCount: 1 }, // markOutboxRowFailedFresh
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processRentalInvoicePush(client, COMPANY, push, 5)

    expect(summary.failed).toBe(1)
    expect(summary.posted).toBe(0)
    // No cadence transition persisted on a failed push.
    expect(eventLogInserts(client)).toHaveLength(0)
    const stateVersionUpdate = client.calls.find((c) =>
      /update rentals set state_version/i.test(c.text.replace(/\s+/g, ' ')),
    )
    expect(stateVersionUpdate).toBeUndefined()
  })
})

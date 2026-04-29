import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  DEDICATED_HANDLER_MUTATION_TYPES,
  processOutboxBatch,
  processQueue,
  processQueueWithClient,
  processRentalBillingInvoicePush,
  type QueueClient,
  type ReleasableQueueClient,
  type RentalBillingInvoicePushFn,
} from './index.js'

type QueuedResponse<T extends QueryResultRow = QueryResultRow> = Pick<QueryResult<T>, 'rows' | 'rowCount'> | Error

class FakeQueueClient implements ReleasableQueueClient {
  readonly calls: Array<{ text: string; values?: unknown[] }> = []
  released = false

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

  release(): void {
    this.released = true
  }
}

function sqlCalls(client: FakeQueueClient) {
  return client.calls.map((call) => call.text.replace(/\s+/g, ' ').trim())
}

describe('queue processing', () => {
  it('claims ready outbox and sync rows with leases, applies them, and touches integration state', async () => {
    const client = new FakeQueueClient([
      { rows: [{ id: '00000000-0000-0000-0000-000000000001' }], rowCount: 1 },
      {
        rows: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            entity_type: 'project',
            entity_id: 'project-1',
            mutation_type: 'update',
            attempt_count: 1,
            created_at: '2026-04-24T00:00:00.000Z',
            sentry_trace: null,
            sentry_baggage: null,
            request_id: null,
          },
        ],
        rowCount: 1,
      },
      { rows: [{ id: '00000000-0000-0000-0000-000000000002' }], rowCount: 1 },
      {
        rows: [
          {
            id: '00000000-0000-0000-0000-000000000002',
            entity_type: 'customer',
            entity_id: 'customer-1',
            direction: 'inbound',
            attempt_count: 1,
            created_at: '2026-04-24T00:00:00.000Z',
            sentry_trace: null,
            sentry_baggage: null,
            request_id: null,
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
    ])

    const result = await processQueueWithClient(client, 'company-1', 10)
    const queries = sqlCalls(client)

    expect(result.processedOutboxCount).toBe(1)
    expect(result.processedSyncEventCount).toBe(1)
    expect(result.outbox[0]?.attempt_count).toBe(1)
    expect(result.syncEvents[0]?.direction).toBe('inbound')
    expect(queries[0]).toContain('update mutation_outbox')
    expect(queries[0]).toContain('for update skip locked')
    expect(queries[0]).toContain("next_attempt_at = now() + interval '5 minutes'")
    expect(queries[2]).toContain('update sync_events')
    expect(queries[2]).toContain('for update skip locked')
    expect(queries[4]).toContain('update integration_connections')
  })

  it('does not update integration state when no rows are ready', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ])

    const result = await processQueueWithClient(client, 'company-1', 25)

    expect(result.processedOutboxCount).toBe(0)
    expect(result.processedSyncEventCount).toBe(0)
    expect(sqlCalls(client).some((query) => query.includes('update integration_connections'))).toBe(false)
  })

  it('returns persisted trace context on processed outbox rows', async () => {
    const client = new FakeQueueClient([
      { rows: [{ id: '00000000-0000-0000-0000-000000000003' }], rowCount: 1 },
      {
        rows: [
          {
            id: '00000000-0000-0000-0000-000000000003',
            entity_type: 'project',
            entity_id: 'project-1',
            mutation_type: 'create',
            attempt_count: 1,
            created_at: '2026-04-24T00:00:00.000Z',
            sentry_trace: '0123456789abcdef0123456789abcdef-0123456789abcdef-1',
            sentry_baggage: 'sentry-environment=preview',
            request_id: 'req_trace',
          },
        ],
        rowCount: 1,
      },
    ])

    const rows = await processOutboxBatch(client, 'company-1', 10)

    expect(rows[0]).toMatchObject({
      sentry_trace: '0123456789abcdef0123456789abcdef-0123456789abcdef-1',
      sentry_baggage: 'sentry-environment=preview',
      request_id: 'req_trace',
    })
  })

  it('commits and releases the client on success', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ])
    const pool = { connect: async () => client }

    await processQueue(pool, 'company-1')

    expect(sqlCalls(client)).toEqual(expect.arrayContaining(['begin', 'commit']))
    expect(client.released).toBe(true)
  })

  it('rolls back and releases the client on failure', async () => {
    const client = new FakeQueueClient([new Error('claim failed')])
    const pool = { connect: async () => client }

    await expect(processQueue(pool, 'company-1')).rejects.toThrow('claim failed')

    expect(sqlCalls(client)).toEqual(expect.arrayContaining(['begin', 'rollback']))
    expect(client.released).toBe(true)
  })

  it('accepts pg-compatible clients structurally', async () => {
    const client: QueueClient = new FakeQueueClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ])

    await expect(processQueueWithClient(client, 'company-1')).resolves.toMatchObject({
      processedOutboxCount: 0,
      processedSyncEventCount: 0,
    })
  })

  it('exposes post_qbo_invoice in DEDICATED_HANDLER_MUTATION_TYPES so the generic drain skips it', () => {
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('post_qbo_invoice')
  })

  it('generic processOutboxBatch passes the dedicated-handler list to SQL', async () => {
    const client = new FakeQueueClient([{ rows: [], rowCount: 0 }])
    await processOutboxBatch(client, 'company-1', 5)
    expect(client.calls[0]?.values).toBeDefined()
    // Third bound param is the dedicated-handler exclusion list.
    const handlerList = client.calls[0]!.values![2]
    expect(handlerList).toEqual(['post_qbo_invoice', 'post_qbo_estimate'])
  })
})

describe('processRentalBillingInvoicePush', () => {
  // Builds a FakeQueueClient response stack matching the SQL order of the
  // happy path:
  //   1. claim mutation_outbox row (returns one row)
  //   2. select rental_billing_runs (qbo_invoice_id, status) → not yet posted
  //   3. lock rental_billing_runs for update → status='posting'
  //   4. update rental_billing_runs to 'posted'
  //   5. insert sync_events
  //   6. update mutation_outbox to applied
  function happyPathResponses(runId: string) {
    return [
      // 1. claim
      {
        rows: [
          {
            id: 'outbox-1',
            entity_id: runId,
            payload: { billing_run_id: runId, lines: [] },
            attempt_count: 1,
          },
        ],
        rowCount: 1,
      },
      // 2. existing row check (not yet posted)
      { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 },
      // 3. lock for update
      {
        rows: [
          {
            id: runId,
            status: 'posting',
            state_version: 3,
            qbo_invoice_id: null,
            approved_at: '2026-04-26T12:00:00.000Z',
            approved_by: 'demo-user',
            posted_at: null,
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 4. update to posted
      {
        rows: [
          {
            id: runId,
            status: 'posted',
            state_version: 4,
            qbo_invoice_id: 'INV-1',
            approved_at: '2026-04-26T12:00:00.000Z',
            approved_by: 'demo-user',
            posted_at: '2026-04-26T12:00:01.000Z',
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 5. insert workflow_event_log (POST_SUCCEEDED)
      { rows: [], rowCount: 1 },
      // 6. insert sync_event
      { rows: [], rowCount: 1 },
      // 7. update mutation_outbox applied
      { rows: [], rowCount: 1 },
    ]
  }

  it('happy path: pushes, applies POST_SUCCEEDED, marks outbox applied', async () => {
    const runId = '11111111-1111-1111-1111-111111111111'
    const client = new FakeQueueClient(happyPathResponses(runId))
    let pushed = 0
    const push: RentalBillingInvoicePushFn = async () => {
      pushed += 1
      return { qbo_invoice_id: 'INV-1' }
    }
    const result = await processRentalBillingInvoicePush(client, 'company-1', push, 5)
    expect(result).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })
    expect(pushed).toBe(1)
    const sql = sqlCalls(client)
    expect(sql[3]).toMatch(/update rental_billing_runs/)
    expect(sql[3]).toMatch(/'posted'/)
    expect(sql[4]).toMatch(/insert into workflow_event_log/i)
    expect(sql[6]).toMatch(/update mutation_outbox/)
    expect(sql[6]).toMatch(/applied/)
  })

  it('idempotent replay: existing qbo_invoice_id skips the push function', async () => {
    const runId = '22222222-2222-2222-2222-222222222222'
    const client = new FakeQueueClient([
      // 1. claim
      {
        rows: [
          {
            id: 'outbox-2',
            entity_id: runId,
            payload: {},
            attempt_count: 2,
          },
        ],
        rowCount: 1,
      },
      // 2. existing row check — already pushed
      { rows: [{ qbo_invoice_id: 'INV-PRE', status: 'posting' }], rowCount: 1 },
      // 3. lock for update (still posting)
      {
        rows: [
          {
            id: runId,
            status: 'posting',
            state_version: 3,
            qbo_invoice_id: 'INV-PRE',
            approved_at: null,
            approved_by: null,
            posted_at: null,
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 4. update to posted (same invoice id)
      {
        rows: [
          {
            id: runId,
            status: 'posted',
            state_version: 4,
            qbo_invoice_id: 'INV-PRE',
            approved_at: null,
            approved_by: null,
            posted_at: '2026-04-26T12:00:01.000Z',
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 5. insert workflow_event_log (POST_SUCCEEDED)
      { rows: [], rowCount: 1 },
      // 6. insert sync_event
      { rows: [], rowCount: 1 },
      // 7. update mutation_outbox applied
      { rows: [], rowCount: 1 },
    ])
    let pushed = 0
    const push: RentalBillingInvoicePushFn = async () => {
      pushed += 1
      return { qbo_invoice_id: 'SHOULD-NOT-BE-CALLED' }
    }
    const result = await processRentalBillingInvoicePush(client, 'company-1', push, 5)
    expect(pushed).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.posted).toBe(0)
  })

  it('push rejection lands as POST_FAILED with run state=failed and outbox=failed', async () => {
    const runId = '33333333-3333-3333-3333-333333333333'
    const client = new FakeQueueClient([
      // 1. claim
      {
        rows: [
          {
            id: 'outbox-3',
            entity_id: runId,
            payload: {},
            attempt_count: 1,
          },
        ],
        rowCount: 1,
      },
      // 2. existing row check — not posted
      { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 },
      // (push throws → catch path)
      // 3. lock for update inside applyWorkerEmittedEvent
      {
        rows: [
          {
            id: runId,
            status: 'posting',
            state_version: 3,
            qbo_invoice_id: null,
            approved_at: null,
            approved_by: null,
            posted_at: null,
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 4. update to failed
      {
        rows: [
          {
            id: runId,
            status: 'failed',
            state_version: 4,
            qbo_invoice_id: null,
            approved_at: null,
            approved_by: null,
            posted_at: null,
            failed_at: '2026-04-26T12:00:01.000Z',
            error: 'rate limited',
          },
        ],
        rowCount: 1,
      },
      // 5. insert workflow_event_log (POST_FAILED)
      { rows: [], rowCount: 1 },
      // 6. insert sync_event
      { rows: [], rowCount: 1 },
      // 7. update mutation_outbox failed
      { rows: [], rowCount: 1 },
    ])
    const push: RentalBillingInvoicePushFn = async () => {
      throw new Error('rate limited')
    }
    const result = await processRentalBillingInvoicePush(client, 'company-1', push, 5)
    expect(result.failed).toBe(1)
    expect(result.posted).toBe(0)
    const sql = sqlCalls(client)
    expect(sql[3]).toMatch(/'failed'/)
    expect(sql[4]).toMatch(/insert into workflow_event_log/i)
    expect(sql[6]).toMatch(/update mutation_outbox/)
    expect(sql[6]).toMatch(/'failed'/)
  })
})

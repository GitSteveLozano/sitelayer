import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  processOutboxBatch,
  processQueue,
  processQueueWithClient,
  type QueueClient,
  type ReleasableQueueClient,
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
})

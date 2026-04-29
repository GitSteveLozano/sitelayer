import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { processEstimatePush, type EstimatePushFn, type ReleasableQueueClient } from './index.js'

/**
 * Idempotency harness for the estimate-push worker handler.
 *
 * The handler MUST be safe to retry. The two interesting paths:
 *
 *   A. Crash AFTER QBO push but BEFORE marking outbox applied — the
 *      retry sees `qbo_estimate_id` already on the row, MUST NOT call
 *      QBO a second time, MUST emit POST_SUCCEEDED with the existing id.
 *
 *   B. Crash BEFORE QBO push completes — the retry calls QBO, succeeds,
 *      emits POST_SUCCEEDED, marks outbox applied. Exactly one external
 *      call, exactly one event_log row (uniqueness enforced at the DB
 *      via on conflict do nothing).
 *
 * These tests exercise path A. Path B is the happy path covered by
 * processEstimatePush() existing assertions.
 */

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

function sqlSummaries(client: FakeQueueClient): string[] {
  return client.calls.map((c) => c.text.replace(/\s+/g, ' ').trim())
}

describe('processEstimatePush — idempotent replay (path A)', () => {
  it('skips QBO push and emits POST_SUCCEEDED with existing id when qbo_estimate_id already set', async () => {
    let pushCalls = 0
    const push: EstimatePushFn = async () => {
      pushCalls += 1
      return { qbo_estimate_id: 'should-not-be-used' }
    }

    const responses: QueuedResponse[] = [
      // 1. claim outbox row (the update returning ...)
      {
        rows: [
          {
            id: 'outbox-1',
            entity_id: 'push-1',
            payload: { estimate_push_id: 'push-1' },
            attempt_count: 2,
          },
        ],
        rowCount: 1,
      },
      // 2. existence check on estimate_pushes — already has qbo_estimate_id, status='posting'
      {
        rows: [{ qbo_estimate_id: 'qbo-EST-existing', status: 'posting' }],
        rowCount: 1,
      },
      // 3. applyEstimatePushWorkerEvent → lock row
      {
        rows: [
          {
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
          },
        ],
        rowCount: 1,
      },
      // 4. update estimate_pushes → posted
      {
        rows: [
          {
            id: 'push-1',
            status: 'posted',
            state_version: 5,
            qbo_estimate_id: 'qbo-EST-existing',
            reviewed_at: null,
            reviewed_by: null,
            approved_at: null,
            approved_by: null,
            posted_at: '2026-04-29T13:00:00.000Z',
            failed_at: null,
            error: null,
          },
        ],
        rowCount: 1,
      },
      // 5. workflow_event_log insert (on conflict do nothing — no rows returned)
      { rows: [], rowCount: 1 },
      // 6. sync_events insert
      { rows: [], rowCount: 1 },
      // 7. mutation_outbox set status='applied'
      { rows: [], rowCount: 1 },
    ]

    const client = new FakeQueueClient(responses)
    const summary = await processEstimatePush(client, 'company-1', push, 5)

    expect(summary).toEqual({ processed: 1, posted: 0, failed: 0, skipped: 1 })
    expect(pushCalls).toBe(0) // no second QBO call

    const summaries = sqlSummaries(client)
    // Outbox claim
    expect(summaries[0]).toMatch(/update mutation_outbox.*set\s+status = 'processing'/i)
    // Existence check
    expect(summaries[1]).toMatch(/select qbo_estimate_id, status from estimate_pushes/i)
    // Lock for state update
    expect(summaries[2]).toMatch(/select id, status, state_version, qbo_estimate_id.*for update/i)
    // Posted update
    expect(summaries[3]).toMatch(/update estimate_pushes\s+set status = 'posted'/i)
    // Event log insert
    expect(summaries[4]).toMatch(/insert into workflow_event_log.*on conflict \(entity_id, state_version\) do nothing/i)
    // Sync event
    expect(summaries[5]).toMatch(/insert into sync_events/i)
    // Outbox applied
    expect(summaries[6]).toMatch(/update mutation_outbox set status = 'applied'/i)
  })

  it('marks outbox failed and never calls QBO when estimate_push row vanished', async () => {
    const push: EstimatePushFn = async () => {
      throw new Error('should not be called')
    }
    const responses: QueuedResponse[] = [
      {
        rows: [{ id: 'outbox-1', entity_id: 'push-missing', payload: {}, attempt_count: 1 }],
        rowCount: 1,
      },
      // existence check returns nothing
      { rows: [], rowCount: 0 },
      // outbox failed update
      { rows: [], rowCount: 1 },
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processEstimatePush(client, 'company-1', push, 5)
    expect(summary).toEqual({ processed: 1, posted: 0, failed: 1, skipped: 0 })
    const summaries = sqlSummaries(client)
    expect(summaries[2]).toMatch(/update mutation_outbox set status = 'failed'/i)
  })
})

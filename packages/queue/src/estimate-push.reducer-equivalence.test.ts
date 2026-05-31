import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  estimatePushRowToSnapshot,
  transitionEstimatePushWorkflow,
  type EstimatePushWorkflowSnapshot,
} from '@sitelayer/workflows'
import { processEstimatePush, type EstimatePushFn, type ReleasableQueueClient } from './index.js'

/**
 * Gap-1 proof: the estimate-push worker has NO independent transition
 * table. For a `posting`-state row, the values the worker writes to
 * `estimate_pushes` (status, state_version, posted_at/failed_at, error,
 * qbo_estimate_id, …) MUST equal the pure reducer's output for the
 * corresponding worker event. If the reducer's posting→posted /
 * posting→failed rule ever changes, this test breaks unless the worker
 * follows — which it now does, because it CALLS the reducer.
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

const TX = { rows: [] as never[], rowCount: null as number | null }

// A posting-state row exactly as the worker locks it (FOR UPDATE select).
const POSTING_ROW = {
  id: 'push-1',
  status: 'posting',
  state_version: 4,
  qbo_estimate_id: null,
  reviewed_at: '2026-04-29T09:00:00.000Z',
  reviewed_by: 'office-user',
  approved_at: '2026-04-29T10:00:00.000Z',
  approved_by: 'admin-user',
  posted_at: null,
  failed_at: null,
  error: null,
}

/** Pull the UPDATE-estimate_pushes call's bound values out of the trace. */
function findUpdateValues(client: FakeQueueClient): unknown[] {
  const call = client.calls.find((c) => /update estimate_pushes\s+set status = \$3/i.test(c.text.replace(/\s+/g, ' ')))
  expect(call, 'expected an UPDATE estimate_pushes ... set status=$3 call').toBeTruthy()
  return call!.values!
}

/**
 * The generic snapshot UPDATE binds, in order:
 *   $1 company, $2 id, $3 status, $4 state_version, $5 reviewed_at,
 *   $6 reviewed_by, $7 approved_at, $8 approved_by, $9 posted_at,
 *   $10 failed_at, $11 error, $12 qbo_estimate_id
 */
function updateToSnapshot(values: unknown[]): Partial<EstimatePushWorkflowSnapshot> {
  return {
    state: values[2] as EstimatePushWorkflowSnapshot['state'],
    state_version: values[3] as number,
    reviewed_at: values[4] as string | null,
    reviewed_by: values[5] as string | null,
    approved_at: values[6] as string | null,
    approved_by: values[7] as string | null,
    posted_at: values[8] as string | null,
    failed_at: values[9] as string | null,
    error: values[10] as string | null,
    qbo_estimate_id: values[11] as string | null,
  }
}

describe('processEstimatePush — worker write equals reducer output (Gap 1)', () => {
  it('success path: written columns == transitionEstimatePushWorkflow(POST_SUCCEEDED)', async () => {
    const push: EstimatePushFn = async () => ({ qbo_estimate_id: 'qbo-EST-777' })

    const responses: QueuedResponse[] = [
      TX, // begin (claim)
      { rows: [{ id: 'outbox-1', entity_id: 'push-1', payload: {}, attempt_count: 1 }], rowCount: 1 },
      TX, // commit (claim)
      TX, // begin (row work)
      { rows: [{ qbo_estimate_id: null, status: 'posting' }], rowCount: 1 }, // existence check
      { rows: [POSTING_ROW], rowCount: 1 }, // lock (FOR UPDATE)
      // update → posted (returning row reflecting reducer output)
      { rows: [{ ...POSTING_ROW, status: 'posted', state_version: 5, qbo_estimate_id: 'qbo-EST-777', posted_at: 'X' }], rowCount: 1 },
      { rows: [], rowCount: 1 }, // workflow_event_log insert
      { rows: [], rowCount: 1 }, // sync_events insert
      { rows: [], rowCount: 1 }, // mutation_outbox applied
      TX, // commit
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processEstimatePush(client, 'company-1', push, 5)
    expect(summary).toEqual({ processed: 1, posted: 1, failed: 0, skipped: 0 })

    const written = updateToSnapshot(findUpdateValues(client))
    // Recompute the reducer output with the SAME clock value the worker used.
    const expected = transitionEstimatePushWorkflow(estimatePushRowToSnapshot(POSTING_ROW), {
      type: 'POST_SUCCEEDED',
      posted_at: written.posted_at as string,
      qbo_estimate_id: 'qbo-EST-777',
    })
    expect(written).toEqual({
      state: expected.state,
      state_version: expected.state_version,
      reviewed_at: expected.reviewed_at ?? null,
      reviewed_by: expected.reviewed_by ?? null,
      approved_at: expected.approved_at ?? null,
      approved_by: expected.approved_by ?? null,
      posted_at: expected.posted_at ?? null,
      failed_at: expected.failed_at ?? null,
      error: expected.error ?? null,
      qbo_estimate_id: expected.qbo_estimate_id ?? null,
    })
    expect(written.state).toBe('posted')
    expect(written.state_version).toBe(5)
  })

  it('failure path: written columns == transitionEstimatePushWorkflow(POST_FAILED)', async () => {
    const push: EstimatePushFn = async () => {
      throw new Error('qbo exploded')
    }

    const responses: QueuedResponse[] = [
      TX, // begin (claim)
      { rows: [{ id: 'outbox-1', entity_id: 'push-1', payload: {}, attempt_count: 1 }], rowCount: 1 },
      TX, // commit (claim)
      TX, // begin (row work)
      { rows: [{ qbo_estimate_id: null, status: 'posting' }], rowCount: 1 }, // existence check
      // push() throws → rollback → recovery tx
      TX, // rollback (no row consumed; rollback issues query) -- actually rollback consumes a response
      TX, // begin (recovery)
      { rows: [POSTING_ROW], rowCount: 1 }, // lock (FOR UPDATE) in recovery
      // update → failed
      { rows: [{ ...POSTING_ROW, status: 'failed', state_version: 5, error: 'qbo exploded', failed_at: 'X' }], rowCount: 1 },
      { rows: [], rowCount: 1 }, // workflow_event_log
      { rows: [], rowCount: 1 }, // sync_events
      TX, // commit (recovery)
      { rows: [], rowCount: 1 }, // markOutboxRowFailedFresh
    ]
    const client = new FakeQueueClient(responses)
    const summary = await processEstimatePush(client, 'company-1', push, 5)
    expect(summary.failed).toBe(1)

    const written = updateToSnapshot(findUpdateValues(client))
    const expected = transitionEstimatePushWorkflow(estimatePushRowToSnapshot(POSTING_ROW), {
      type: 'POST_FAILED',
      failed_at: written.failed_at as string,
      error: 'qbo exploded',
    })
    expect(written.state).toBe('failed')
    expect(written.state).toBe(expected.state)
    expect(written.state_version).toBe(expected.state_version)
    expect(written.error).toBe(expected.error)
    expect(written.failed_at).toBe(expected.failed_at)
    expect(written.posted_at).toBe(expected.posted_at ?? null)
    expect(written.qbo_estimate_id).toBe(expected.qbo_estimate_id ?? null)
  })
})

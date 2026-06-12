import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  DEDICATED_HANDLER_MUTATION_TYPES,
  GENERIC_APPLY_MUTATION_TYPES,
  GENERIC_APPLY_MUTATION_TYPE_PREFIXES,
  isGenericApplyMutationType,
  processOutboxBatch,
  processQueue,
  processQueueWithClient,
  processRentalBillingInvoicePush,
  pruneAppliedQueue,
  quarantineUnroutableOutbox,
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
      // quarantine pass (no unroutable rows)
      { rows: [], rowCount: 0 },
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
    expect(result.quarantinedOutboxCount).toBe(0)
    expect(result.outbox[0]?.attempt_count).toBe(1)
    expect(result.syncEvents[0]?.direction).toBe('inbound')
    // Query 0 is the unroutable-row quarantine sweep; the generic claim is 1.
    expect(queries[0]).toContain("set status = 'failed'")
    expect(queries[1]).toContain('update mutation_outbox')
    expect(queries[1]).toContain('for update skip locked')
    // Exponential backoff + jitter (replaced the flat 5-min retry).
    expect(queries[1]).toMatch(/next_attempt_at = now\(\) \+ \(/)
    expect(queries[1]).toContain("least(interval '6 hours', interval '5 seconds' * power(2, least(attempt_count, 16)))")
    expect(queries[1]).toContain('0.5 + random() * 0.5')
    expect(queries[3]).toContain('update sync_events')
    expect(queries[3]).toContain('for update skip locked')
    expect(queries[5]).toContain('update integration_connections')
  })

  it('does not update integration state when no rows are ready', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // quarantine
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

  it('excludes the crew-schedule confirm side effects so the dedicated runner is not raced', () => {
    // crew-schedule-confirm.ts is the single materializer; if the generic
    // drain claimed these it would mark them applied without doing the work.
    // Every auto-confirmed new assignment enqueues materialize_labor_entries,
    // so this exclusion is on the hot path.
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('materialize_labor_entries')
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('notify_foreman_decline')
  })

  it('claims the four formerly-missing dedicated job kinds (2026-06-12 regression)', () => {
    // These four had dedicated runners but were MISSING from the exclusion
    // list, so a lane pause / backlog / mid-heartbeat enqueue let the generic
    // drain mark them applied with no work and a green audit trail.
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('takeoff_to_bid')
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('voice_to_log')
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('welcome_email')
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('damage_charge_invoice_push')
    // …and the previously handler-less estimate-share email now has a runner.
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('send_estimate_share')
  })

  it('keeps the generic allowlist and the dedicated registry disjoint', () => {
    for (const dedicated of DEDICATED_HANDLER_MUTATION_TYPES) {
      expect(isGenericApplyMutationType(dedicated)).toBe(false)
    }
    for (const generic of GENERIC_APPLY_MUTATION_TYPES) {
      expect([...DEDICATED_HANDLER_MUTATION_TYPES]).not.toContain(generic)
    }
    // No dedicated type may hide under a generic prefix either.
    for (const prefix of GENERIC_APPLY_MUTATION_TYPE_PREFIXES) {
      for (const dedicated of DEDICATED_HANDLER_MUTATION_TYPES) {
        expect(dedicated.startsWith(prefix)).toBe(false)
      }
    }
  })

  it('INVERTED CONTRACT: generic processOutboxBatch claims ONLY the explicit allowlist', async () => {
    const client = new FakeQueueClient([{ rows: [], rowCount: 0 }])
    await processOutboxBatch(client, 'company-1', 5)
    const sql = sqlCalls(client)[0]!
    // The claim is allowlist-shaped (= any), not exclusion-shaped (<> all):
    // with a paused lane, a >limit backlog, or a mid-heartbeat enqueue, a
    // dedicated or unknown mutation_type is structurally unclaimable here.
    expect(sql).toContain('mutation_type = any($3::text[])')
    expect(sql).toContain('mutation_type like any($4::text[])')
    expect(sql).not.toContain('<> all')
    expect(client.calls[0]!.values![2]).toEqual([...GENERIC_APPLY_MUTATION_TYPES])
    expect(client.calls[0]!.values![3]).toEqual(GENERIC_APPLY_MUTATION_TYPE_PREFIXES.map((p) => `${p}%`))
    // Paused-lane regression sentinels: none of the dedicated job kinds can
    // appear in the bound allowlist.
    const allowlist = client.calls[0]!.values![2] as string[]
    for (const dedicated of DEDICATED_HANDLER_MUTATION_TYPES) {
      expect(allowlist).not.toContain(dedicated)
    }
  })

  it('quarantineUnroutableOutbox parks unknown types as failed (never applied) and skips both registries', async () => {
    const client = new FakeQueueClient([
      {
        rows: [
          {
            id: '00000000-0000-0000-0000-00000000dead',
            entity_type: 'estimate_share_link',
            entity_id: 'share-1',
            mutation_type: 'send_estimate_share_v2',
          },
        ],
        rowCount: 1,
      },
    ])
    const rows = await quarantineUnroutableOutbox(client, 'company-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mutation_type).toBe('send_estimate_share_v2')
    const sql = sqlCalls(client)[0]!
    // Fails loudly: parked at 'failed' with an instructive error; applied_at
    // is never stamped, so ops cannot read this as success.
    expect(sql).toContain("set status = 'failed'")
    expect(sql).toContain('no handler registered for mutation_type')
    expect(sql).not.toContain('applied_at = now()')
    // Predicate excludes BOTH registries, so dedicated rows waiting out a
    // paused lane are left pending for their runner, not quarantined.
    expect(sql).toContain('not ( mutation_type = any($2::text[]) or mutation_type like any($3::text[]) )')
    expect(sql).toContain('mutation_type <> all($4::text[])')
    expect(client.calls[0]!.values![1]).toEqual([...GENERIC_APPLY_MUTATION_TYPES])
    expect(client.calls[0]!.values![3]).toEqual([...DEDICATED_HANDLER_MUTATION_TYPES])
  })

  it('processQueueWithClient surfaces quarantined rows in the result', async () => {
    const client = new FakeQueueClient([
      {
        rows: [
          {
            id: '00000000-0000-0000-0000-00000000dea1',
            entity_type: 'widget',
            entity_id: 'w-1',
            mutation_type: 'mystery_type',
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // outbox claim
      { rows: [], rowCount: 0 }, // sync claim
    ])
    const result = await processQueueWithClient(client, 'company-1', 5)
    expect(result.quarantinedOutboxCount).toBe(1)
    expect(result.quarantinedOutbox[0]?.mutation_type).toBe('mystery_type')
    expect(result.processedOutboxCount).toBe(0)
  })

  it('isGenericApplyMutationType matches exact entries and the event: prefix only', () => {
    expect(isGenericApplyMutationType('create')).toBe(true)
    expect(isGenericApplyMutationType('event:return')).toBe(true)
    expect(isGenericApplyMutationType('event:close')).toBe(true)
    expect(isGenericApplyMutationType('welcome_email')).toBe(false)
    expect(isGenericApplyMutationType('damage_charge_invoice_push')).toBe(false)
    expect(isGenericApplyMutationType('send_estimate_share')).toBe(false)
    expect(isGenericApplyMutationType('not_a_known_type')).toBe(false)
  })
})

describe('processRentalBillingInvoicePush', () => {
  // begin/commit/rollback all go through client.query() in our impl, so
  // the FakeQueueClient must have a response slot for each. Empty rows
  // are correct (pg's BEGIN/COMMIT/ROLLBACK return rowCount=null).
  const TX = { rows: [], rowCount: null as number | null }

  // Builds a FakeQueueClient response stack matching the SQL order of the
  // happy path under the per-row-tx structure:
  //   Phase 1 (claim tx):
  //     1. BEGIN
  //     2. claim mutation_outbox UPDATE (returns one row)
  //     3. COMMIT
  //   Phase 2 (per-row work tx):
  //     4. BEGIN
  //     5. select rental_billing_runs (qbo_invoice_id, status)
  //     6. lock rental_billing_runs for update
  //     7. update rental_billing_runs to 'posted'
  //     8. insert workflow_event_log
  //     9. insert sync_events
  //    10. update mutation_outbox to applied
  //    11. COMMIT
  function happyPathResponses(runId: string) {
    return [
      // Phase 1: claim
      TX, // begin
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
      TX, // commit
      // Phase 2: row work
      TX, // begin
      // existing row check (not yet posted)
      { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 },
      // lock for update
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
      // update to posted
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
      // insert workflow_event_log (POST_SUCCEEDED)
      { rows: [], rowCount: 1 },
      // insert sync_event
      { rows: [], rowCount: 1 },
      // update mutation_outbox applied
      { rows: [], rowCount: 1 },
      TX, // commit
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
    // Index map (see happyPathResponses): 0 begin, 1 claim, 2 commit,
    // 3 begin, 4 existing-check, 5 lock-for-update, 6 update-to-posted,
    // 7 event_log, 8 sync_event, 9 outbox-applied, 10 commit.
    expect(sql[1]).toMatch(/update mutation_outbox/i)
    expect(sql[1]).toMatch(/'processing'/)
    expect(sql[6]).toMatch(/update rental_billing_runs/)
    // The run-state UPDATE is now reducer-driven and fully parameterised
    // (status = $3, …) — the worker no longer hand-writes a `'posted'`
    // literal. The posted state lands in the bound values, computed by
    // transitionRentalBillingWorkflow, not in the SQL text.
    expect(sql[6]).toMatch(/set status = \$3/)
    expect(client.calls[6]?.values?.[2]).toBe('posted')
    expect(sql[7]).toMatch(/insert into workflow_event_log/i)
    expect(sql[9]).toMatch(/update mutation_outbox/)
    expect(sql[9]).toMatch(/applied/)
  })

  it('idempotent replay: existing qbo_invoice_id skips the push function', async () => {
    const runId = '22222222-2222-2222-2222-222222222222'
    const client = new FakeQueueClient([
      // Phase 1: claim
      TX, // begin
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
      TX, // commit
      // Phase 2: row work
      TX, // begin
      // existing row check — already pushed
      { rows: [{ qbo_invoice_id: 'INV-PRE', status: 'posting' }], rowCount: 1 },
      // lock for update (still posting)
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
      // update to posted (same invoice id)
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
      // insert workflow_event_log (POST_SUCCEEDED)
      { rows: [], rowCount: 1 },
      // insert sync_event
      { rows: [], rowCount: 1 },
      // update mutation_outbox applied
      { rows: [], rowCount: 1 },
      TX, // commit
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
      // Phase 1: claim
      TX, // begin
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
      TX, // commit
      // Phase 2: row work tx — push will throw inside it
      TX, // begin
      // existing row check — not posted
      { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 },
      // (push throws → catch block rolls back this tx and opens a fresh one)
      TX, // rollback
      // Recovery tx: applyWorkerEmittedEvent for failed kind + sync_event
      TX, // begin
      // lock for update inside applyWorkerEmittedEvent
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
      // update to failed
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
      // insert workflow_event_log (POST_FAILED)
      { rows: [], rowCount: 1 },
      // insert sync_event
      { rows: [], rowCount: 1 },
      TX, // commit recovery tx
      // markOutboxRowFailedFresh tx
      TX, // begin
      // update mutation_outbox failed
      { rows: [], rowCount: 1 },
      TX, // commit
    ])
    const push: RentalBillingInvoicePushFn = async () => {
      throw new Error('rate limited')
    }
    const result = await processRentalBillingInvoicePush(client, 'company-1', push, 5)
    expect(result.failed).toBe(1)
    expect(result.posted).toBe(0)
    const sql = sqlCalls(client)
    // Index map: 0 begin, 1 claim, 2 commit, 3 begin, 4 existing-check,
    // 5 rollback, 6 begin (recovery), 7 lock-for-update, 8 update-to-failed,
    // 9 event_log, 10 sync_event, 11 commit, 12 begin (markFailed),
    // 13 outbox-failed, 14 commit.
    expect(sql[5]).toMatch(/^rollback$/i)
    expect(sql[8]).toMatch(/update rental_billing_runs/)
    // Reducer-driven, parameterised UPDATE (status = $3, …); the `failed`
    // state is bound, not a SQL literal.
    expect(sql[8]).toMatch(/set status = \$3/)
    expect(client.calls[8]?.values?.[2]).toBe('failed')
    expect(sql[9]).toMatch(/insert into workflow_event_log/i)
    expect(sql[13]).toMatch(/update mutation_outbox/)
    expect(sql[13]).toMatch(/'failed'/)
  })

  it('row recovery path failure still marks the outbox row failed', async () => {
    // Regression: the original implementation wrapped the entire batch
    // in one transaction. If the catch block's recovery work itself
    // threw (e.g. row deleted concurrently, deadlock detected), the
    // whole tx rolled back and the outbox row stayed in 'processing',
    // re-claimed every 5 minutes forever.
    //
    // The fix is per-row transactions plus a fresh-tx markFailed so
    // the outbox row gets durably marked failed even when the recovery
    // path can't re-emit the workflow event. This test forces the
    // applyWorkerEmittedEvent path to throw on the lock SELECT and
    // asserts the outbox row STILL ends up failed.
    const runId = '44444444-4444-4444-4444-444444444444'
    const client = new FakeQueueClient([
      // Phase 1: claim
      TX, // begin
      {
        rows: [{ id: 'outbox-recovery', entity_id: runId, payload: {}, attempt_count: 1 }],
        rowCount: 1,
      },
      TX, // commit
      // Phase 2: row work — push throws
      TX, // begin
      // existing-row check
      { rows: [{ qbo_invoice_id: null, status: 'posting' }], rowCount: 1 },
      TX, // rollback
      // Recovery tx — applyWorkerEmittedEvent's lock SELECT explodes
      TX, // begin
      new Error('lock failed mid-recovery'),
      TX, // rollback (recovery tx)
      // markOutboxRowFailedFresh tx — must still run and succeed
      TX, // begin
      { rows: [], rowCount: 1 }, // outbox failed update
      TX, // commit
    ])
    const push: RentalBillingInvoicePushFn = async () => {
      throw new Error('rate limited')
    }
    const result = await processRentalBillingInvoicePush(client, 'company-1', push, 5)
    expect(result.failed).toBe(1)
    expect(result.posted).toBe(0)
    const sql = sqlCalls(client)
    // Recovery rolled back; markFailed update fired in its own tx.
    // 0 begin, 1 claim, 2 commit, 3 begin, 4 existing-check, 5 rollback,
    // 6 begin (recovery), 7 lock-for-update (throws), 8 rollback,
    // 9 begin (markFailed), 10 outbox-failed, 11 commit
    expect(sql[8]).toMatch(/^rollback$/i)
    expect(sql[10]).toMatch(/update mutation_outbox/i)
    expect(sql[10]).toMatch(/'failed'/)
  })
})

describe('pruneAppliedQueue', () => {
  // Sanity: a daily prune emits two parameterised DELETEs (one per
  // queue table), gated by applied_at IS NOT NULL plus a retention
  // threshold. The DELETE itself is idempotent — re-running within the
  // retention window deletes zero rows — so the gate lives in the
  // caller (the worker runner uses a process-local lastRunAt).
  it('issues parameterised deletes for both queues and returns per-table counts', async () => {
    const client = new FakeQueueClient([
      { rows: [{ count: 7 }], rowCount: 1 },
      { rows: [{ count: 3 }], rowCount: 1 },
    ])
    const result = await pruneAppliedQueue(client, { retentionDays: 30 })
    expect(result).toEqual({ mutation_outbox: 7, sync_events: 3 })
    const sql = sqlCalls(client)
    expect(sql[0]).toMatch(/delete from mutation_outbox/i)
    expect(sql[0]).toMatch(/applied_at is not null/i)
    expect(sql[0]).toMatch(/make_interval\(days => \$1\)/)
    expect(sql[1]).toMatch(/delete from sync_events/i)
    expect(sql[1]).toMatch(/applied_at is not null/i)
    // The retention day count is bound, not interpolated, so a
    // malformed env var can never inject SQL.
    expect(client.calls[0]?.values).toEqual([30])
    expect(client.calls[1]?.values).toEqual([30])
  })

  it('clamps retentionDays to >= 1 day', async () => {
    const client = new FakeQueueClient([
      { rows: [{ count: 0 }], rowCount: 1 },
      { rows: [{ count: 0 }], rowCount: 1 },
    ])
    await pruneAppliedQueue(client, { retentionDays: 0 })
    expect(client.calls[0]?.values).toEqual([1])
  })

  it('exposes delete_blueprint_storage_object as a dedicated handler so the generic drain skips it', () => {
    // The blueprint-storage GC runner claims this mutation_type in its
    // own dedicated drain (apps/worker/src/runners/blueprint-storage-
    // gc.ts). Without this entry, the generic processOutboxBatch would
    // mark the row applied without ever calling deleteObject.
    expect(DEDICATED_HANDLER_MUTATION_TYPES).toContain('delete_blueprint_storage_object')
  })
})

import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  LOCK_LABOR_ENTRIES_MAX_ATTEMPTS,
  processLockLaborEntries,
  type LockLaborEntriesPayload,
} from './lock-labor-entries.js'
import type { QueueClient } from './index.js'

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

function sqlCalls(client: FakeQueueClient) {
  return client.calls.map((c) => c.text.replace(/\s+/g, ' ').trim())
}

const COMPANY = 'c0000000-0000-0000-0000-000000000001'
const RUN_ID = 'r0000000-0000-0000-0000-000000000001'
const ENTRY_A = 'a0000000-0000-0000-0000-000000000001'
const ENTRY_B = 'a0000000-0000-0000-0000-000000000002'

function lockPayload(): LockLaborEntriesPayload {
  return {
    action: 'lock',
    run_id: RUN_ID,
    covered_entry_ids: [ENTRY_A, ENTRY_B],
    approved_at: '2026-05-01T17:30:00.000Z',
    state_version: 2,
  }
}
function unlockPayload(): LockLaborEntriesPayload {
  return {
    action: 'unlock',
    run_id: RUN_ID,
    covered_entry_ids: [ENTRY_A, ENTRY_B],
    approved_at: null,
    state_version: 3,
  }
}

describe('processLockLaborEntries', () => {
  it('empty claim → idle summary, just claim tx', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin
      { rows: [], rowCount: 0 }, // claim returns nothing
      { rows: [], rowCount: 0 }, // commit
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 0, locked: 0, unlocked: 0, failed: 0 })
    const queries = sqlCalls(client)
    expect(queries[0]).toBe('begin')
    expect(queries[1]).toMatch(/^update mutation_outbox/i)
    expect(queries[2]).toBe('commit')
  })

  it('single lock action: stamps labor_entries, marks outbox applied', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: 'outbox-1', entity_id: RUN_ID, payload: lockPayload(), attempt_count: 0 }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (apply tx)
      { rows: [], rowCount: 2 }, // update labor_entries
      { rows: [], rowCount: 1 }, // update mutation_outbox applied
      { rows: [], rowCount: 0 }, // commit (apply tx)
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 1, locked: 1, unlocked: 0, failed: 0 })

    const queries = sqlCalls(client)
    const labourUpdate = queries.find((q) => q.startsWith('update labor_entries set review_locked_at'))
    expect(labourUpdate).toBeDefined()
    expect(labourUpdate).toMatch(/review_locked_at = coalesce/i)
    expect(labourUpdate).toMatch(/where company_id = \$1/i)
    expect(labourUpdate).toMatch(/and review_locked_at is null/i)

    const appliedUpdate = queries.find((q) => q.startsWith("update mutation_outbox set status = 'applied'"))
    expect(appliedUpdate).toBeDefined()
  })

  it('single unlock action: filters by run_id so other runs are not disturbed', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: 'outbox-2', entity_id: RUN_ID, payload: unlockPayload(), attempt_count: 0 }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (apply tx)
      { rows: [], rowCount: 2 }, // update labor_entries
      { rows: [], rowCount: 1 }, // update mutation_outbox applied
      { rows: [], rowCount: 0 }, // commit (apply tx)
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 1, locked: 0, unlocked: 1, failed: 0 })

    const queries = sqlCalls(client)
    const unlockUpdate = queries.find((q) => q.startsWith('update labor_entries set review_locked_at = null'))
    expect(unlockUpdate).toBeDefined()
    // Critical: unlock filters by review_run_id = run_id so we don't release
    // entries that another run has since claimed.
    expect(unlockUpdate).toMatch(/and review_run_id = \$2/i)
  })

  it('mixed batch: lock then unlock, both succeed', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [
          { id: 'outbox-1', entity_id: RUN_ID, payload: lockPayload(), attempt_count: 0 },
          { id: 'outbox-2', entity_id: RUN_ID, payload: unlockPayload(), attempt_count: 0 },
        ],
        rowCount: 2,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      // row 1 (lock)
      { rows: [], rowCount: 0 }, // begin
      { rows: [], rowCount: 2 }, // update labor_entries
      { rows: [], rowCount: 1 }, // update mutation_outbox applied
      { rows: [], rowCount: 0 }, // commit
      // row 2 (unlock)
      { rows: [], rowCount: 0 }, // begin
      { rows: [], rowCount: 2 }, // update labor_entries
      { rows: [], rowCount: 1 }, // update mutation_outbox applied
      { rows: [], rowCount: 0 }, // commit
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 2, locked: 1, unlocked: 1, failed: 0 })
  })

  it('invalid payload below the attempt cap: rollback + reset to pending with error', async () => {
    const badPayload = {
      action: 'evict',
      run_id: RUN_ID,
      covered_entry_ids: [ENTRY_A],
      approved_at: null,
      state_version: 1,
    } as unknown as LockLaborEntriesPayload
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: 'outbox-bad', entity_id: RUN_ID, payload: badPayload, attempt_count: 0 }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (apply tx) — handler throws inside
      { rows: [], rowCount: 0 }, // rollback (catch block)
      { rows: [], rowCount: 1 }, // best-effort error update
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 1, locked: 0, unlocked: 0, failed: 1 })

    const queries = sqlCalls(client)
    expect(queries).toContain('rollback')
    // Below the cap → status stays 'pending' so the row gets another shot.
    // Match the error-path update specifically: "1 minute" backoff is unique
    // to it (the claim uses "5 minutes" + literal status='processing'; the
    // 'applied' update doesn't run on the failure path at all).
    const errorUpdate = client.calls.find(
      (c) => typeof c.text === 'string' && c.text.includes('set status = $') && c.text.includes("interval '1 minute'"),
    )
    expect(errorUpdate).toBeDefined()
    expect(errorUpdate?.values?.[3]).toBe('pending')
  })

  it('invalid payload AT the attempt cap: marks the row failed permanently', async () => {
    const badPayload = {
      action: 'evict',
      run_id: RUN_ID,
      covered_entry_ids: [ENTRY_A],
      approved_at: null,
      state_version: 1,
    } as unknown as LockLaborEntriesPayload
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [
          {
            id: 'outbox-cap',
            entity_id: RUN_ID,
            payload: badPayload,
            // attempt_count is what the row had BEFORE this claim incremented
            // it. At MAX the next failure should park the row.
            attempt_count: LOCK_LABOR_ENTRIES_MAX_ATTEMPTS,
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (apply tx)
      { rows: [], rowCount: 0 }, // rollback
      { rows: [], rowCount: 1 }, // error update — should now park as 'failed'
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 1, locked: 0, unlocked: 0, failed: 1 })

    // Match the error-path update specifically: "1 minute" backoff is unique
    // to it (the claim uses "5 minutes" + literal status='processing'; the
    // 'applied' update doesn't run on the failure path at all).
    const errorUpdate = client.calls.find(
      (c) => typeof c.text === 'string' && c.text.includes('set status = $') && c.text.includes("interval '1 minute'"),
    )
    expect(errorUpdate).toBeDefined()
    expect(errorUpdate?.values?.[3]).toBe('failed')
  })

  it('lock with empty covered_entry_ids: no labor_entries update issued, outbox still applied', async () => {
    const emptyPayload: LockLaborEntriesPayload = {
      action: 'lock',
      run_id: RUN_ID,
      covered_entry_ids: [],
      approved_at: '2026-05-01T17:30:00.000Z',
      state_version: 2,
    }
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: 'outbox-empty', entity_id: RUN_ID, payload: emptyPayload, attempt_count: 0 }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (apply tx)
      // No labor_entries update because the id list was empty.
      { rows: [], rowCount: 1 }, // update mutation_outbox applied
      { rows: [], rowCount: 0 }, // commit (apply tx)
    ])
    const summary = await processLockLaborEntries(client, COMPANY, 25)
    expect(summary).toEqual({ processed: 1, locked: 1, unlocked: 0, failed: 0 })

    const queries = sqlCalls(client)
    const labourUpdate = queries.find((q) => q.startsWith('update labor_entries set review_locked_at'))
    expect(labourUpdate).toBeUndefined()
  })

  it('claim SQL throws → rollback bubbles, no rows processed', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin
      new Error('connection reset by peer'),
      { rows: [], rowCount: 0 }, // rollback
    ])
    await expect(processLockLaborEntries(client, COMPANY, 25)).rejects.toThrow(/connection reset/)
    const queries = sqlCalls(client)
    expect(queries[0]).toBe('begin')
    expect(queries[queries.length - 1]).toBe('rollback')
  })
})

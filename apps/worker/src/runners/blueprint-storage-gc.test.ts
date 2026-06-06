import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createBlueprintStorageGcRunner, type ObjectGcStorage } from './blueprint-storage-gc.js'

// Unit tests for the blueprint storage GC runner. The runner delegates
// to `drainAgentMutations` (apps/worker/src/runner-utils.ts) which:
//   1. BEGINs, claims pending rows of the given mutation_type with FOR
//      UPDATE SKIP LOCKED, then commits the claim tx.
//   2. For each claimed row: BEGIN a per-row tx, run the processor
//      (which here calls storage.deleteObject), mark applied + commit
//      OR rollback + mark failed via a separate pool.query on throw.
//
// We focus on three observable behaviours of the runner:
//   - No rows claimed → returns zero summary, never touches storage.
//   - Happy path: payload's storage_path is unlinked, row marked
//     applied.
//   - Missing storage client (worker booted without DO_SPACES_* and
//     without BLUEPRINT_STORAGE_ROOT) → returns zero summary, never
//     touches DB or storage.

type FakeRow = QueryResultRow
type FakeResponse = Partial<QueryResult<FakeRow>> | Error
type QueryHandler = (sql: string, params?: ReadonlyArray<unknown>) => FakeResponse | undefined

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

interface FakeClient extends PoolClient {
  calls: FakeCall[]
  released: boolean
}

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makeFakePool(handler: QueryHandler): {
  pool: Pool
  poolCalls: FakeCall[]
  clients: FakeClient[]
} {
  const poolCalls: FakeCall[] = []
  const clients: FakeClient[] = []
  function makeClient(): FakeClient {
    const calls: FakeCall[] = []
    const c: Partial<FakeClient> = {
      calls,
      released: false,
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params: params ?? [] })
        const res = handler(sql, params ?? [])
        if (res instanceof Error) throw res
        return buildResponse(res ?? {})
      }) as unknown as PoolClient['query'],
    }
    const client = c as FakeClient
    client.release = vi.fn(() => {
      client.released = true
    }) as unknown as PoolClient['release']
    return client
  }
  const pool: Partial<Pool> = {
    query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
      poolCalls.push({ sql, params: params ?? [] })
      const res = handler(sql, params ?? [])
      if (res instanceof Error) throw res
      return buildResponse(res ?? {})
    }) as unknown as Pool['query'],
    connect: vi.fn(async () => {
      const c = makeClient()
      clients.push(c)
      return c
    }) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, poolCalls, clients }
}

describe('createBlueprintStorageGcRunner', () => {
  it('returns zero summary and never touches storage when no rows are claimed', async () => {
    const handler: QueryHandler = (sql) => {
      if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
      return { rows: [] }
    }
    const { pool } = makeFakePool(handler)
    const storage: ObjectGcStorage = { deleteObject: vi.fn(async () => {}) }
    const drain = createBlueprintStorageGcRunner({ pool, storage })
    const summary = await drain('co-1')
    expect(summary).toEqual({ processed: 0, insightsCreated: 0, failed: 0 })
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  it('happy path: deletes the storage object and marks the outbox row applied', async () => {
    const claimedRow = {
      id: 'outbox-1',
      payload: { storage_path: 'co-1/bp-1/plan.pdf' },
    }
    let claimCalls = 0
    const handler: QueryHandler = (sql) => {
      // The runner claims rows via UPDATE ... FOR UPDATE SKIP LOCKED.
      // First call returns the row, second call (the per-row applied
      // update) is fired separately on a follow-up tx and returns
      // rowCount=1 unconditionally.
      if (sql.includes('update mutation_outbox') && sql.includes('processing')) {
        claimCalls++
        if (claimCalls === 1) return { rows: [claimedRow], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('update mutation_outbox') && sql.includes('applied')) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [] }
    }
    const { pool } = makeFakePool(handler)
    const storage: ObjectGcStorage = { deleteObject: vi.fn(async () => {}) }
    const drain = createBlueprintStorageGcRunner({ pool, storage })
    const summary = await drain('co-1')
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(storage.deleteObject).toHaveBeenCalledWith('co-1/bp-1/plan.pdf')
  })

  it('no-op when storage client is null (worker booted without storage credentials)', async () => {
    const handler: QueryHandler = () => ({ rows: [] })
    const { pool } = makeFakePool(handler)
    const drain = createBlueprintStorageGcRunner({ pool, storage: null })
    const summary = await drain('co-1')
    expect(summary).toEqual({ processed: 0, insightsCreated: 0, failed: 0 })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createCaptureArtifactRetentionGcRunner } from './capture-artifact-retention-gc.js'
import type { ObjectGcStorage } from './blueprint-storage-gc.js'

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
  clients: FakeClient[]
} {
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
    connect: vi.fn(async () => {
      const c = makeClient()
      clients.push(c)
      return c
    }) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, clients }
}

describe('createCaptureArtifactRetentionGcRunner', () => {
  it('returns zero summary and never touches db when storage is missing', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }))
    const runner = createCaptureArtifactRetentionGcRunner({ pool, storage: null })
    await expect(runner.forceSweep('co-1')).resolves.toEqual({ ran: false, deleted: 0, failed: 0 })
  })

  it('deletes expired capture artifact objects and tombstones rows', async () => {
    const rows = [
      { id: 'artifact-1', storage_key: 'co-1/capture-sessions/session-1/audio.webm' },
      { id: 'artifact-2', storage_key: 'co-1/capture-sessions/session-1/replay.json' },
    ]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('update capture_artifacts')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool } = makeFakePool(handler)
    const storage: ObjectGcStorage = { deleteObject: vi.fn(async () => {}) }
    const runner = createCaptureArtifactRetentionGcRunner({ pool, storage })

    const summary = await runner.forceSweep('co-1')

    expect(summary).toEqual({ ran: true, deleted: 2, failed: 0 })
    expect(storage.deleteObject).toHaveBeenCalledWith('co-1/capture-sessions/session-1/audio.webm')
    expect(storage.deleteObject).toHaveBeenCalledWith('co-1/capture-sessions/session-1/replay.json')
  })

  it('does not tombstone rows when object deletion fails', async () => {
    const rows = [{ id: 'artifact-1', storage_key: 'co-1/capture-sessions/session-1/audio.webm' }]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: 1 }
      if (sql.includes('update capture_artifacts')) throw new Error('row should not be tombstoned')
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const storage: ObjectGcStorage = { deleteObject: vi.fn(async () => Promise.reject(new Error('delete failed'))) }
    const runner = createCaptureArtifactRetentionGcRunner({ pool, storage })

    const summary = await runner.forceSweep('co-1')

    expect(summary).toEqual({ ran: true, deleted: 0, failed: 1 })
    expect(clients[0]?.calls.some((call) => call.sql.includes('update capture_artifacts'))).toBe(false)
  })
})

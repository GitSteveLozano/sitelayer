import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createCompanyCamPollRunner } from './companycam-poll.js'

// Unit tests for the CompanyCam poll runner. The runner delegates to
// `drainCompanyCamPolls`, which:
//   1. Selects integration_mappings + integration_connections in one query.
//   2. For each pin: either bumps last_synced_at (stub mode / no token) OR
//      fetches photos from CompanyCam and inserts into companycam_photo_imports.
//
// We mock fetch globally per-test for the live-mode path, and stub the pg
// pool's query/connect surface. No real Postgres, no real network.

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

describe('createCompanyCamPollRunner', () => {
  const originalLive = process.env.LIVE_COMPANYCAM
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete process.env.LIVE_COMPANYCAM
  })

  afterEach(() => {
    if (originalLive === undefined) delete process.env.LIVE_COMPANYCAM
    else process.env.LIVE_COMPANYCAM = originalLive
    globalThis.fetch = originalFetch
  })

  describe('empty pass', () => {
    it('returns zero summary when no pins exist', async () => {
      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) return { rows: [], rowCount: 0 }
        return { rows: [] }
      }
      const { pool } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 0, imported: 0, skipped: 0, failed: 0 })
    })
  })

  describe('stub mode (LIVE_COMPANYCAM unset)', () => {
    it('bumps last_synced_at and counts as skipped for each pin', async () => {
      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) {
          return {
            rows: [
              { project_id: 'p-1', external_project_id: 'cc-100', access_token: 'tok-A' },
              { project_id: 'p-2', external_project_id: 'cc-200', access_token: null },
            ],
            rowCount: 2,
          }
        }
        if (sql.includes('update integration_connections')) {
          return { rows: [], rowCount: 1 }
        }
        return { rows: [] }
      }
      const { pool, poolCalls } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 2, imported: 0, skipped: 2, failed: 0 })
      // Both pins should have triggered an update to bump last_synced_at via pool.query
      const updates = poolCalls.filter((c) => c.sql.includes('update integration_connections'))
      expect(updates.length).toBe(2)
    })

    it('skips fetch entirely when LIVE_COMPANYCAM is unset even with a token', async () => {
      const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) {
          return {
            rows: [{ project_id: 'p-1', external_project_id: 'cc-100', access_token: 'tok-A' }],
            rowCount: 1,
          }
        }
        return { rows: [] }
      }
      const { pool } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      expect(summary.skipped).toBe(1)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('live mode happy path', () => {
    it('fetches photos and inserts new ones into companycam_photo_imports', async () => {
      process.env.LIVE_COMPANYCAM = '1'
      const photos = [
        { id: 'photo-1', uri: 'https://cdn.example/p1.jpg', captured_at: '2026-05-17T10:00:00Z' },
        { id: 'photo-2', uri: 'https://cdn.example/p2.jpg', captured_at: '2026-05-17T10:01:00Z' },
      ]
      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify(photos), { status: 200 }),
      ) as unknown as typeof fetch

      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) {
          return {
            rows: [{ project_id: 'p-1', external_project_id: 'cc-100', access_token: 'tok-A' }],
            rowCount: 1,
          }
        }
        // No existing imports → insert both photos
        if (sql.includes('from companycam_photo_imports')) return { rows: [], rowCount: 0 }
        return { rows: [] }
      }
      const { pool, clients } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      expect(summary).toEqual({ processed: 1, imported: 2, skipped: 0, failed: 0 })

      // One pooled client used inside pollProject; verify per-photo insert.
      const client = clients.find((c) => c.calls.some((q) => q.sql.includes('insert into companycam_photo_imports')))
      expect(client).toBeDefined()
      const inserts = client!.calls.filter((c) => c.sql.includes('insert into companycam_photo_imports'))
      expect(inserts).toHaveLength(2)
      expect(inserts[0]?.params[1]).toBe('photo-1')
      expect(inserts[1]?.params[1]).toBe('photo-2')

      // Tx wrapping: begin + commit on the client.
      const begins = client!.calls.filter((c) => c.sql === 'begin')
      const commits = client!.calls.filter((c) => c.sql === 'commit')
      expect(begins.length).toBe(1)
      expect(commits.length).toBe(1)
      expect(client!.released).toBe(true)
    })

    it('idempotency — existing dedupe row skips photo insert', async () => {
      process.env.LIVE_COMPANYCAM = '1'
      const photos = [{ id: 'photo-1', uri: 'https://cdn.example/p1.jpg' }]
      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify(photos), { status: 200 }),
      ) as unknown as typeof fetch

      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) {
          return {
            rows: [{ project_id: 'p-1', external_project_id: 'cc-100', access_token: 'tok-A' }],
            rowCount: 1,
          }
        }
        if (sql.includes('from companycam_photo_imports')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
        return { rows: [] }
      }
      const { pool, clients } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      // No new imports because dedupe row already existed.
      expect(summary.imported).toBe(0)
      const client = clients[0]!
      expect(client.calls.find((c) => c.sql.includes('insert into companycam_photo_imports'))).toBeUndefined()
    })
  })

  describe('live mode failure path', () => {
    it('counts a failure and records error in retry_state when fetch rejects', async () => {
      process.env.LIVE_COMPANYCAM = '1'
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

      const handler: QueryHandler = (sql) => {
        if (sql.includes('integration_mappings')) {
          return {
            rows: [{ project_id: 'p-1', external_project_id: 'cc-100', access_token: 'tok-A' }],
            rowCount: 1,
          }
        }
        if (sql.includes('retry_state')) return { rows: [], rowCount: 1 }
        return { rows: [] }
      }
      const { pool, poolCalls } = makeFakePool(handler)
      const drain = createCompanyCamPollRunner({ pool })
      const summary = await drain('co-1')
      expect(summary.failed).toBe(1)
      expect(summary.imported).toBe(0)
      // retry_state update should fire on the pool.
      const retryUpdates = poolCalls.filter((c) => c.sql.includes('retry_state'))
      expect(retryUpdates.length).toBeGreaterThan(0)
      // Error message captured in $2.
      expect(retryUpdates[0]?.params[1]).toMatch(/companycam GET cc-100 500/)
    })
  })
})

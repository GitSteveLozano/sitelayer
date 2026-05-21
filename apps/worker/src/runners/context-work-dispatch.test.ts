import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createContextWorkDispatchRunner } from './context-work-dispatch.js'

type FakeRow = QueryResultRow
type FakeCall = { sql: string; params: ReadonlyArray<unknown> }

function result(rows: FakeRow[] = [], rowCount = rows.length): QueryResult<FakeRow> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rows,
    rowCount,
  }
}

function makePool(claimedRows: FakeRow[]): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  let claimed = false
  const client = {
    query: async (...args: unknown[]) => {
      const sql = String(args[0])
      const params = Array.isArray(args[1]) ? (args[1] as ReadonlyArray<unknown>) : []
      calls.push({ sql, params: params ?? [] })
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        normalized === 'begin' ||
        normalized === 'commit' ||
        normalized === 'rollback' ||
        normalized.startsWith('select set_config')
      ) {
        return result()
      }
      if (normalized.startsWith('update mutation_outbox') && normalized.includes("set status = 'processing'")) {
        if (claimed) return result()
        claimed = true
        return result(claimedRows)
      }
      if (normalized.includes('insert into context_handoff_events')) return result()
      if (normalized.startsWith('update context_work_items')) return result([], 1)
      if (normalized.startsWith("update mutation_outbox set status = 'applied'")) return result([], 1)
      throw new Error(`unexpected sql: ${normalized}`)
    },
    release: () => {
      released.push(true)
    },
  } as unknown as PoolClient
  return {
    pool: {
      connect: async () => client,
      query: async () => result(),
    } as unknown as Pool,
    calls,
    released,
  }
}

describe('createContextWorkDispatchRunner', () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.MESH_WORK_REQUEST_DISPATCH_URL
  const originalToken = process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    else process.env.MESH_WORK_REQUEST_DISPATCH_URL = originalUrl
    if (originalToken === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
    else process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = originalToken
  })

  it('posts claimed dispatch rows to Mesh, appends an ack, and marks outbox applied', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = 'mesh-secret'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 123 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool, calls, released } = makePool([
      {
        id: 'outbox-1',
        payload: {
          work_item_id: '00000000-0000-4000-8000-000000000001',
          support_packet_id: '00000000-0000-4000-8000-000000000002',
          title: 'Investigate estimate push',
          route: '/projects/p/estimate-push/x',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
          },
        },
      },
    ])
    const runner = createContextWorkDispatchRunner({ pool })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, insightsCreated: 0, failed: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as unknown as [string, RequestInit]
    expect(url).toBe('https://mesh.example.test/api/orchestrate/tasks')
    expect(init.headers).toMatchObject({ authorization: 'Bearer mesh-secret' })
    expect(JSON.parse(String(init.body))).toMatchObject({
      company_id: 'company-1',
      work_item_id: '00000000-0000-4000-8000-000000000001',
      support_packet_id: '00000000-0000-4000-8000-000000000002',
      execution_context: {
        context_handoff: {
          version: 'context-handoff-v1',
          work_item_id: '00000000-0000-4000-8000-000000000001',
          support_packet_id: '00000000-0000-4000-8000-000000000002',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
          },
        },
      },
    })
    expect(calls.some((call) => call.sql.includes('insert into context_handoff_events'))).toBe(true)
    const ackCall = calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    expect(JSON.parse(String(ackCall?.params[2]))).toMatchObject({
      status: 202,
      mesh_task_id: '123',
    })
    expect(
      calls.some((call) => call.sql.startsWith("update mutation_outbox\n             set status = 'applied'")),
    ).toBe(true)
    expect(released).toEqual([true])
  })

  it('does not claim rows when Mesh dispatch is not configured', async () => {
    delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool, calls, released } = makePool([
      {
        id: 'outbox-1',
        payload: {
          work_item_id: '00000000-0000-4000-8000-000000000001',
        },
      },
    ])
    const runner = createContextWorkDispatchRunner({ pool })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 0, insightsCreated: 0, failed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(released).toEqual([])
  })
})

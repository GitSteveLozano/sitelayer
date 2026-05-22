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
            url: 'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
            expires_at: '2026-05-22T12:00:00.000Z',
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
      subject: '[Sitelayer] Investigate estimate push',
      created_by: 'sitelayer-worker',
      source: 'sitelayer-context-handoff',
      task_type: 'audit',
      auto_dispatch: true,
      tags: 'sitelayer,context-handoff,work-request,triage:ready-for-agent,audit',
      project_hint: 'sitelayer',
      idempotency_key: 'sitelayer:context_work_item:00000000-0000-4000-8000-000000000001',
      reversibility_window_seconds: 86400,
      properties: {
        project_hint: 'sitelayer',
        source_system: 'sitelayer',
        source_kind: 'context_work_item',
        company_id: 'company-1',
        work_item_id: '00000000-0000-4000-8000-000000000001',
        support_packet_id: '00000000-0000-4000-8000-000000000002',
        route: '/projects/p/estimate-push/x',
        callback_path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_url:
          'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        readonly: true,
      },
      execution_context: {
        project_hint: 'sitelayer',
        source_system: 'sitelayer',
        work_item_id: '00000000-0000-4000-8000-000000000001',
        support_packet_id: '00000000-0000-4000-8000-000000000002',
        route: '/projects/p/estimate-push/x',
        callback_path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_url:
          'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        dispatch_mode: 'steerer',
        claim_mode: 'steerer',
        context_handoff: {
          version: 'context-handoff-v1',
          source_system: 'sitelayer',
          company_id: 'company-1',
          work_item_id: '00000000-0000-4000-8000-000000000001',
          support_packet_id: '00000000-0000-4000-8000-000000000002',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
            url: 'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
            expires_at: '2026-05-22T12:00:00.000Z',
          },
        },
      },
    })
    expect(JSON.parse(String(init.body)).description).toContain(
      'Treat this as read-only triage unless a separate implementation task',
    )
    // Default (non-agent) lane must NOT carry the sitelayer_implementation routing keys:
    // those are reserved for lane=agent so triage work continues to land in operator_assistant.
    const triageBody = JSON.parse(String(init.body)) as {
      properties: Record<string, unknown>
      execution_context: Record<string, unknown>
    }
    expect(triageBody.properties.steerer_workflow_id).toBeUndefined()
    expect(triageBody.properties.counsel_class).toBeUndefined()
    expect(triageBody.execution_context.steerer_workflow_id).toBeUndefined()
    expect(triageBody.execution_context.counsel_class).toBeUndefined()
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

  it('routes lane=agent dispatches to the sitelayer_implementation steerer + counsel class', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = 'mesh-secret'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 456 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool } = makePool([
      {
        id: 'outbox-2',
        payload: {
          work_item_id: '00000000-0000-4000-8000-0000000000aa',
          support_packet_id: '00000000-0000-4000-8000-0000000000bb',
          title: 'Wire chat widget retry button',
          summary: 'Add a retry button to the chat widget when the AI chat backend returns 5xx.',
          route: '/projects/p/chat-widget/retry',
          entity_type: 'chat_widget',
          entity_id: 'cw-1',
          lane: 'agent',
          status: 'new',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-0000000000aa/agent-callback',
            url: 'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-0000000000aa/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
            expires_at: '2026-05-22T12:00:00.000Z',
          },
        },
      },
    ])
    const runner = createContextWorkDispatchRunner({ pool })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, insightsCreated: 0, failed: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      task_type: string
      tags: string
      properties: Record<string, unknown>
      execution_context: Record<string, unknown>
      description: string
    }

    // Routing keys land where mesh's steerer/registry layer reads them
    // (properties_json + execution_context):
    expect(body.task_type).toBe('implementation')
    expect(body.tags).toContain('sitelayer:lane:agent')
    expect(body.tags).toContain('implementation')
    expect(body.properties).toMatchObject({
      steerer_workflow_id: 'sitelayer_implementation_fan',
      counsel_class: 'sitelayer_implementation',
      lane: 'agent',
      readonly: false,
      feature_brief: 'Add a retry button to the chat widget when the AI chat backend returns 5xx.',
      context_handoff_ref: '00000000-0000-4000-8000-0000000000aa',
    })
    expect(body.execution_context).toMatchObject({
      steerer_workflow_id: 'sitelayer_implementation_fan',
      counsel_class: 'sitelayer_implementation',
      feature_brief: 'Add a retry button to the chat widget when the AI chat backend returns 5xx.',
      context_handoff_ref: '00000000-0000-4000-8000-0000000000aa',
    })
    expect(Array.isArray(body.properties.affected_packages)).toBe(true)
    expect(body.properties.affected_packages).toEqual(
      expect.arrayContaining(['apps/api', 'apps/web']),
    )
    expect(body.description).toContain('steerer_workflow_id=sitelayer_implementation_fan')
    expect(body.description).toContain('sitelayer_implementation')
    expect(body.description).not.toContain('Treat this as read-only triage')
  })

  it('falls back to ["*"] for affected_packages when route/entity gives no signal', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 789 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool } = makePool([
      {
        id: 'outbox-3',
        payload: {
          work_item_id: '00000000-0000-4000-8000-0000000000cc',
          support_packet_id: '00000000-0000-4000-8000-0000000000dd',
          title: 'Investigate undefined feature',
          lane: 'agent',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-0000000000cc/agent-callback',
            url: 'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-0000000000cc/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
            expires_at: '2026-05-22T12:00:00.000Z',
          },
        },
      },
    ])
    const runner = createContextWorkDispatchRunner({ pool })

    await runner('company-1')

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> }
    expect(body.properties.affected_packages).toEqual(['*'])
    // feature_brief falls back to title when summary is absent
    expect(body.properties.feature_brief).toBe('Investigate undefined feature')
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

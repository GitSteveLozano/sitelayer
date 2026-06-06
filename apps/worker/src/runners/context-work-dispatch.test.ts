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

function makePool(
  claimedRows: FakeRow[],
  opts: { workItemStatus?: string } = {},
): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  let claimed = false
  const workItemStatus = opts.workItemStatus ?? 'new'
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
      if (normalized.startsWith('select status') && normalized.includes('from context_work_items')) {
        return result([{ status: workItemStatus }])
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
  const originalAutoDispatch = process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    else process.env.MESH_WORK_REQUEST_DISPATCH_URL = originalUrl
    if (originalToken === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
    else process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = originalToken
    if (originalAutoDispatch === undefined) delete process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH
    else process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH = originalAutoDispatch
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
          payload_version: 'sitelayer.context_work_dispatch.v1',
          work_item_id: '00000000-0000-4000-8000-000000000001',
          support_packet_id: '00000000-0000-4000-8000-000000000002',
          capture_session_id: '00000000-0000-4000-8000-000000000003',
          title: 'Investigate estimate push',
          route: '/projects/p/estimate-push/x',
          work_request_brief: {
            schema: 'sitelayer.work_request_brief.v1',
            diagnostics: {
              support_packet_id: '00000000-0000-4000-8000-000000000002',
            },
          },
          agent_brief_markdown: 'Safe handoff brief for the receiving agent.',
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
      payload_version: 'sitelayer.context_work_dispatch.v1',
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
        capture_session_id: '00000000-0000-4000-8000-000000000003',
        route: '/projects/p/estimate-push/x',
        callback_path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_url:
          'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_token_type: 'scoped_bearer',
        work_request_brief_schema: 'sitelayer.work_request_brief.v1',
        context_handoff_payload_version: 'sitelayer.context_work_dispatch.v1',
        readonly: true,
      },
      execution_context: {
        payload_version: 'sitelayer.context_work_dispatch.v1',
        project_hint: 'sitelayer',
        source_system: 'sitelayer',
        work_item_id: '00000000-0000-4000-8000-000000000001',
        support_packet_id: '00000000-0000-4000-8000-000000000002',
        capture_session_id: '00000000-0000-4000-8000-000000000003',
        route: '/projects/p/estimate-push/x',
        callback_path: '/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_url:
          'https://sitelayer.example.test/api/work-requests/00000000-0000-4000-8000-000000000001/agent-callback',
        callback_token_type: 'scoped_bearer',
        dispatch_mode: 'steerer',
        claim_mode: 'steerer',
        work_request_brief: {
          schema: 'sitelayer.work_request_brief.v1',
        },
        agent_brief_markdown: 'Safe handoff brief for the receiving agent.',
        context_handoff: {
          payload_version: 'sitelayer.context_work_dispatch.v1',
          version: 'context-handoff-v1',
          source_system: 'sitelayer',
          company_id: 'company-1',
          work_item_id: '00000000-0000-4000-8000-000000000001',
          support_packet_id: '00000000-0000-4000-8000-000000000002',
          capture_session_id: '00000000-0000-4000-8000-000000000003',
          work_request_brief: {
            schema: 'sitelayer.work_request_brief.v1',
          },
          agent_brief_markdown: 'Safe handoff brief for the receiving agent.',
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
    expect(JSON.parse(String(init.body)).description).toContain('Capture session: 00000000-0000-4000-8000-000000000003')
    expect(JSON.parse(String(init.body)).description).toContain('Safe handoff brief for the receiving agent.')
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
    expect(ackCall?.params[5]).toBe('00000000-0000-4000-8000-000000000003')
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
    expect(body.properties.affected_packages).toEqual(expect.arrayContaining(['apps/api', 'apps/web']))
    expect(body.description).toContain('steerer_workflow_id=sitelayer_implementation_fan')
    expect(body.description).toContain('sitelayer_implementation')
    expect(body.description).not.toContain('Treat this as read-only triage')
  })

  it('routes lane=both dispatches as implementation-capable work', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 654 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool, calls } = makePool([
      {
        id: 'outbox-both',
        payload: {
          work_item_id: '00000000-0000-4000-8000-0000000000ab',
          support_packet_id: '00000000-0000-4000-8000-0000000000bc',
          capture_session_id: '00000000-0000-4000-8000-0000000000cd',
          title: 'Recorded pilot feedback needs implementation',
          summary: 'The internal pilot recording produced a ready capture analysis item.',
          route: '/desktop/takeoff',
          lane: 'both',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-0000000000ab/agent-callback',
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
    const body = JSON.parse(String(init.body)) as {
      task_type: string
      tags: string
      properties: Record<string, unknown>
      execution_context: Record<string, unknown>
      description: string
    }
    expect(body.task_type).toBe('implementation')
    expect(body.tags).toContain('sitelayer:lane:both')
    expect(body.properties).toMatchObject({
      steerer_workflow_id: 'sitelayer_implementation_fan',
      counsel_class: 'sitelayer_implementation',
      lane: 'both',
      readonly: false,
      capture_session_id: '00000000-0000-4000-8000-0000000000cd',
    })
    expect(body.execution_context).toMatchObject({
      steerer_workflow_id: 'sitelayer_implementation_fan',
      counsel_class: 'sitelayer_implementation',
      capture_session_id: '00000000-0000-4000-8000-0000000000cd',
    })
    expect(body.description).toContain('Lane: both (implementation)')
    expect(body.description).not.toContain('Treat this as read-only triage')
    const updateCall = calls.find((call) => call.sql.startsWith('update context_work_items'))
    expect(updateCall?.params[2]).toBe('both')
  })

  it('can create Mesh tasks without auto-dispatching them when the smoke safety env is disabled', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH = '0'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 987 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool } = makePool([
      {
        id: 'outbox-safe-smoke',
        payload: {
          work_item_id: '00000000-0000-4000-8000-0000000000ef',
          support_packet_id: '00000000-0000-4000-8000-0000000000f0',
          capture_session_id: '00000000-0000-4000-8000-0000000000f1',
          title: 'Safe real Mesh smoke',
          summary: 'Create the Control Plane task row without dispatching an agent.',
          route: '/desktop/takeoff',
          lane: 'both',
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-0000000000ef/agent-callback',
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
    const body = JSON.parse(String(init.body)) as { auto_dispatch: boolean; properties: Record<string, unknown> }
    expect(body.auto_dispatch).toBe(false)
    expect(body.properties.capture_session_id).toBe('00000000-0000-4000-8000-0000000000f1')
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

  it('forwards the additive projectkit dispatch_request snapshot into the mesh body', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ task_id: 321 }), { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const dispatchRequest = {
      schema_version: '1.3.0',
      project_key: 'sitelayer',
      requested_at: '2026-06-06T12:00:00.000Z',
      request_ref: '00000000-0000-4000-8000-0000000000a1',
      intent: 'fix',
      title: 'Carry the projectkit snapshot',
      priority: 'normal',
      payload: {
        lane: 'agent',
        concern: {
          schema_version: '1.3.0',
          project_key: 'sitelayer',
          dispatched_at: '2026-06-06T12:00:00.000Z',
          concern_ref: '00000000-0000-4000-8000-0000000000a1',
          kind: 'execute',
          title: 'Carry the projectkit snapshot',
        },
      },
    }
    const { pool } = makePool([
      {
        id: 'outbox-dispatch-request',
        payload: {
          work_item_id: '00000000-0000-4000-8000-0000000000a1',
          support_packet_id: '00000000-0000-4000-8000-0000000000a2',
          title: 'Carry the projectkit snapshot',
          lane: 'agent',
          dispatch_request: dispatchRequest,
          callback: {
            path: '/api/work-requests/00000000-0000-4000-8000-0000000000a1/agent-callback',
            token: 'scoped-callback',
            token_type: 'scoped_bearer',
            expires_at: '2026-06-09T12:00:00.000Z',
          },
        },
      },
    ])
    const runner = createContextWorkDispatchRunner({ pool })

    await runner('company-1')

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      execution_context: { dispatch_request?: unknown; context_handoff: { dispatch_request?: unknown } }
    }
    expect(body.execution_context.dispatch_request).toEqual(dispatchRequest)
    expect(body.execution_context.context_handoff.dispatch_request).toEqual(dispatchRequest)
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

  it('skips terminal work items without dispatching to Mesh', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
    process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = 'mesh-secret'
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { pool, calls } = makePool(
      [
        {
          id: 'outbox-1',
          payload: {
            work_item_id: '00000000-0000-4000-8000-000000000001',
            capture_session_id: '00000000-0000-4000-8000-000000000003',
            title: 'Already reversed',
          },
        },
      ],
      { workItemStatus: 'reversed' },
    )
    const runner = createContextWorkDispatchRunner({ pool })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, insightsCreated: 0, failed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    const cancelEventCall = calls.find((call) => call.sql.includes("'agent.dispatch_cancel_requested'"))
    expect(cancelEventCall).toBeDefined()
    expect(JSON.parse(String(cancelEventCall?.params[2]))).toMatchObject({
      skipped: true,
      reason: 'terminal_work_item',
      status: 'reversed',
    })
    expect(cancelEventCall?.params[5]).toBe('00000000-0000-4000-8000-000000000003')
    expect(calls.some((call) => call.sql.startsWith('update context_work_items'))).toBe(false)
    expect(
      calls.some((call) => call.sql.startsWith("update mutation_outbox\n             set status = 'applied'")),
    ).toBe(true)
  })
})

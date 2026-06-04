import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createWorkDispatchReconcilerRunner } from './work-dispatch-reconciler.js'

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

function makePool(candidates: FakeRow[]): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  const client = {
    query: async (...args: unknown[]) => {
      const sql = String(args[0])
      const params = Array.isArray(args[1]) ? (args[1] as ReadonlyArray<unknown>) : []
      calls.push({ sql, params })
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        normalized === 'begin' ||
        normalized === 'commit' ||
        normalized === 'rollback' ||
        normalized.startsWith('select set_config')
      ) {
        return result()
      }
      if (normalized.startsWith('select w.id, w.status, w.lane')) return result(candidates)
      if (normalized.includes('insert into context_handoff_events')) return result()
      if (normalized.startsWith('update context_work_items')) return result([], 1)
      throw new Error(`unexpected sql: ${normalized}`)
    },
    release: () => {
      released.push(true)
    },
  } as unknown as PoolClient
  return {
    pool: {
      connect: async () => client,
    } as unknown as Pool,
    calls,
    released,
  }
}

function extractObservationBody(rawBody: string): {
  event_type: string | undefined
  status: string | undefined
  severity: string | undefined
  metadata: Record<string, unknown> | undefined
} {
  const parsed = JSON.parse(rawBody) as Record<string, unknown>
  const events = parsed.events
  if (Array.isArray(events)) {
    const event = events[0] as Record<string, unknown> | undefined
    const payload = event?.payload as Record<string, unknown> | undefined
    return {
      event_type: event?.event_type as string | undefined,
      status: (payload?.status ?? event?.outcome) as string | undefined,
      severity: payload?.severity as string | undefined,
      metadata: payload?.metadata as Record<string, unknown> | undefined,
    }
  }
  return {
    event_type: parsed.event_type as string | undefined,
    status: parsed.status as string | undefined,
    severity: parsed.severity as string | undefined,
    metadata: parsed.metadata as Record<string, unknown> | undefined,
  }
}

describe('createWorkDispatchReconcilerRunner', () => {
  it('records missing callback events and expires acknowledged dispatches', async () => {
    const { pool, calls, released } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000101',
        status: 'agent_running',
        lane: 'agent',
        severity: 'urgent',
        route: '/admin/issues',
        entity_type: 'context_work_item',
        dispatch_acknowledged_at: '2026-06-04 12:00:00+00',
        mesh_task_id: 'mesh-task-101',
        capture_session_id: '11111111-1111-4111-8111-111111111111',
      },
    ])
    const runner = createWorkDispatchReconcilerRunner({ pool })

    const summary = await runner.maybeReconcile('company-1')

    expect(summary).toEqual({ ran: true, reconciled: 1, failed: 0 })
    const select = calls.find((call) => call.sql.includes('from context_work_items w'))
    expect(select?.params[0]).toBe('company-1')
    expect(select?.params[1]).toBe(24)
    expect(select?.params[2]).toEqual([
      'agent.message_received',
      'agent.artifact_attached',
      'agent.proposal_ready',
      'agent.completed',
      'human.review_requested',
    ])
    const insert = calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    expect(insert?.sql).toContain("'agent.callback_missing'")
    expect(insert?.params[4]).toBe('context_work_item:lost_callback:00000000-0000-4000-8000-000000000101:mesh-task-101')
    expect(insert?.params[5]).toBe('11111111-1111-4111-8111-111111111111')
    expect(JSON.parse(String(insert?.params[2]))).toMatchObject({
      previous_status: 'agent_running',
      previous_lane: 'agent',
      status: 'proposal_expired',
      lane: 'both',
      mesh_task_id: 'mesh-task-101',
      callback_missing_hours: 24,
    })
    const update = calls.find((call) => call.sql.startsWith('update context_work_items'))
    expect(update?.params).toEqual([
      'company-1',
      '00000000-0000-4000-8000-000000000101',
      'proposal_expired',
      'both',
      'agent_running',
    ])
    expect(released).toEqual([true])
  })

  it('throttles repeated reconciles inside the configured interval', async () => {
    const { pool, calls } = makePool([])
    const runner = createWorkDispatchReconcilerRunner({ pool })

    expect(await runner.maybeReconcile('company-1')).toEqual({ ran: true, reconciled: 0, failed: 0 })
    expect(await runner.maybeReconcile('company-1')).toEqual({ ran: false, reconciled: 0, failed: 0 })
    expect(calls.filter((call) => call.sql.toLowerCase() === 'begin')).toHaveLength(1)
  })

  it('posts best-effort obstruction observations for reconciled callbacks', async () => {
    const { pool } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000102',
        status: 'agent_running',
        lane: 'both',
        severity: null,
        route: null,
        entity_type: null,
        dispatch_acknowledged_at: '2026-06-04 12:00:00+00',
        mesh_task_id: null,
        capture_session_id: null,
      },
    ])
    const originalUrl = process.env.MESH_OBSERVATION_INGRESS_URL
    const originalComponent = process.env.MESH_OBSERVATION_COMPONENT
    const originalSecret = process.env.MESH_OBSERVATION_SECRET_HEX
    process.env.MESH_OBSERVATION_INGRESS_URL = 'http://mesh.example.test/api/observations/ingest'
    process.env.MESH_OBSERVATION_COMPONENT = 'sitelayer-worker'
    process.env.MESH_OBSERVATION_SECRET_HEX = '00112233445566778899aabbccddeeff'
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}', { status: 202 }),
    )

    try {
      const runner = createWorkDispatchReconcilerRunner({
        pool,
        meshObservationDeps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      })
      expect(await runner.maybeReconcile('company-2')).toEqual({ ran: true, reconciled: 1, failed: 0 })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
      const body = extractObservationBody(String(init?.body))
      expect(body.event_type).toBe('work_item_obstructed')
      expect(body.status).toBe('proposal_expired')
      expect(body.severity).toBe('normal')
      expect(body.metadata).toMatchObject({
        company_id: 'company-2',
        reconciler: 'lost_callback',
        mesh_task_id: null,
      })
    } finally {
      if (originalUrl === undefined) delete process.env.MESH_OBSERVATION_INGRESS_URL
      else process.env.MESH_OBSERVATION_INGRESS_URL = originalUrl
      if (originalComponent === undefined) delete process.env.MESH_OBSERVATION_COMPONENT
      else process.env.MESH_OBSERVATION_COMPONENT = originalComponent
      if (originalSecret === undefined) delete process.env.MESH_OBSERVATION_SECRET_HEX
      else process.env.MESH_OBSERVATION_SECRET_HEX = originalSecret
    }
  })
})

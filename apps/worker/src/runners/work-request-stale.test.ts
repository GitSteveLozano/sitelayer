import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createWorkRequestStaleRunner } from './work-request-stale.js'

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

function makePool(staleRows: FakeRow[]): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
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
      if (normalized.startsWith('select id, status, lane, severity, route, entity_type from context_work_items'))
        return result(staleRows)
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

describe('createWorkRequestStaleRunner', () => {
  it('marks stale review and agent rows with append-only status events', async () => {
    const { pool, calls, released } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000001',
        status: 'review_ready',
        lane: 'both',
        severity: 'high',
        route: '/projects/p-1',
        entity_type: 'estimate_push',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        status: 'agent_running',
        lane: 'agent',
        severity: 'normal',
        route: null,
        entity_type: null,
      },
    ])
    const runner = createWorkRequestStaleRunner({ pool })

    const summary = await runner.maybeSweep('company-1')

    expect(summary).toEqual({ ran: true, updated: 2, failed: 0 })
    const inserts = calls.filter((call) => call.sql.includes('insert into context_handoff_events'))
    expect(inserts).toHaveLength(2)
    expect(JSON.parse(String(inserts[0]!.params[2]))).toMatchObject({
      previous_status: 'review_ready',
      status: 'review_stale',
      lane: 'both',
    })
    expect(JSON.parse(String(inserts[1]!.params[2]))).toMatchObject({
      previous_status: 'agent_running',
      status: 'proposal_expired',
      lane: 'both',
    })
    expect(calls.filter((call) => call.sql.startsWith('update context_work_items'))).toHaveLength(2)
    expect(released).toEqual([true])
  })

  it('throttles repeated sweeps inside the configured interval', async () => {
    const { pool, calls } = makePool([])
    const runner = createWorkRequestStaleRunner({ pool })

    expect(await runner.maybeSweep('company-1')).toEqual({ ran: true, updated: 0, failed: 0 })
    expect(await runner.maybeSweep('company-1')).toEqual({ ran: false, updated: 0, failed: 0 })
    expect(calls.filter((call) => call.sql.toLowerCase() === 'begin')).toHaveLength(1)
  })

  it('posts work_item_obstructed observation events to mesh on transition', async () => {
    const { pool } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000001',
        status: 'review_ready',
        lane: 'both',
        severity: 'high',
        route: '/projects/p-1/estimate-push/x',
        entity_type: 'estimate_push',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        status: 'agent_running',
        lane: 'agent',
        severity: null,
        route: null,
        entity_type: null,
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
      const runner = createWorkRequestStaleRunner({
        pool,
        meshObservationDeps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      })
      const summary = await runner.maybeSweep('company-1')
      expect(summary).toEqual({ ran: true, updated: 2, failed: 0 })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      const firstCallArgs = fetchImpl.mock.calls[0]
      const firstUrl = firstCallArgs?.[0] as unknown as string
      expect(firstUrl).toBe('http://mesh.example.test/api/observations/ingest')
      const firstInit = firstCallArgs?.[1] as RequestInit | undefined
      expect(firstInit?.method).toBe('POST')
      const headers = firstInit?.headers as Record<string, string> | undefined
      expect(headers?.['X-Mesh-Component']).toBe('sitelayer-worker')
      expect(headers?.['X-Mesh-Signature']).toMatch(/^sha256=[0-9a-f]+$/)
      expect(headers?.['X-Mesh-Timestamp']).toMatch(/^\d+$/)
      // The wire-shape is now the @operator/projectkit ProjectEventEnvelope:
      // the observation fields live in events[0] (event_type) + its payload.
      type ObservationEnvelope = {
        contract_version: string
        project_key: string
        events: Array<{
          event_type: string
          payload: {
            source: string
            subject: { type: string; id: string }
            status: string
            severity: string
            metadata: { company_id: string; route: string | null }
          }
        }>
      }
      const envelope = JSON.parse(String(firstInit?.body)) as ObservationEnvelope
      // projectkit 0.5.1 stamps the current contract version (was 1.0.0 on 0.1.0).
      expect(envelope.contract_version).toBe('1.3.0')
      expect(envelope.project_key).toBe('sitelayer')
      const event = envelope.events[0]!
      expect(event.event_type).toBe('work_item_obstructed')
      expect(event.payload.source).toBe('sitelayer')
      expect(event.payload.subject).toEqual({ type: 'work_item', id: '00000000-0000-4000-8000-000000000001' })
      expect(event.payload.status).toBe('review_stale')
      expect(event.payload.severity).toBe('high')
      expect(event.payload.metadata.company_id).toBe('company-1')
      expect(event.payload.metadata.route).toBe('/projects/p-1/estimate-push/x')
      const secondEnvelope = JSON.parse(
        String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
      ) as ObservationEnvelope
      const secondEvent = secondEnvelope.events[0]!
      expect(secondEvent.payload.status).toBe('proposal_expired')
      expect(secondEvent.payload.severity).toBe('normal')
      expect(secondEvent.payload.metadata.route).toBeNull()
    } finally {
      if (originalUrl === undefined) delete process.env.MESH_OBSERVATION_INGRESS_URL
      else process.env.MESH_OBSERVATION_INGRESS_URL = originalUrl
      if (originalComponent === undefined) delete process.env.MESH_OBSERVATION_COMPONENT
      else process.env.MESH_OBSERVATION_COMPONENT = originalComponent
      if (originalSecret === undefined) delete process.env.MESH_OBSERVATION_SECRET_HEX
      else process.env.MESH_OBSERVATION_SECRET_HEX = originalSecret
    }
  })

  it('skips the mesh post when observation client is unconfigured', async () => {
    const { pool } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000003',
        status: 'review_ready',
        lane: 'both',
        severity: 'high',
        route: null,
        entity_type: null,
      },
    ])
    const originalUrl = process.env.MESH_OBSERVATION_INGRESS_URL
    delete process.env.MESH_OBSERVATION_INGRESS_URL
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}', { status: 202 }),
    )
    try {
      const runner = createWorkRequestStaleRunner({
        pool,
        meshObservationDeps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      })
      const summary = await runner.maybeSweep('company-2')
      expect(summary).toEqual({ ran: true, updated: 1, failed: 0 })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (originalUrl === undefined) delete process.env.MESH_OBSERVATION_INGRESS_URL
      else process.env.MESH_OBSERVATION_INGRESS_URL = originalUrl
    }
  })

  it('continues the sweep even when the mesh post fails', async () => {
    const { pool } = makePool([
      {
        id: '00000000-0000-4000-8000-000000000004',
        status: 'review_ready',
        lane: 'both',
        severity: null,
        route: null,
        entity_type: null,
      },
    ])
    const originalUrl = process.env.MESH_OBSERVATION_INGRESS_URL
    const originalComponent = process.env.MESH_OBSERVATION_COMPONENT
    const originalSecret = process.env.MESH_OBSERVATION_SECRET_HEX
    process.env.MESH_OBSERVATION_INGRESS_URL = 'http://mesh.example.test/api/observations/ingest'
    process.env.MESH_OBSERVATION_COMPONENT = 'sitelayer-worker'
    process.env.MESH_OBSERVATION_SECRET_HEX = '0011223344'
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error('connection refused')
    })
    try {
      const runner = createWorkRequestStaleRunner({
        pool,
        meshObservationDeps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      })
      const summary = await runner.maybeSweep('company-3')
      // mesh post failure must not break the sweep summary — local
      // audit landed before the POST attempt.
      expect(summary).toEqual({ ran: true, updated: 1, failed: 0 })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
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

import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { createOpsDiagnosticCaptureRouteRunner } from './ops-diagnostic-capture-route.js'

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

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'sitelayer.ops_diagnostic_capture_route.v1',
    ops_diagnostic_session_id: 'session-1',
    action_event_id: 'event-1',
    action_key: 'dispatch_agent_review',
    request_ref: 'opsdiag:session-1:dispatch_agent_review',
    delivery_id: 'opsdiag:session-1:dispatch_agent_review:event-1',
    envelope: {
      contract_version: '1.4.0',
      delivery_id: 'opsdiag:session-1:dispatch_agent_review:event-1',
      events: [],
    },
    ...overrides,
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
      if (normalized.startsWith('update mutation_outbox') && normalized.includes("set status = 'processing'")) {
        if (claimed) return result()
        claimed = true
        return result(claimedRows)
      }
      if (normalized.startsWith("update mutation_outbox set status = 'applied'")) return result([], 1)
      if (normalized.startsWith('update mutation_outbox set status = case when $3')) return result([], 1)
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

describe('createOpsDiagnosticCaptureRouteRunner', () => {
  it('posts claimed capture-route envelopes and marks accepted rows applied', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ routed: true, accepted: 1 }), { status: 202 }))
    const { pool, calls, released } = makePool([{ id: 'outbox-1', payload: makePayload(), attempt_count: 1 }])
    const runner = createOpsDiagnosticCaptureRouteRunner({
      pool,
      logger: makeLogger(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      captureRouterUrl: 'https://router.example.test/',
      timeoutMs: 1000,
    })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, delivered: 1, failed: 0, skipped: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://router.example.test/ingest')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'idempotency-key': 'opsdiag:session-1:dispatch_agent_review:event-1',
    })
    expect(JSON.parse(String(init.body))).toMatchObject({
      delivery_id: 'opsdiag:session-1:dispatch_agent_review:event-1',
    })
    const applied = calls.find((call) => call.sql.includes("set status = 'applied'"))
    expect(JSON.parse(String(applied?.params[1]))).toMatchObject({
      outbox_id: 'outbox-1',
      status: 'accepted',
      http_status: 202,
    })
    expect(released).toEqual([true])
  })

  it('leaves retryable router failures pending with last_result for the next heartbeat', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ routed: false, error: 'router unavailable' }), { status: 503 }),
    )
    const { pool, calls } = makePool([{ id: 'outbox-1', payload: makePayload(), attempt_count: 1 }])
    const runner = createOpsDiagnosticCaptureRouteRunner({
      pool,
      logger: makeLogger(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      captureRouterUrl: 'https://router.example.test',
    })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, delivered: 0, failed: 1, skipped: 0 })
    const pending = calls.find((call) => call.sql.includes('case when $3'))
    expect(pending?.params[2]).toBe(false)
    expect(pending?.params[3]).toBe('router unavailable')
    expect(JSON.parse(String(pending?.params[1]))).toMatchObject({
      outbox_id: 'outbox-1',
      status: 'failed',
      http_status: 503,
      error: 'router unavailable',
    })
  })

  it('parks malformed payloads as terminal failures without calling the router', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 202 }))
    const { pool, calls } = makePool([
      { id: 'outbox-1', payload: makePayload({ delivery_id: null, envelope: null }), attempt_count: 1 },
    ])
    const runner = createOpsDiagnosticCaptureRouteRunner({
      pool,
      logger: makeLogger(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      captureRouterUrl: 'https://router.example.test',
    })

    const summary = await runner('company-1')

    expect(summary).toEqual({ processed: 1, delivered: 0, failed: 1, skipped: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    const failed = calls.find((call) => call.sql.includes('case when $3'))
    expect(failed?.params[2]).toBe(true)
    expect(String(failed?.params[3])).toContain('missing delivery_id or envelope')
  })
})

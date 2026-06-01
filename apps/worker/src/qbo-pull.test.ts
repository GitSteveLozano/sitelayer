import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import {
  DEDICATED_HANDLER_MUTATION_TYPES,
  processOutboxBatch,
  processQboPull,
  type QboPullFn,
  type QueueClient,
} from '@sitelayer/queue'
import { createQboPull } from './qbo-pull.js'

// ---------------------------------------------------------------------------
// Localhost HTTP mock of the QBO sandbox query endpoint. Bind to port 0 so
// the OS picks a free port; tests resolve baseUrl from the actual address.
// Routes GET /v3/company/:realm/query?query=... by the embedded SELECT, so
// the same mock serves Customer / Item / Class. Optionally fails the first
// request with 401 to exercise the token-refresh-and-retry wrapping.
// Mirrors the startQboMock pattern in apps/api/src/qbo-material-bill-sync.test.ts.
// ---------------------------------------------------------------------------
type QboQueryMock = {
  baseUrl: string
  close: () => Promise<void>
  queriesSeen: string[]
  failNext401: () => void
}

function startQboQueryMock(): Promise<QboQueryMock> {
  const queriesSeen: string[] = []
  let pending401 = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.includes('/query?')) {
        const decoded = decodeURIComponent(url)
        queriesSeen.push(decoded)
        if (pending401 > 0) {
          pending401 -= 1
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ fault: 'unauthorized' }))
          return
        }
        let payload: Record<string, unknown> = { QueryResponse: {} }
        if (decoded.includes('FROM Customer')) {
          payload = {
            QueryResponse: {
              Customer: [
                { Id: '101', DisplayName: 'Acme Stucco' },
                { Id: '102', DisplayName: 'Bridgeway LLC' },
              ],
            },
          }
        } else if (decoded.includes('FROM Item')) {
          payload = {
            QueryResponse: {
              Item: [
                { Id: '5001', Name: 'Scaffold Day Rate', UnitPrice: 125, Type: 'Service' },
                // A malformed row (missing Id) — must be tolerated per-row.
                { Name: 'Broken Item', UnitPrice: 9 },
                { Id: '5002', Name: 'EPS Panel', UnitPrice: 40, Type: 'Inventory' },
              ],
            },
          }
        } else if (decoded.includes('FROM Class')) {
          payload = {
            QueryResponse: {
              Class: [{ Id: '900', Name: 'Stucco' }],
            },
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found', method: req.method, url }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        queriesSeen,
        failNext401: () => {
          pending401 += 1
        },
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()))
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// In-memory pg-shaped client for the live pull fn. Each table is a plain
// array; SQL is routed by feature-detecting the statement string (same
// technique as the material-bill test's buildInMemoryRunner). Only the
// statements the pull fn issues are handled.
// ---------------------------------------------------------------------------
type PullState = {
  connection: {
    id: string
    provider_account_id: string | null
    access_token: string | null
    refresh_token: string | null
    status: string
    access_token_expires_at: string | null
  }
  customers: Array<{ id: string; external_id: string; name: string }>
  serviceItems: Array<{ code: string; name: string; default_rate: string }>
  divisions: Array<{ code: string; name: string }>
  mappings: Array<{
    entity_type: string
    local_ref: string
    external_id: string
    label: string
    version: number
    deleted_at: string | null
  }>
  syncEvents: Array<{ entity_type: string; status: string; payload: unknown }>
  refreshCount: number
}

let customerSeq = 1
function buildPullClient(state: PullState): QueueClient {
  return {
    async query<T>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number; command: string; oid: number; fields: never[] }> {
      const rows = (() => {
        // GUC bind from processQboPull — no-op here.
        if (sql.includes('set_config')) return []
        // connection lookup
        if (sql.includes('from integration_connections') && sql.includes('provider = ') && sql.includes('limit 1')) {
          return [state.connection]
        }
        // FOR UPDATE lock during refresh
        if (sql.includes('from integration_connections') && sql.includes('for update')) {
          return [state.connection]
        }
        // token refresh persist
        if (sql.includes('update integration_connections') && sql.includes('access_token = ')) {
          state.refreshCount += 1
          state.connection.access_token = 'access-new'
          return [{ access_token_expires_at: new Date(Date.now() + 3600_000).toISOString() }]
        }
        // customers upsert
        if (sql.includes('insert into customers')) {
          const externalIds = params[1] as string[]
          const names = params[2] as string[]
          const out: Array<{ id: string; external_id: string; name: string }> = []
          externalIds.forEach((ext, i) => {
            let existing = state.customers.find((c) => c.external_id === ext)
            if (!existing) {
              existing = { id: `cust-${customerSeq++}`, external_id: ext, name: names[i]! }
              state.customers.push(existing)
            } else {
              existing.name = names[i]!
            }
            out.push(existing)
          })
          return out
        }
        // service_items upsert
        if (sql.includes('insert into service_items')) {
          const codes = params[1] as string[]
          const names = params[2] as string[]
          const prices = params[3] as string[]
          const out: Array<{ code: string; name: string }> = []
          codes.forEach((code, i) => {
            let existing = state.serviceItems.find((s) => s.code === code)
            if (!existing) {
              existing = { code, name: names[i]!, default_rate: prices[i]! }
              state.serviceItems.push(existing)
            } else {
              existing.name = names[i]!
              existing.default_rate = prices[i]!
            }
            out.push({ code: existing.code, name: existing.name })
          })
          return out
        }
        // integration_mappings upsert
        if (sql.includes('insert into integration_mappings')) {
          const entityType = sql.includes("'customer'")
            ? 'customer'
            : sql.includes("'service_item'")
              ? 'service_item'
              : 'division'
          const localRefs = params[1] as string[]
          const externalIds = params[2] as string[]
          const labels = params[3] as string[]
          localRefs.forEach((lr, i) => {
            const existing = state.mappings.find((m) => m.entity_type === entityType && m.local_ref === lr)
            if (!existing) {
              state.mappings.push({
                entity_type: entityType,
                local_ref: lr,
                external_id: externalIds[i]!,
                label: labels[i]!,
                version: 1,
                deleted_at: null,
              })
            } else {
              existing.external_id = externalIds[i]!
              existing.label = labels[i]!
              existing.version += 1
              existing.deleted_at = null
            }
          })
          return []
        }
        // divisions select
        if (sql.includes('from divisions')) {
          return state.divisions
        }
        // per-row parse_failed sync_events
        if (sql.includes('insert into sync_events')) {
          state.syncEvents.push({
            entity_type: String(sql.includes("'service_item'") ? 'service_item' : 'division'),
            status: 'failed',
            payload: params[2],
          })
          return []
        }
        throw new Error(`Unhandled SQL in pull client: ${sql.slice(0, 120)}`)
      })()
      return { rows: rows as T[], rowCount: (rows as unknown[]).length, command: '', oid: 0, fields: [] }
    },
  }
}

function freshState(): PullState {
  return {
    connection: {
      id: 'conn-1',
      provider_account_id: 'realm-test',
      access_token: 'access-old',
      refresh_token: 'refresh-old',
      status: 'connected',
      access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    customers: [],
    serviceItems: [],
    divisions: [{ code: 'STUCCO', name: 'Stucco' }],
    mappings: [],
    syncEvents: [],
    refreshCount: 0,
  }
}

describe('createQboPull (live pull fn against localhost mock)', () => {
  let mock: QboQueryMock
  beforeAll(async () => {
    mock = await startQboQueryMock()
  })
  afterAll(async () => {
    await mock.close()
  })

  it('hits the right query URLs and upserts customers / service_items / integration_mappings', async () => {
    process.env.QBO_BASE_URL = mock.baseUrl
    const state = freshState()
    const pull = createQboPull()
    const result = await pull({
      client: buildPullClient(state),
      companyId: 'company-1',
      connectionId: 'conn-1',
      payload: {},
    })

    // Counts: 2 customers, 2 items (one malformed item skipped), 1 class
    // mapped to the STUCCO division.
    expect(result.pulledCustomers).toBe(2)
    expect(result.pulledItems).toBe(2)
    expect(result.pulledClasses).toBe(1)

    // Correct query URLs hit.
    expect(mock.queriesSeen.some((q) => q.includes('FROM Customer'))).toBe(true)
    expect(mock.queriesSeen.some((q) => q.includes('FROM Item'))).toBe(true)
    expect(mock.queriesSeen.some((q) => q.includes('FROM Class'))).toBe(true)

    // customers + service_items landed.
    expect(state.customers.map((c) => c.external_id).sort()).toEqual(['101', '102'])
    expect(state.serviceItems.map((s) => s.code).sort()).toEqual(['qbo-5001', 'qbo-5002'])

    // integration_mappings landed for each entity type.
    expect(state.mappings.filter((m) => m.entity_type === 'customer')).toHaveLength(2)
    expect(state.mappings.filter((m) => m.entity_type === 'service_item')).toHaveLength(2)
    expect(state.mappings.filter((m) => m.entity_type === 'division')).toHaveLength(1)

    // Per-row tolerance: the malformed item recorded a parse_failed event but
    // did NOT fail the whole pull.
    expect(state.syncEvents.some((e) => e.status === 'failed' && e.entity_type === 'service_item')).toBe(true)
  })

  it('is idempotent on re-run — no dupes, mapping version bumps, deleted_at cleared', async () => {
    process.env.QBO_BASE_URL = mock.baseUrl
    const state = freshState()
    // Pre-seed an existing customer for external_id '101' AND a soft-deleted
    // mapping keyed on that customer's local_ref, so the next pull's
    // on-conflict mapping upsert hits it and proves deleted_at is cleared +
    // version bumps.
    state.customers.push({ id: 'cust-existing', external_id: '101', name: 'stale' })
    state.mappings.push({
      entity_type: 'customer',
      local_ref: 'cust-existing',
      external_id: '101',
      label: 'old',
      version: 3,
      deleted_at: '2026-01-01T00:00:00Z',
    })
    const pull = createQboPull()
    const client = buildPullClient(state)
    await pull({ client, companyId: 'company-1', connectionId: 'conn-1', payload: {} })
    const customerCountAfterFirst = state.customers.length
    const customerMappingsAfterFirst = state.mappings.filter((m) => m.entity_type === 'customer').length

    // The pre-seeded mapping for the re-pulled customer was re-armed.
    const reArmed = state.mappings.find((m) => m.local_ref === 'cust-existing')
    expect(reArmed?.deleted_at).toBeNull()
    expect(reArmed?.version).toBeGreaterThanOrEqual(4)

    await pull({ client, companyId: 'company-1', connectionId: 'conn-1', payload: {} })

    // No duplicate customers / mappings on the second pull.
    expect(state.customers.length).toBe(customerCountAfterFirst)
    expect(state.mappings.filter((m) => m.entity_type === 'customer').length).toBe(customerMappingsAfterFirst)
    // Every mapping has a bumped version and a cleared deleted_at.
    for (const m of state.mappings) {
      expect(m.version).toBeGreaterThanOrEqual(2)
      expect(m.deleted_at).toBeNull()
    }
  })

  it('refreshes and retries on a 401 from the first query', async () => {
    process.env.QBO_BASE_URL = mock.baseUrl
    process.env.QBO_CLIENT_ID = 'client-x'
    process.env.QBO_CLIENT_SECRET = 'secret-x'
    const state = freshState()
    mock.failNext401()
    const pull = createQboPull({
      // Stub the token-refresh HTTP call so we never hit Intuit.
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('oauth.platform.intuit.com')) {
          return new Response(
            JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return fetch(url, init)
      }) as unknown as typeof fetch,
    })
    const result = await pull({
      client: buildPullClient(state),
      companyId: 'company-1',
      connectionId: 'conn-1',
      payload: {},
    })
    expect(result.pulledCustomers).toBe(2)
    expect(state.refreshCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// processQboPull envelope tests against an in-memory outbox runner.
// ---------------------------------------------------------------------------
type OutboxRow = {
  id: string
  company_id: string
  entity_type: string
  entity_id: string
  mutation_type: string
  payload: Record<string, unknown>
  status: string
  attempt_count: number
  next_attempt_at: string
  applied_at: string | null
  error: string | null
  created_at: string
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
  capture_session_id: string | null
  idempotency_key?: string
}

type EnvState = {
  outbox: OutboxRow[]
  connections: Array<{ id: string; company_id: string; last_synced_at: string | null; status: string }>
  syncEvents: Array<{ entity_type: string; status: string; payload: unknown }>
}

function buildEnvClient(state: EnvState): QueueClient {
  return {
    async query<T>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number; command: string; oid: number; fields: never[] }> {
      const s = sql.toLowerCase()
      const rows = (() => {
        if (s.includes('begin') || s.includes('commit') || s.includes('rollback')) return []
        if (s.includes('set_config')) return []
        // Phase-1 claim
        if (s.includes('update mutation_outbox') && s.includes('set') && s.includes("status = 'processing'")) {
          const companyId = String(params[0])
          const limit = Number(params[1])
          const claimed = state.outbox
            .filter(
              (r) =>
                r.company_id === companyId &&
                r.entity_type === 'integration_connection' &&
                r.mutation_type === 'pull_qbo_reference' &&
                (r.status === 'pending' || r.status === 'processing'),
            )
            .slice(0, limit)
          for (const r of claimed) {
            r.status = 'processing'
            r.attempt_count += 1
            r.error = null
          }
          return claimed.map((r) => ({
            id: r.id,
            entity_id: r.entity_id,
            payload: r.payload,
            attempt_count: r.attempt_count,
            sentry_trace: r.sentry_trace,
            sentry_baggage: r.sentry_baggage,
            request_id: r.request_id,
            capture_session_id: r.capture_session_id,
          }))
        }
        // mark applied
        if (s.includes('update mutation_outbox') && s.includes("status = 'applied'")) {
          const id = String(params[1])
          const row = state.outbox.find((r) => r.id === id)
          if (row) {
            row.status = 'applied'
            row.applied_at = new Date().toISOString()
          }
          return []
        }
        // markOutboxRowFailedFresh
        if (s.includes('update mutation_outbox') && s.includes("status = 'failed'")) {
          const id = String(params[1])
          const row = state.outbox.find((r) => r.id === id)
          if (row) {
            row.status = 'failed'
            row.error = String(params[2])
          }
          return []
        }
        // connection stamp
        if (s.includes('update integration_connections')) {
          const id = String(params[2])
          const conn = state.connections.find((c) => c.id === id)
          if (conn) {
            conn.last_synced_at = new Date().toISOString()
            conn.status = 'connected'
          }
          return []
        }
        // sync_events
        if (s.includes('insert into sync_events')) {
          state.syncEvents.push({
            entity_type: 'qbo_pull',
            status: String(params[4] ?? 'applied'),
            payload: params[3],
          })
          return []
        }
        throw new Error(`Unhandled SQL in env client: ${sql.slice(0, 120)}`)
      })()
      return { rows: rows as T[], rowCount: (rows as unknown[]).length, command: '', oid: 0, fields: [] }
    },
  }
}

function makeOutboxRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'ob-1',
    company_id: 'company-1',
    entity_type: 'integration_connection',
    entity_id: 'conn-1',
    mutation_type: 'pull_qbo_reference',
    payload: {},
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    applied_at: null,
    error: null,
    created_at: new Date().toISOString(),
    sentry_trace: null,
    sentry_baggage: null,
    request_id: null,
    capture_session_id: null,
    ...over,
  }
}

describe('processQboPull (envelope)', () => {
  it('success path: claim → applied + inbound sync_events + connection stamp', async () => {
    const state: EnvState = {
      outbox: [makeOutboxRow()],
      connections: [{ id: 'conn-1', company_id: 'company-1', last_synced_at: null, status: 'connecting' }],
      syncEvents: [],
    }
    const pull: QboPullFn = async () => ({ pulledCustomers: 3, pulledItems: 5, pulledClasses: 1 })
    const summary = await processQboPull(buildEnvClient(state), 'company-1', pull, 1)

    expect(summary.processed).toBe(1)
    expect(summary.pulled).toBe(1)
    expect(summary.failed).toBe(0)
    expect(state.outbox[0]?.status).toBe('applied')
    expect(state.connections[0]?.last_synced_at).not.toBeNull()
    const ev = state.syncEvents.find((e) => e.status === 'applied')
    expect(ev).toBeDefined()
    expect((JSON.parse(String(ev?.payload)) as { action?: string }).action).toBe('pull_succeeded')
  })

  it('throw path: pull fn throws → outbox failed + failure sync_events', async () => {
    const state: EnvState = {
      outbox: [makeOutboxRow({ id: 'ob-2' })],
      connections: [{ id: 'conn-1', company_id: 'company-1', last_synced_at: null, status: 'connected' }],
      syncEvents: [],
    }
    const pull: QboPullFn = async () => {
      throw new Error('qbo 500 boom')
    }
    const summary = await processQboPull(buildEnvClient(state), 'company-1', pull, 1)

    expect(summary.processed).toBe(1)
    expect(summary.pulled).toBe(0)
    expect(summary.failed).toBe(1)
    expect(state.outbox[0]?.status).toBe('failed')
    expect(state.outbox[0]?.error).toContain('qbo 500 boom')
    const failEv = state.syncEvents.find((e) => e.status === 'failed')
    expect(failEv).toBeDefined()
    expect((JSON.parse(String(failEv?.payload)) as { action?: string }).action).toBe('pull_failed')
  })

  it('no pending rows: no-op summary', async () => {
    const state: EnvState = {
      outbox: [makeOutboxRow({ status: 'applied', applied_at: new Date().toISOString() })],
      connections: [],
      syncEvents: [],
    }
    const pull: QboPullFn = async () => ({ pulledCustomers: 1, pulledItems: 1, pulledClasses: 0 })
    const summary = await processQboPull(buildEnvClient(state), 'company-1', pull, 1)
    expect(summary.processed).toBe(0)
    expect(summary.pulled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// DEDICATED_HANDLER guard: the generic drain must NOT claim a
// pull_qbo_reference row (risk #2). processOutboxBatch excludes the dedicated
// mutation_types via `mutation_type <> all($3)`.
// ---------------------------------------------------------------------------
describe('DEDICATED_HANDLER_MUTATION_TYPES guard', () => {
  it('lists pull_qbo_reference', () => {
    expect((DEDICATED_HANDLER_MUTATION_TYPES as readonly string[]).includes('pull_qbo_reference')).toBe(true)
  })

  it('processOutboxBatch skips a pull_qbo_reference row', async () => {
    let claimSql = ''
    const client: QueueClient = {
      async query<T>(
        sql: string,
        params: unknown[] = [],
      ): Promise<{ rows: T[]; rowCount: number; command: string; oid: number; fields: never[] }> {
        const s = sql.toLowerCase()
        if (s.includes('update mutation_outbox') && s.includes('returning id')) {
          claimSql = sql
          // Assert the exclusion array (3rd param) carries our mutation_type.
          const exclusions = params[2] as string[]
          expect(exclusions.includes('pull_qbo_reference')).toBe(true)
          // Simulate the SQL filter excluding our row → claim nothing.
          return { rows: [] as T[], rowCount: 0, command: '', oid: 0, fields: [] }
        }
        throw new Error(`unexpected sql: ${sql.slice(0, 80)}`)
      },
    }
    const result = await processOutboxBatch(client, 'company-1', 25)
    expect(result).toEqual([])
    expect(claimSql).toContain('mutation_type <> all')
  })
})

// ---------------------------------------------------------------------------
// Idempotency-key re-arm semantics (risk #4). The API enqueue route uses a
// per-connection key + an on-conflict re-arm guarded to
// status in ('applied','failed','dead'). This unit models that upsert against
// an in-memory outbox to prove: queued click = no-op; finished click = re-arm.
// ---------------------------------------------------------------------------
describe('pull idempotency-key re-arm', () => {
  function applyReArm(rows: OutboxRow[], key: string): void {
    const existing = rows.find((r) => r.idempotency_key === key)
    if (!existing) {
      rows.push(makeOutboxRow({ id: `ob-${rows.length + 1}`, idempotency_key: key }))
      return
    }
    // on conflict ... where status in ('applied','failed','dead')
    if (['applied', 'failed', 'dead'].includes(existing.status)) {
      existing.status = 'pending'
      existing.error = null
    }
    // else: no-op (queued/processing row left alone)
  }

  it('second click while pending is a no-op; click after applied re-arms to pending', () => {
    const key = 'integration_connection:qbo:pull:conn-1'
    const rows: OutboxRow[] = []
    applyReArm(rows, key)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')

    // Click again while still pending → no new row, stays pending.
    applyReArm(rows, key)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')

    // Worker finishes the pull.
    rows[0]!.status = 'applied'
    // Operator clicks Backfill again → re-arm back to pending.
    applyReArm(rows, key)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
  })
})

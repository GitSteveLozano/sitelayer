import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleSyncRoutes, type SyncRouteCtx } from './sync.js'

// ---------------------------------------------------------------------------
// In-memory pg double for /api/sync/* — covers the three GET endpoints and
// the POST drain. Mirrors the pattern in projects.test.ts; not a general-
// purpose SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  connections: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  pendingOutboxCount = 0
  pendingSyncEventCount = 0

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/from mutation_outbox/i.test(sql) && /count\(\*\)::int as pending_count/i.test(sql)) {
      return { rows: [{ pending_count: this.pendingOutboxCount }], rowCount: 1 }
    }
    if (/from sync_events/i.test(sql) && /count\(\*\)::int as pending_count/i.test(sql)) {
      return { rows: [{ pending_count: this.pendingSyncEventCount }], rowCount: 1 }
    }
    if (/from integration_connections/i.test(sql) && /select id, provider/i.test(sql)) {
      const companyId = params[0] as string
      return {
        rows: this.connections.filter((c) => c.company_id === companyId),
        rowCount: this.connections.filter((c) => c.company_id === companyId).length,
      }
    }
    if (/from sync_events/i.test(sql) && /order by created_at desc\s+limit 1/i.test(sql)) {
      const companyId = params[0] as string
      const rows = this.syncEvents.filter((e) => e.company_id === companyId)
      return { rows: rows.length ? [rows[0]!] : [], rowCount: rows.length ? 1 : 0 }
    }
    if (/from sync_events/i.test(sql) && /order by created_at desc\s+limit \$2/i.test(sql)) {
      const companyId = params[0] as string
      const limit = Number(params[1])
      const rows = this.syncEvents.filter((e) => e.company_id === companyId).slice(0, limit)
      return { rows, rowCount: rows.length }
    }
    if (/from mutation_outbox/i.test(sql) && /order by created_at desc/i.test(sql)) {
      const companyId = params[0] as string
      const limit = Number(params[1])
      const rows = this.outbox.filter((e) => e.company_id === companyId).slice(0, limit)
      return { rows, rowCount: rows.length }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): {
  ctx: SyncRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status: number, response: unknown) => {
        responses.push({ status, body: response })
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleSyncRoutes — GET /api/sync/status', () => {
  it('returns connection list + queue depths + latest sync event for the active company', async () => {
    const pool = new FakePool()
    pool.connections.push({
      id: 'conn-1',
      company_id: 'co-1',
      provider: 'qbo',
      provider_account_id: 'realm-1',
      sync_cursor: '2026-05-01',
      last_synced_at: '2026-05-10T00:00:00.000Z',
      status: 'connected',
      version: 3,
      created_at: '2026-04-01T00:00:00.000Z',
    })
    pool.pendingOutboxCount = 4
    pool.pendingSyncEventCount = 2
    pool.syncEvents.push({
      company_id: 'co-1',
      created_at: '2026-05-10T01:00:00.000Z',
      entity_type: 'rental_billing_run',
      entity_id: 'r-1',
      direction: 'local',
      status: 'pending',
      attempt_count: 0,
      applied_at: null,
      error: null,
    })

    const { ctx, responses } = makeCtx(pool)
    const handled = await handleSyncRoutes({ method: 'GET' } as never, buildUrl('/api/sync/status'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const body = responses[0]?.body as {
      company: { id: string }
      pendingOutboxCount: number
      pendingSyncEventCount: number
      connections: Array<{ provider: string }>
      latestSyncEvent: { entity_type: string } | null
    }
    expect(body.company.id).toBe('co-1')
    expect(body.pendingOutboxCount).toBe(4)
    expect(body.pendingSyncEventCount).toBe(2)
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]?.provider).toBe('qbo')
    expect(body.latestSyncEvent?.entity_type).toBe('rental_billing_run')
  })

  it('returns 0 queue depths and empty connection list for a quiet company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleSyncRoutes({ method: 'GET' } as never, buildUrl('/api/sync/status'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { pendingOutboxCount: number; connections: unknown[]; latestSyncEvent: unknown }
    expect(body.pendingOutboxCount).toBe(0)
    expect(body.connections).toEqual([])
    expect(body.latestSyncEvent).toBeNull()
  })
})

describe('handleSyncRoutes — GET /api/sync/events', () => {
  it('returns the recent sync_events ledger capped at the requested limit', async () => {
    const pool = new FakePool()
    for (let i = 0; i < 10; i += 1) {
      pool.syncEvents.push({
        company_id: 'co-1',
        id: `e-${i}`,
        entity_type: 'integration_connection',
        entity_id: `conn-${i}`,
        direction: 'local',
        status: 'pending',
        attempt_count: 0,
        created_at: `2026-05-0${i}T00:00:00.000Z`,
      })
    }
    const { ctx, responses } = makeCtx(pool)
    await handleSyncRoutes({ method: 'GET' } as never, buildUrl('/api/sync/events?limit=5'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { events: unknown[] }
    expect(body.events).toHaveLength(5)
  })

  it('clamps the limit between 1 and 100', async () => {
    const pool = new FakePool()
    for (let i = 0; i < 150; i += 1) {
      pool.syncEvents.push({ company_id: 'co-1', id: `e-${i}` })
    }
    const { ctx, responses } = makeCtx(pool)
    await handleSyncRoutes({ method: 'GET' } as never, buildUrl('/api/sync/events?limit=999'), ctx)
    const body = responses[0]?.body as { events: unknown[] }
    // Default limit clamping caps at 100.
    expect(body.events).toHaveLength(100)
  })
})

describe('handleSyncRoutes — GET /api/sync/outbox', () => {
  it('returns the recent mutation_outbox ledger', async () => {
    const pool = new FakePool()
    pool.outbox.push({
      company_id: 'co-1',
      id: 'o-1',
      device_id: 'server',
      entity_type: 'rental_billing_run',
      entity_id: 'r-1',
      mutation_type: 'post_qbo_invoice',
      idempotency_key: 'rental_billing_run:post:r-1',
      status: 'pending',
      attempt_count: 0,
      created_at: '2026-05-10T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleSyncRoutes({ method: 'GET' } as never, buildUrl('/api/sync/outbox'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { outbox: Array<{ mutation_type: string }> }
    expect(body.outbox).toHaveLength(1)
    expect(body.outbox[0]?.mutation_type).toBe('post_qbo_invoice')
  })
})

// ---------------------------------------------------------------------------
// POST /api/sync/process — needs to mock @sitelayer/queue so we don't
// re-prove the queue's tx behavior here (covered by packages/queue tests).
// ---------------------------------------------------------------------------

vi.mock('@sitelayer/queue', () => ({
  processQueue: vi.fn(async (_pool: unknown, companyId: string, limit: number) => ({
    processedOutboxCount: 1,
    processedSyncEventCount: 0,
    outbox: [{ id: 'o-1', company_id: companyId, limit }],
    syncEvents: [],
  })),
}))

describe('handleSyncRoutes — POST /api/sync/process', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, 'member')
    await handleSyncRoutes({ method: 'POST' } as never, buildUrl('/api/sync/process'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('drains the queue and returns the processQueue summary', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { limit: 10 })
    await handleSyncRoutes({ method: 'POST' } as never, buildUrl('/api/sync/process'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { processedOutboxCount: number }
    expect(body.processedOutboxCount).toBe(1)
  })
})

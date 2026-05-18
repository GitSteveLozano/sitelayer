import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleQboRoutes, type QboConfig, type QboRouteCtx } from './qbo.js'

// ---------------------------------------------------------------------------
// QBO route handler — narrow surface: GET /auth (OAuth URL), GET /
// (connection status), POST / (connection update + version guard).
//
// The full /sync path makes real fetch() calls against Intuit; covered
// instead by qbo-material-bill-sync.test.ts (localhost HTTP mock) and the
// sandbox smoke script. The OAuth /callback path is similarly skipped —
// it shells out to fetch + Sentry spans that we don't want to stand up
// here. These tests target the routes that the SPA hits on every page
// load.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  connections: Array<{
    id: string
    company_id: string
    provider: string
    provider_account_id: string | null
    access_token: string | null
    refresh_token: string | null
    webhook_secret: string | null
    sync_cursor: string | null
    last_synced_at: string | null
    retry_state: Record<string, unknown> | null
    rate_limit_state: Record<string, unknown> | null
    status: string
    version: number
    created_at: string
  }> = []
  pendingOutboxCount = 0
  pendingSyncEventCount = 0
  latestSyncEvent: Record<string, unknown> | null = null
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []
  private nextConnId = 1

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

    // Queue depth helpers used by getSyncStatus
    if (/count\(\*\)::int as pending_count/i.test(sql)) {
      if (/from mutation_outbox/i.test(sql)) {
        return { rows: [{ pending_count: this.pendingOutboxCount }], rowCount: 1 }
      }
      return { rows: [{ pending_count: this.pendingSyncEventCount }], rowCount: 1 }
    }

    // getIntegrationConnection (no secrets, by (company, provider), limit 1)
    if (
      /from integration_connections/i.test(sql) &&
      /order by created_at desc/i.test(sql) &&
      /limit 1/i.test(sql) &&
      !/access_token/i.test(sql)
    ) {
      const [companyId, provider] = params as [string, string]
      const rows = this.connections
        .filter((c) => c.company_id === companyId && c.provider === provider)
        .map((c) => ({
          id: c.id,
          provider: c.provider,
          provider_account_id: c.provider_account_id,
          sync_cursor: c.sync_cursor,
          last_synced_at: c.last_synced_at,
          retry_state: c.retry_state,
          rate_limit_state: c.rate_limit_state,
          status: c.status,
          version: c.version,
          created_at: c.created_at,
        }))
      return { rows: rows.slice(0, 1), rowCount: rows.length ? 1 : 0 }
    }

    // getSyncStatus connection list (no secrets, order by created_at asc)
    if (
      /from integration_connections/i.test(sql) &&
      /order by created_at asc/i.test(sql) &&
      !/access_token/i.test(sql)
    ) {
      const [companyId] = params as [string]
      const rows = this.connections
        .filter((c) => c.company_id === companyId)
        .map((c) => ({
          id: c.id,
          provider: c.provider,
          provider_account_id: c.provider_account_id,
          sync_cursor: c.sync_cursor,
          last_synced_at: c.last_synced_at,
          status: c.status,
          version: c.version,
          created_at: c.created_at,
        }))
      return { rows, rowCount: rows.length }
    }

    // getIntegrationConnectionWithSecrets
    if (/from integration_connections/i.test(sql) && /access_token/i.test(sql)) {
      const [companyId, provider] = params as [string, string]
      const row = this.connections.find((c) => c.company_id === companyId && c.provider === provider)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // upsertIntegrationConnection — insert
    if (/^\s*insert into integration_connections/i.test(sql)) {
      const [companyId, provider, providerAccountId, accessToken, refreshToken, webhookSecret, syncCursor, status] =
        params as [string, string, string | null, string | null, string | null, string | null, string | null, string]
      const row = {
        id: `conn-${this.nextConnId++}`,
        company_id: companyId,
        provider,
        provider_account_id: providerAccountId,
        access_token: accessToken,
        refresh_token: refreshToken,
        webhook_secret: webhookSecret,
        sync_cursor: syncCursor,
        last_synced_at: null,
        retry_state: null,
        rate_limit_state: null,
        status,
        version: 1,
        created_at: new Date().toISOString(),
      }
      this.connections.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // upsertIntegrationConnection — update
    if (/^update integration_connections/i.test(sql) && /coalesce/i.test(sql)) {
      const [companyId, provider] = params as [string, string]
      // Params 9, 10 are connection id and expected_version (nullable).
      const expectedVersion = params[9] as number | null | undefined
      const row = this.connections.find((c) => c.company_id === companyId && c.provider === provider)
      if (!row) return { rows: [], rowCount: 0 }
      // Honour the WHERE (version = $expected) guard so the test can
      // exercise the concurrency 409 path.
      if (expectedVersion !== null && expectedVersion !== undefined && row.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
      // Field 3+ are coalesce values; bump version.
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    // Latest sync_events read
    if (/from sync_events/i.test(sql) && /order by created_at desc/i.test(sql)) {
      return { rows: this.latestSyncEvent ? [this.latestSyncEvent] : [], rowCount: this.latestSyncEvent ? 1 : 0 }
    }

    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const QBO_CONFIG: QboConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost/api/integrations/qbo/callback',
  successRedirectUri: '',
  stateSecret: 'state-secret-32-bytes-long-1234567890ab',
  baseUrl: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): {
  ctx: QboRouteCtx
  responses: Array<{ status: number; body: unknown }>
  redirects: string[]
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const redirects: string[] = []
  return {
    responses,
    redirects,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      sendRedirect: (location) => {
        redirects.push(location)
      },
      qboConfig: QBO_CONFIG,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleQboRoutes — GET /api/integrations/qbo/auth', () => {
  it('returns an Intuit OAuth URL with client_id, redirect_uri, response_type, scope, and a signed state', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboRoutes({ method: 'GET' } as never, buildUrl('/api/integrations/qbo/auth'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { authUrl: string }
    expect(body.authUrl).toContain('https://appcenter.intuit.com/connect/oauth2')
    expect(body.authUrl).toContain('client_id=cid')
    expect(body.authUrl).toContain('response_type=code')
    expect(body.authUrl).toContain('scope=com.intuit.quickbooks.accounting')
    expect(body.authUrl).toContain('state=')
  })
})

describe('handleQboRoutes — GET /api/integrations/qbo', () => {
  it('returns the connection row plus the sync status snapshot', async () => {
    const pool = new FakePool()
    pool.connections.push({
      id: 'conn-1',
      company_id: 'co-1',
      provider: 'qbo',
      provider_account_id: 'realm-1',
      access_token: 'tok',
      refresh_token: 'ref',
      webhook_secret: null,
      sync_cursor: '2026-05-01',
      last_synced_at: '2026-05-10T00:00:00.000Z',
      retry_state: null,
      rate_limit_state: null,
      status: 'connected',
      version: 3,
      created_at: '2026-04-01T00:00:00.000Z',
    })
    pool.pendingOutboxCount = 1
    pool.pendingSyncEventCount = 2

    const { ctx, responses } = makeCtx(pool)
    await handleQboRoutes({ method: 'GET' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as {
      connection: { provider: string } | null
      status: { pendingOutboxCount: number; pendingSyncEventCount: number; connections: unknown[] }
    }
    expect(body.connection?.provider).toBe('qbo')
    expect(body.status.pendingOutboxCount).toBe(1)
    expect(body.status.pendingSyncEventCount).toBe(2)
    expect(body.status.connections).toHaveLength(1)
  })

  it('returns null connection when no QBO row exists for the company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboRoutes({ method: 'GET' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { connection: unknown }
    expect(body.connection).toBeNull()
  })
})

describe('handleQboRoutes — POST /api/integrations/qbo', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, 'member')
    await handleQboRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('returns 409 when expected_version disagrees with the persisted connection version', async () => {
    const pool = new FakePool()
    pool.connections.push({
      id: 'conn-1',
      company_id: 'co-1',
      provider: 'qbo',
      provider_account_id: null,
      access_token: null,
      refresh_token: null,
      webhook_secret: null,
      sync_cursor: null,
      last_synced_at: null,
      retry_state: null,
      rate_limit_state: null,
      status: 'connected',
      version: 5,
      created_at: '',
    })
    const { ctx, responses } = makeCtx(pool, { status: 'disconnected', expected_version: 1 })
    await handleQboRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { current_version: number }
    expect(body.current_version).toBe(5)
  })

  it('returns 409 when a concurrent writer bumps the version between the pre-tx read and the UPDATE', async () => {
    // Models the race the audit flagged: two POSTs with expected_version=5
    // both pass the pre-tx version check (currentConnection.version === 5),
    // but the second one's UPDATE must lose because the first has already
    // bumped the row to version 6. The WHERE (version = $expected) guard
    // inside upsertIntegrationConnection enforces this, and the route
    // surfaces a 409 with the live version instead of silently clobbering.
    const pool = new FakePool()
    pool.connections.push({
      id: 'conn-1',
      company_id: 'co-1',
      provider: 'qbo',
      provider_account_id: null,
      access_token: null,
      refresh_token: null,
      webhook_secret: null,
      sync_cursor: null,
      last_synced_at: null,
      retry_state: null,
      rate_limit_state: null,
      status: 'connected',
      version: 5,
      created_at: '',
    })
    // Inject a concurrent bump between the pre-tx getIntegrationConnection
    // read (the first SELECT against integration_connections) and the
    // upsert's internal getIntegrationConnection / UPDATE that runs inside
    // withMutationTx. We override `query` so the second SELECT-from-
    // integration_connections call sees a bumped row, simulating another
    // tab that committed in the window between the two reads.
    const { ctx, responses } = makeCtx(pool, { status: 'connected', expected_version: 5 })
    let selectsSeen = 0
    const realQuery = pool.query.bind(pool)
    pool.query = (async (sql: string, params: unknown[] = []) => {
      const isConnectionSelect =
        /from integration_connections/i.test(sql) && /order by created_at desc/i.test(sql) && !/access_token/i.test(sql)
      if (isConnectionSelect) {
        selectsSeen++
        // After the route's pre-tx read passes, bump the persisted row so
        // the upsert sees a version mismatch on its WHERE guard.
        if (selectsSeen === 1) {
          const row = pool.connections.find((c) => c.id === 'conn-1')
          if (row) row.version = 6
        }
      }
      return realQuery(sql, params)
    }) as typeof pool.query
    await handleQboRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(409)
    const body = responses[0]?.body as { current_version: number | null; error: string }
    expect(body.error).toBe('version conflict')
    expect(body.current_version).toBe(6)
    // Importantly: the second writer was rejected, so version stayed at 6
    // (the value the concurrent writer set) and didn't get bumped further.
    expect(pool.connections[0]?.version).toBe(6)
  })

  it('writes a sync_events + mutation_outbox row after upserting the connection', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      provider_account_id: 'realm-1',
      access_token: 'tok',
      refresh_token: 'ref',
      status: 'connected',
    })
    await handleQboRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.connections).toHaveLength(1)
    expect(pool.syncEvents.length).toBeGreaterThan(0)
    expect(pool.outbox.length).toBeGreaterThan(0)
  })
})

describe('handleQboRoutes — GET /api/integrations/qbo/callback', () => {
  it('400s when code/realmId/state are missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboRoutes({ method: 'GET' } as never, buildUrl('/api/integrations/qbo/callback?code=x'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('400s when the state token is malformed', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/integrations/qbo/callback?code=x&realmId=r&state=not-a-real-state'),
      ctx,
    )
    // The decoder throws with a non-200; route surfaces the underlying status.
    expect(responses[0]?.status).toBeGreaterThanOrEqual(400)
    expect(responses[0]?.status).toBeLessThan(500)
  })
})

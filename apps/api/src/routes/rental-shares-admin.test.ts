import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleRentalShareAdminRoutes, type RentalShareAdminRouteCtx } from './rental-shares-admin.js'

// ---------------------------------------------------------------------------
// Owner-side rental share-link admin — revoke + access-audit list (LANE A).
// In-memory pg double matching only the SQL this route emits, mirroring the
// stub style of the sibling share-route tests.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  links: Row[] = []
  auditRows: unknown[][] = []

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
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config') ||
      normalized.startsWith('set local')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (normalized.startsWith('select') && normalized.includes('from rental_share_links')) {
      const [companyId, customerId] = params as [string, string | undefined]
      const rows = this.links.filter(
        (l) => l.company_id === companyId && (customerId == null || l.customer_id === customerId),
      )
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('update rental_share_links') && normalized.includes('set revoked_at = now()')) {
      const [companyId, id] = params as [string, string]
      const row = this.links.find((l) => l.company_id === companyId && l.id === id && l.revoked_at == null)
      if (!row) return { rows: [], rowCount: 0 }
      row.revoked_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('insert into audit_events')) {
      this.auditRows.push(params)
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in rental-share-admin fake pool: ${normalized.slice(0, 160)}`)
  }
}

function makeCtx(pool: FakePool, overrides: Partial<RentalShareAdminRouteCtx> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const ctx: RentalShareAdminRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
    currentUserId: 'u-admin',
    requireRole: () => true,
    sendJson: (status, body) => responses.push({ status, body }),
    ...overrides,
  }
  return { ctx, responses }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function seedLink(pool: FakePool, overrides: Row = {}): string {
  const id = String(overrides.id ?? `rsl-${pool.links.length + 1}`)
  pool.links.push({
    id,
    company_id: 'co-1',
    customer_id: 'cust-1',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    revoked_at: null,
    last_accessed_at: '2026-06-05T00:00:00.000Z',
    access_count: 4,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  })
  return id
}

describe('handleRentalShareAdminRoutes', () => {
  it('ignores unrelated routes', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalShareAdminRoutes({ method: 'GET' } as never, buildUrl('/api/projects/p-1'), ctx)
    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
  })

  it('GET /api/rental-share-links lists usage (access_count/last_accessed_at) without the token', async () => {
    const pool = new FakePool()
    seedLink(pool)
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleRentalShareAdminRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/rental-share-links'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { links: Array<Record<string, unknown>> }
    expect(body.links).toHaveLength(1)
    expect(body.links[0]).toMatchObject({ access_count: 4, status: 'active', customer_id: 'cust-1' })
    expect(body.links[0]).toHaveProperty('last_accessed_at')
    // The raw token is never re-listed to the owner.
    expect(body.links[0]).not.toHaveProperty('share_token')
  })

  it('GET surfaces a revoked link with status="revoked"', async () => {
    const pool = new FakePool()
    seedLink(pool, { revoked_at: '2026-06-06T00:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalShareAdminRoutes({ method: 'GET' } as never, buildUrl('/api/rental-share-links'), ctx)
    const body = responses[0]?.body as { links: Array<{ status: string }> }
    expect(body.links[0]?.status).toBe('revoked')
  })

  it('POST /:id/revoke sets revoked_at and writes an audit row', async () => {
    const pool = new FakePool()
    const id = seedLink(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleRentalShareAdminRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-share-links/${id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { status: string }).status).toBe('revoked')
    expect(pool.links[0]?.revoked_at).not.toBeNull()
    // Audit trail records the kill.
    expect(pool.auditRows).toHaveLength(1)
    const auditParams = pool.auditRows[0]!
    expect(auditParams).toContain('rental_share_link')
    expect(auditParams).toContain('revoke')
  })

  it('POST /:id/revoke is idempotent — re-revoking 404s (already revoked)', async () => {
    const pool = new FakePool()
    const id = seedLink(pool, { revoked_at: '2026-06-06T00:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalShareAdminRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-share-links/${id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('GET requires the owning company admin/office role (403 otherwise, no DB read)', async () => {
    const pool = new FakePool()
    seedLink(pool)
    // The dispatcher's requireRole emits the 403 itself and returns false; model
    // that by capturing the recorded responses in the stub.
    const { ctx, responses } = makeCtx(pool)
    ctx.requireRole = () => {
      ctx.sendJson(403, { error: 'forbidden' })
      return false
    }
    await handleRentalShareAdminRoutes({ method: 'GET' } as never, buildUrl('/api/rental-share-links'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('POST /:id/revoke requires the owning company admin/office role', async () => {
    const pool = new FakePool()
    const id = seedLink(pool)
    const { ctx, responses } = makeCtx(pool)
    ctx.requireRole = () => {
      ctx.sendJson(403, { error: 'forbidden' })
      return false
    }
    await handleRentalShareAdminRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/rental-share-links/${id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
    // Never revoked — the role gate short-circuits before the DB write.
    expect(pool.links[0]?.revoked_at).toBeNull()
  })

  it('revoke scopes by company — a link from another company is not found', async () => {
    const pool = new FakePool()
    seedLink(pool, { id: 'other-co-link', company_id: 'co-2' })
    const { ctx, responses } = makeCtx(pool)
    await handleRentalShareAdminRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/rental-share-links/other-co-link/revoke'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
    expect(pool.links[0]?.revoked_at).toBeNull()
  })
})

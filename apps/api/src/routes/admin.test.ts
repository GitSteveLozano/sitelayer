import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { handleAdminRoutes, type AdminRouteDeps } from './admin.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const clerkAdmin: Identity = { userId: 'admin-sub', source: 'clerk' }
const ENV_IDS = new Set(['admin-sub'])

class FakePool {
  queries: string[] = []
  async query(text: string, _values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(text)
    if (/from companies c/i.test(text)) {
      return { rows: [{ id: COMPANY_ID, slug: 'acme', name: 'Acme', created_at: 't', member_count: 2 }] }
    }
    if (/from companies where id/i.test(text)) {
      return { rows: [{ id: COMPANY_ID, slug: 'acme', name: 'Acme', created_at: 't' }] }
    }
    if (/from company_memberships where company_id/i.test(text)) {
      return { rows: [{ clerk_user_id: 'u1', role: 'admin', created_at: 't' }] }
    }
    return { rows: [] }
  }
}

function capture() {
  const calls: Array<{ status: number; body: unknown }> = []
  const sendJson = (status: number, body: unknown) => calls.push({ status, body })
  return { calls, sendJson }
}

function get(path: string): { req: IncomingMessage; url: URL } {
  return { req: { method: 'GET' } as IncomingMessage, url: new URL(`http://x${path}`) }
}

function deps(over: Partial<AdminRouteDeps>): AdminRouteDeps {
  const { sendJson } = capture()
  return { pool: new FakePool(), identity: clerkAdmin, sendJson, envIds: ENV_IDS, ...over }
}

describe('handleAdminRoutes — namespace + gate', () => {
  it('ignores non-admin paths (returns false, no response)', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get('/api/projects')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson }))
    expect(handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-Clerk identity with 401', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get('/api/admin/companies')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson, identity: { userId: 'x', source: 'header' } }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(401)
  })

  it('rejects a Clerk non-superadmin with 403', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get('/api/admin/companies')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson, envIds: new Set() }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(403)
  })

  it('rejects mutations (non-GET) with 405', async () => {
    const { calls, sendJson } = capture()
    const url = new URL('http://x/api/admin/companies')
    const handled = await handleAdminRoutes({ method: 'POST' } as IncomingMessage, url, deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(405)
  })
})

describe('handleAdminRoutes — read-only endpoints (as superadmin)', () => {
  it('GET /api/admin/companies returns the cross-tenant list', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get('/api/admin/companies?limit=10&offset=5')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)
    expect(calls[0]?.body).toMatchObject({ limit: 10, offset: 5 })
    expect((calls[0]?.body as { companies: unknown[] }).companies).toHaveLength(1)
  })

  it('GET /api/admin/companies/:id returns the company + memberships', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get(`/api/admin/companies/${COMPANY_ID}`)
    const handled = await handleAdminRoutes(req, url, deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)
    expect(calls[0]?.body).toMatchObject({
      company: { id: COMPANY_ID, slug: 'acme' },
      memberships: [{ clerk_user_id: 'u1', role: 'admin' }],
    })
  })

  it('GET /api/admin/companies/:id 404s a malformed id without querying', async () => {
    const { calls, sendJson } = capture()
    const pool = new FakePool()
    const { req, url } = get('/api/admin/companies/not-a-uuid')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson, pool }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(404)
    // gate query may run, but no companies/memberships lookup for a bad id
    expect(pool.queries.some((q) => /from companies where id/i.test(q))).toBe(false)
  })

  it('unknown admin route 404s', async () => {
    const { calls, sendJson } = capture()
    const { req, url } = get('/api/admin/nope')
    const handled = await handleAdminRoutes(req, url, deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(404)
  })
})

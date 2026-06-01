import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { handleAdminRoutes, type AdminRouteDeps } from './admin.js'
import type { ActorTokenMinter } from '../clerk-actor-token.js'

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
    if (/insert into impersonation_sessions/i.test(text)) {
      return { rows: [{ id: 'sess-1', created_at: 't', expires_at: 't+600' }] }
    }
    if (/from impersonation_sessions/i.test(text)) {
      return {
        rows: [{ id: 'sess-1', actor_user_id: 'admin-sub', subject_user_id: 'u', reason: 'r', mode: 'read_only' }],
      }
    }
    return { rows: [] }
  }
}

function capture() {
  const calls: Array<{ status: number; body: unknown }> = []
  const sendJson = (status: number, body: unknown) => calls.push({ status, body })
  return { calls, sendJson }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage
}

function deps(over: Partial<AdminRouteDeps>): AdminRouteDeps {
  const { sendJson } = capture()
  return { pool: new FakePool(), identity: clerkAdmin, sendJson, envIds: ENV_IDS, ...over }
}

describe('handleAdminRoutes — namespace + gate', () => {
  it('ignores non-admin paths (returns false, no response)', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(req('GET'), new URL('http://x/api/projects'), deps({ sendJson }))
    expect(handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-Clerk identity with 401', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL('http://x/api/admin/companies'),
      deps({ sendJson, identity: { userId: 'x', source: 'header' } }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(401)
  })

  it('rejects a Clerk non-superadmin with 403', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL('http://x/api/admin/companies'),
      deps({ sendJson, envIds: new Set() }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(403)
  })

  it('rejects an unsupported method (non-GET, non-impersonate) with 405', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(req('POST'), new URL('http://x/api/admin/companies'), deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(405)
  })
})

describe('handleAdminRoutes — read-only endpoints (as superadmin)', () => {
  it('GET /api/admin/companies returns the cross-tenant list', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL('http://x/api/admin/companies?limit=10&offset=5'),
      deps({ sendJson }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)
    expect(calls[0]?.body).toMatchObject({ limit: 10, offset: 5 })
    expect((calls[0]?.body as { companies: unknown[] }).companies).toHaveLength(1)
  })

  it('GET /api/admin/companies/:id returns the company + memberships', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL(`http://x/api/admin/companies/${COMPANY_ID}`),
      deps({ sendJson }),
    )
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
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL('http://x/api/admin/companies/not-a-uuid'),
      deps({ sendJson, pool }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(404)
    expect(pool.queries.some((q) => /from companies where id/i.test(q))).toBe(false)
  })

  it('GET /api/admin/impersonation-sessions returns the ledger', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(
      req('GET'),
      new URL('http://x/api/admin/impersonation-sessions'),
      deps({ sendJson }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)
    expect((calls[0]?.body as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it('unknown admin route 404s', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminRoutes(req('GET'), new URL('http://x/api/admin/nope'), deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(404)
  })
})

describe('handleAdminRoutes — POST /api/admin/impersonate', () => {
  const url = () => new URL('http://x/api/admin/impersonate')

  it('mints an actor token + records a read-only session by default', async () => {
    const { calls, sendJson } = capture()
    const pool = new FakePool()
    const mintArgs: unknown[] = []
    const mintActorToken: ActorTokenMinter = async (a) => {
      mintArgs.push(a)
      return { token: 'ticket-tok' }
    }
    const readBody = async () => ({ user_id: 'user_x', reason: 'support ticket #42' })
    const handled = await handleAdminRoutes(req('POST'), url(), deps({ sendJson, pool, readBody, mintActorToken }))

    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(201)
    expect(calls[0]?.body).toMatchObject({
      subject_user_id: 'user_x',
      actor_user_id: 'admin-sub',
      mode: 'read_only',
      reason: 'support ticket #42',
      ticket: 'ticket-tok',
    })
    expect(mintArgs[0]).toMatchObject({ userId: 'user_x', actorSub: 'admin-sub' })
    expect(pool.queries.some((q) => /insert into impersonation_sessions/i.test(q))).toBe(true)
  })

  it('honors an explicit read_write opt-in', async () => {
    const { calls, sendJson } = capture()
    const mintActorToken: ActorTokenMinter = async () => ({ token: 't' })
    const readBody = async () => ({ user_id: 'u', reason: 'r', mode: 'read_write' })
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken }))
    expect(calls[0]?.body).toMatchObject({ mode: 'read_write' })
  })

  it('400s without a reason', async () => {
    const { calls, sendJson } = capture()
    const mintActorToken: ActorTokenMinter = async () => ({ token: 't' })
    const readBody = async () => ({ user_id: 'u' })
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken }))
    expect(calls[0]?.status).toBe(400)
  })

  it('400s without a user_id', async () => {
    const { calls, sendJson } = capture()
    const mintActorToken: ActorTokenMinter = async () => ({ token: 't' })
    const readBody = async () => ({ reason: 'r' })
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken }))
    expect(calls[0]?.status).toBe(400)
  })

  it('501s when no minter is configured', async () => {
    const { calls, sendJson } = capture()
    const readBody = async () => ({ user_id: 'u', reason: 'r' })
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken: null }))
    expect(calls[0]?.status).toBe(501)
  })

  it('502s when minting throws', async () => {
    const { calls, sendJson } = capture()
    const mintActorToken: ActorTokenMinter = async () => {
      throw new Error('clerk down')
    }
    const readBody = async () => ({ user_id: 'u', reason: 'r' })
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken }))
    expect(calls[0]?.status).toBe(502)
  })
})

describe('handleAdminRoutes — prod mutation gate (P5)', () => {
  const url = () => new URL('http://x/api/admin/impersonate')
  const mintActorToken: ActorTokenMinter = async () => ({ token: 't' })
  const readBody = async () => ({ user_id: 'u', reason: 'r' })

  it('blocks impersonation in prod without PLATFORM_ADMIN_PROD_ENABLED', async () => {
    const prev = process.env.PLATFORM_ADMIN_PROD_ENABLED
    delete process.env.PLATFORM_ADMIN_PROD_ENABLED
    try {
      const { calls, sendJson } = capture()
      await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken, tier: 'prod' }))
      expect(calls[0]?.status).toBe(403)
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_ADMIN_PROD_ENABLED
      else process.env.PLATFORM_ADMIN_PROD_ENABLED = prev
    }
  })

  it('allows impersonation in prod once PLATFORM_ADMIN_PROD_ENABLED=1', async () => {
    const prev = process.env.PLATFORM_ADMIN_PROD_ENABLED
    process.env.PLATFORM_ADMIN_PROD_ENABLED = '1'
    try {
      const { calls, sendJson } = capture()
      await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken, tier: 'prod' }))
      expect(calls[0]?.status).toBe(201)
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_ADMIN_PROD_ENABLED
      else process.env.PLATFORM_ADMIN_PROD_ENABLED = prev
    }
  })

  it('allows impersonation in non-prod tiers without the flag', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, mintActorToken, tier: 'preview' }))
    expect(calls[0]?.status).toBe(201)
  })
})

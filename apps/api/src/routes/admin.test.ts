import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { handleAdminRoutes, type AdminRouteDeps } from './admin.js'
import type { DemoLinkCapability } from './demo.js'
import type { ActorTokenMinter } from '../clerk-actor-token.js'
import type { ScenarioApplyRunner } from '../admin-scenarios.js'

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

describe('handleAdminRoutes — scenario console reads (P3)', () => {
  it('GET /api/admin/workflows returns the registry', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('GET'), new URL('http://x/api/admin/workflows'), deps({ sendJson }))
    expect(calls[0]?.status).toBe(200)
    expect((calls[0]?.body as { workflows: unknown[] }).workflows.length).toBeGreaterThan(0)
  })

  it('GET /api/admin/scenarios returns an array', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('GET'), new URL('http://x/api/admin/scenarios'), deps({ sendJson }))
    expect(calls[0]?.status).toBe(200)
    expect(Array.isArray((calls[0]?.body as { scenarios: unknown[] }).scenarios)).toBe(true)
  })

  it('GET /api/admin/scenarios/:slug/plan 404s an unknown slug', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('GET'), new URL('http://x/api/admin/scenarios/no-such-slug/plan'), deps({ sendJson }))
    expect(calls[0]?.status).toBe(404)
  })
})

describe('handleAdminRoutes — POST /api/admin/scenarios/:slug/apply (P3 mutation)', () => {
  const url = (slug = 'mid-flight-rental') => new URL(`http://x/api/admin/scenarios/${slug}/apply`)
  const runScenarioApply: ScenarioApplyRunner = async (a) => ({
    slug: a.slug,
    company_slug: a.target ?? 'acme-midflight',
    company_id: 'co-1',
    applied: true,
  })
  const readBody = async () => ({})

  it('applies a fixture and returns the result', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, runScenarioApply }))
    expect(calls[0]?.status).toBe(201)
    expect(calls[0]?.body).toMatchObject({ company_id: 'co-1', applied: true })
  })

  it('retargets the company via { target }', async () => {
    const seen: Array<{ slug: string; target?: string }> = []
    const runner: ScenarioApplyRunner = async (a) => {
      seen.push(a)
      return { slug: a.slug, company_slug: a.target ?? 'x', company_id: 'co-2', applied: true }
    }
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, readBody: async () => ({ target: 'demo-co-2' }), runScenarioApply: runner }),
    )
    expect(seen[0]).toMatchObject({ target: 'demo-co-2' })
    expect(calls[0]?.status).toBe(201)
  })

  it('400s an invalid target slug', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, readBody: async () => ({ target: 'Not A Slug' }), runScenarioApply }),
    )
    expect(calls[0]?.status).toBe(400)
  })

  it('404s an unknown fixture (runner returns null)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url('nope'), deps({ sendJson, readBody, runScenarioApply: async () => null }))
    expect(calls[0]?.status).toBe(404)
  })

  it('blocks apply in prod (scenarios are dev/demo only)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, runScenarioApply, tier: 'prod' }))
    expect(calls[0]?.status).toBe(403)
  })

  it('501s when no runner is wired', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody }))
    expect(calls[0]?.status).toBe(501)
  })
})

describe('handleAdminRoutes — POST /api/admin/scenarios/:slug/reset (§5A mutation)', () => {
  const url = (slug = 'mid-flight-rental') => new URL(`http://x/api/admin/scenarios/${slug}/reset`)
  const runScenarioApply: ScenarioApplyRunner = async (a) => ({
    slug: a.slug,
    company_slug: a.target ?? 'acme-midflight',
    company_id: 'co-1',
    applied: true,
  })
  const readBody = async () => ({})

  it('resets a fixture (idempotent reseed) and returns the result with reset:true', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, runScenarioApply }))
    expect(calls[0]?.status).toBe(200)
    expect(calls[0]?.body).toMatchObject({ company_id: 'co-1', applied: true, reset: true })
  })

  it('retargets the company via { target }', async () => {
    const seen: Array<{ slug: string; target?: string }> = []
    const runner: ScenarioApplyRunner = async (a) => {
      seen.push(a)
      return { slug: a.slug, company_slug: a.target ?? 'x', company_id: 'co-2', applied: true }
    }
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, readBody: async () => ({ target: 'demo-co-2' }), runScenarioApply: runner }),
    )
    expect(seen[0]).toMatchObject({ target: 'demo-co-2' })
    expect(calls[0]?.status).toBe(200)
  })

  it('400s an invalid target slug', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, readBody: async () => ({ target: 'Not A Slug' }), runScenarioApply }),
    )
    expect(calls[0]?.status).toBe(400)
  })

  it('404s an unknown fixture (runner returns null)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url('nope'), deps({ sendJson, readBody, runScenarioApply: async () => null }))
    expect(calls[0]?.status).toBe(404)
  })

  it('blocks reset in prod (scenarios are dev/demo only)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody, runScenarioApply, tier: 'prod' }))
    expect(calls[0]?.status).toBe(403)
  })

  it('501s when no runner is wired', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody }))
    expect(calls[0]?.status).toBe(501)
  })

  it('still enforces the superadmin gate (non-clerk identity → 401, never reseeds)', async () => {
    const { calls, sendJson } = capture()
    let ran = false
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({
        sendJson,
        identity: { userId: 'x', source: 'header' },
        readBody,
        runScenarioApply: async (a) => {
          ran = true
          return { slug: a.slug, company_slug: 'x', company_id: 'co', applied: true }
        },
      }),
    )
    expect(calls[0]?.status).toBe(401)
    expect(ran).toBe(false)
  })
})

describe('handleAdminRoutes — demo-link', () => {
  const url = () => new URL('http://x/api/admin/demo-link')
  const fakeDemoLink = (over: Partial<DemoLinkCapability> = {}): DemoLinkCapability => ({
    mintSignInToken: async () => ({ token: 'tkn_abc', userId: 'user_owner' }),
    appOrigin: 'https://demo.preview.sitelayer.sandolab.xyz',
    ttlSeconds: 86400,
    accessCode: 'stucco-demo',
    ...over,
  })

  it('409s when no demo-link capability (not the demo tier)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(req('POST'), url(), deps({ sendJson, readBody: async () => ({ role: 'owner' }) }))
    expect(calls[0]?.status).toBe(409)
  })

  it('mints a link + ready-to-send email for a valid role', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, demoLink: fakeDemoLink(), readBody: async () => ({ role: 'owner', name: 'Steve' }) }),
    )
    expect(calls[0]?.status).toBe(200)
    const body = calls[0]?.body as Record<string, unknown>
    expect(body.role).toBe('owner')
    expect(body.name).toBe('Steve')
    expect(String(body.link)).toContain('/sign-in?__clerk_ticket=tkn_abc')
    expect(body.expires_in_seconds).toBe(86400)
    expect(body.subject).toBe('Sitelayer demo link')
    expect(String(body.body)).toContain('Hi Steve,')
    expect(String(body.body)).toContain('Owner')
    const fallback = body.fallback as Record<string, unknown>
    expect(fallback.url).toBe('https://demo.preview.sitelayer.sandolab.xyz/demo')
    expect(fallback.access_code).toBe('stucco-demo')
  })

  it('400s an invalid role', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({ sendJson, demoLink: fakeDemoLink(), readBody: async () => ({ role: 'wizard' }) }),
    )
    expect(calls[0]?.status).toBe(400)
  })

  it('404s when the demo user is not seeded (minter returns null)', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({
        sendJson,
        demoLink: fakeDemoLink({ mintSignInToken: async () => null }),
        readBody: async () => ({ role: 'owner' }),
      }),
    )
    expect(calls[0]?.status).toBe(404)
  })

  it('502s when the minter throws', async () => {
    const { calls, sendJson } = capture()
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({
        sendJson,
        demoLink: fakeDemoLink({
          mintSignInToken: async () => {
            throw new Error('clerk down')
          },
        }),
        readBody: async () => ({ role: 'owner' }),
      }),
    )
    expect(calls[0]?.status).toBe(502)
  })

  it('still enforces the superadmin gate (non-clerk identity → 401, never mints)', async () => {
    const { calls, sendJson } = capture()
    let minted = false
    await handleAdminRoutes(
      req('POST'),
      url(),
      deps({
        sendJson,
        identity: { userId: 'x', source: 'header' },
        demoLink: fakeDemoLink({
          mintSignInToken: async () => {
            minted = true
            return { token: 't', userId: 'u' }
          },
        }),
        readBody: async () => ({ role: 'owner' }),
      }),
    )
    expect(calls[0]?.status).toBe(401)
    expect(minted).toBe(false)
  })
})

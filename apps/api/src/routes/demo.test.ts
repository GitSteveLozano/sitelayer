import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type { AppTier } from '@sitelayer/config'
import {
  buildTicketRedirectUrl,
  createClerkSignInTokenMinter,
  handleDemoRoutes,
  resolveDemoUserEmail,
  type ClerkSignInToken,
  type DemoRole,
  type SignInTokenMinter,
} from './demo.js'

type Captured = { status: number; body: unknown } | null

function makeCtx(opts: {
  tier: AppTier
  accessCode?: string | null
  body?: unknown
  minter?: SignInTokenMinter
  appOrigin?: string
}) {
  let captured: Captured = null
  let noIndexSet = false
  const ctx = {
    tier: opts.tier,
    accessCode: opts.accessCode ?? null,
    appOrigin: opts.appOrigin ?? 'https://demo.preview.sitelayer.sandolab.xyz',
    mintSignInToken:
      opts.minter ??
      (async (role: DemoRole): Promise<ClerkSignInToken | null> => ({ token: `tok-${role}`, userId: `user-${role}` })),
    sendJson: (status: number, body: unknown) => {
      captured = { status, body }
    },
    readBody: async () => opts.body ?? {},
    setNoIndexHeader: () => {
      noIndexSet = true
    },
  }
  return { ctx, get: () => captured, noIndex: () => noIndexSet }
}

const POST = { method: 'POST' } as unknown as http.IncomingMessage
const GET = { method: 'GET' } as unknown as http.IncomingMessage

function signInUrl(tier: AppTier = 'demo') {
  return new URL('https://api/api/demo/sign-in-link')
}

describe('handleDemoRoutes tier gate', () => {
  it('is structurally inert on non-demo tiers (returns false, no response)', async () => {
    for (const tier of ['local', 'dev', 'preview', 'prod'] as AppTier[]) {
      const { ctx, get } = makeCtx({ tier, accessCode: 'open-sesame', body: { role: 'owner', accessCode: 'open-sesame' } })
      const handled = await handleDemoRoutes(POST, signInUrl(), ctx)
      expect(handled, `tier ${tier} should not handle`).toBe(false)
      expect(get(), `tier ${tier} should not respond`).toBeNull()
    }
  })

  it('does not claim non-demo paths even on the demo tier', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: 'x' })
    const handled = await handleDemoRoutes(POST, new URL('https://api/api/projects'), ctx)
    expect(handled).toBe(false)
    expect(get()).toBeNull()
  })

  it('404s an unknown /api/demo/* path on the demo tier', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: 'x' })
    const handled = await handleDemoRoutes(GET, new URL('https://api/api/demo/whatever'), ctx)
    expect(handled).toBe(true)
    expect(get()).toEqual({ status: 404, body: { error: 'not found' } })
  })
})

describe('POST /api/demo/sign-in-link', () => {
  it('503s when DEMO_ACCESS_CODE is unset', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: null, body: { role: 'owner', accessCode: 'x' } })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(503)
  })

  it('401s on a wrong access code', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: 'right', body: { role: 'owner', accessCode: 'wrong' } })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect(get()).toEqual({ status: 401, body: { error: 'invalid access code' } })
  })

  it('401s on a missing access code', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: 'right', body: { role: 'owner' } })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(401)
  })

  it('400s on an invalid role', async () => {
    const { ctx, get } = makeCtx({ tier: 'demo', accessCode: 'right', body: { role: 'admin', accessCode: 'right' } })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(400)
  })

  it('mints a ticket redirect for a valid role + access code', async () => {
    const minter = vi.fn(async (role: DemoRole) => ({ token: `tok-${role}`, userId: `u-${role}` }))
    const { ctx, get, noIndex } = makeCtx({
      tier: 'demo',
      accessCode: 'right',
      body: { role: 'estimator', accessCode: 'right' },
      minter,
    })
    const handled = await handleDemoRoutes(POST, signInUrl(), ctx)
    expect(handled).toBe(true)
    expect(noIndex()).toBe(true)
    expect(minter).toHaveBeenCalledWith('estimator')
    expect(get()).toEqual({
      status: 200,
      body: {
        role: 'estimator',
        redirect_url: 'https://demo.preview.sitelayer.sandolab.xyz/sign-in?__clerk_ticket=tok-estimator',
      },
    })
  })

  it('404s with a clear message when the demo user is not seeded', async () => {
    const { ctx, get } = makeCtx({
      tier: 'demo',
      accessCode: 'right',
      body: { role: 'foreman', accessCode: 'right' },
      minter: async () => null,
    })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    const out = get() as { status: number; body: { error: string } }
    expect(out.status).toBe(404)
    expect(out.body.error).toMatch(/not seeded/)
  })

  it('502s when the minter throws (Clerk API failure)', async () => {
    const { ctx, get } = makeCtx({
      tier: 'demo',
      accessCode: 'right',
      body: { role: 'crew', accessCode: 'right' },
      minter: async () => {
        throw new Error('clerk down')
      },
    })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(502)
  })
})

describe('resolveDemoUserEmail', () => {
  it('falls back to demo-<role>@<default-domain>', () => {
    expect(resolveDemoUserEmail('owner', {} as NodeJS.ProcessEnv)).toBe('demo-owner@demo.sitelayer.sandolab.xyz')
  })
  it('honours a per-role override', () => {
    expect(resolveDemoUserEmail('crew', { DEMO_USER_EMAIL_CREW: 'real@x.com' } as unknown as NodeJS.ProcessEnv)).toBe(
      'real@x.com',
    )
  })
  it('honours a domain override', () => {
    expect(
      resolveDemoUserEmail('foreman', { DEMO_USER_EMAIL_DOMAIN: 'demo.example.com' } as unknown as NodeJS.ProcessEnv),
    ).toBe('demo-foreman@demo.example.com')
  })
})

describe('buildTicketRedirectUrl', () => {
  it('appends the ticket and trims a trailing slash', () => {
    expect(buildTicketRedirectUrl('https://demo.example.com/', 'abc def')).toBe(
      'https://demo.example.com/sign-in?__clerk_ticket=abc%20def',
    )
  })
})

describe('createClerkSignInTokenMinter', () => {
  it('looks up the user by email then mints a sign-in token', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      calls.push(u)
      if (u.includes('/users')) {
        expect(u).toContain(encodeURIComponent('demo-owner@demo.sitelayer.sandolab.xyz'))
        return new Response(JSON.stringify([{ id: 'user_123' }]), { status: 200 })
      }
      if (u.endsWith('/sign_in_tokens')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({ user_id: 'user_123' })
        return new Response(JSON.stringify({ token: 'st_abc' }), { status: 200 })
      }
      throw new Error(`unexpected url ${u}`)
    }) as unknown as typeof fetch
    const minter = createClerkSignInTokenMinter({ secretKey: 'sk_test_x', env: {} as NodeJS.ProcessEnv, fetchImpl })
    const result = await minter('owner')
    expect(result).toEqual({ token: 'st_abc', userId: 'user_123' })
    expect(calls).toHaveLength(2)
  })

  it('returns null when the seeded user is not found', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch
    const minter = createClerkSignInTokenMinter({ secretKey: 'sk_test_x', env: {} as NodeJS.ProcessEnv, fetchImpl })
    expect(await minter('estimator')).toBeNull()
  })

  it('throws when the lookup call fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const minter = createClerkSignInTokenMinter({ secretKey: 'sk_test_x', env: {} as NodeJS.ProcessEnv, fetchImpl })
    await expect(minter('crew')).rejects.toThrow(/lookup failed/)
  })
})

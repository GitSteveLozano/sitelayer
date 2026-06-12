/**
 * Prod-safety invariants for the demo tier (C5).
 *
 * This file is the explicit, durable contract that the demo surface cannot
 * activate anywhere but the demo tier. It deliberately exercises the same
 * primitives the rest of the build relies on (`handleDemoRoutes`,
 * `resolveActAsOverride`, `loadAuthConfig`) but frames each assertion as a
 * prod-safety guarantee so a regression that re-enables a demo path off the
 * demo tier fails a clearly-named test.
 *
 * Guarantees proved here:
 *   1. /api/demo/* is INERT (returns false → 404, never responds) on every
 *      non-demo tier, including when a valid-looking demo body is supplied —
 *      so hitting the prod or dev URL with a demo magic-link does nothing.
 *   2. The access-code gate rejects wrong and blank codes (401) and refuses to
 *      mint anything when DEMO_ACCESS_CODE is unset (503), even on the demo
 *      tier.
 *   3. The dev `x-sitelayer-act-as` bypass remains impossible in prod (ignored
 *      + warned), independent of the demo route.
 *   4. Prod auth config refuses to boot with header fallback (the second,
 *      independent gate the act-as bypass depends on).
 */
import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AppTier } from '@sitelayer/config'
import { AuthConfigError, loadAuthConfig, resolveActAsOverride } from '../auth.js'
import { handleDemoRoutes, type ClerkSignInToken, type DemoRole, type SignInTokenMinter } from './demo.js'

const POST = { method: 'POST' } as unknown as http.IncomingMessage
const NON_DEMO_TIERS: AppTier[] = ['local', 'dev', 'preview', 'prod']

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

type Captured = { status: number; body: unknown } | null

function makeCtx(opts: { tier: AppTier; accessCode?: string | null; body?: unknown; minter?: SignInTokenMinter }) {
  let captured: Captured = null
  let mintCalls = 0
  const minter: SignInTokenMinter =
    opts.minter ??
    (async (role: DemoRole): Promise<ClerkSignInToken | null> => {
      mintCalls += 1
      return { token: `tok-${role}`, userId: `user-${role}` }
    })
  const ctx = {
    tier: opts.tier,
    accessCode: opts.accessCode ?? null,
    appOrigin: 'https://demo.preview.sitelayer.sandolab.xyz',
    ticketTtlSeconds: 86400,
    mintSignInToken: minter,
    sendJson: (status: number, body: unknown) => {
      captured = { status, body }
    },
    readBody: async () => opts.body ?? {},
    setNoIndexHeader: () => {},
  }
  return { ctx, get: () => captured, mintCalls: () => mintCalls }
}

const signInUrl = () => new URL('https://api/api/demo/sign-in-link')

describe('C5 prod-safety: /api/demo/* is inert off the demo tier', () => {
  it('returns false and never responds on prod/dev/preview/local — even with a valid demo body', async () => {
    for (const tier of NON_DEMO_TIERS) {
      const { ctx, get, mintCalls } = makeCtx({
        tier,
        // A complete, otherwise-valid demo magic-link request. The point is
        // that a leaked/forwarded demo link hitting the prod or dev URL does
        // absolutely nothing — no token minted, no response written.
        accessCode: 'open-sesame',
        body: { role: 'owner', accessCode: 'open-sesame' },
      })
      const handled = await handleDemoRoutes(POST, signInUrl(), ctx)
      expect(handled, `tier ${tier} must not handle the demo route`).toBe(false)
      expect(get(), `tier ${tier} must not write a response`).toBeNull()
      expect(mintCalls(), `tier ${tier} must not mint a sign-in token`).toBe(0)
    }
  })
})

describe('C5 prod-safety: access-code gate', () => {
  it('503s and mints nothing when DEMO_ACCESS_CODE is unset (demo tier)', async () => {
    const { ctx, get, mintCalls } = makeCtx({
      tier: 'demo',
      accessCode: null,
      body: { role: 'owner', accessCode: 'anything' },
    })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(503)
    expect(mintCalls()).toBe(0)
  })

  it('401s and mints nothing on a wrong access code', async () => {
    const { ctx, get, mintCalls } = makeCtx({
      tier: 'demo',
      accessCode: 'correct-horse',
      body: { role: 'owner', accessCode: 'wrong' },
    })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect(get()).toEqual({ status: 401, body: { error: 'invalid access code' } })
    expect(mintCalls()).toBe(0)
  })

  it('401s and mints nothing on a blank/missing access code', async () => {
    for (const code of ['', '   ', undefined]) {
      const body = code === undefined ? { role: 'owner' } : { role: 'owner', accessCode: code }
      const { ctx, get, mintCalls } = makeCtx({ tier: 'demo', accessCode: 'correct-horse', body })
      await handleDemoRoutes(POST, signInUrl(), ctx)
      expect((get() as { status: number }).status, `code ${JSON.stringify(code)}`).toBe(401)
      expect(mintCalls(), `code ${JSON.stringify(code)}`).toBe(0)
    }
  })

  it('only mints once the access code matches exactly (demo tier)', async () => {
    const { ctx, get, mintCalls } = makeCtx({
      tier: 'demo',
      accessCode: 'correct-horse',
      body: { role: 'estimator', accessCode: 'correct-horse' },
    })
    await handleDemoRoutes(POST, signInUrl(), ctx)
    expect((get() as { status: number }).status).toBe(200)
    expect(mintCalls()).toBe(1)
  })
})

describe('C5 prod-safety: act-as bypass impossible in prod', () => {
  it('ignores x-sitelayer-act-as in prod and warns', () => {
    const warn = vi.fn()
    const req = fakeReq({ 'x-sitelayer-act-as': 'e2e-admin' })
    expect(resolveActAsOverride(req, 'prod', warn)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('still honours act-as on demo/dev/preview/local (RoleSwitcher QA path)', () => {
    const req = fakeReq({ 'x-sitelayer-act-as': 'e2e-foreman' })
    for (const tier of ['demo', 'dev', 'preview', 'local']) {
      expect(resolveActAsOverride(req, tier), `tier ${tier}`).toBe('e2e-foreman')
    }
  })

  it('prod refuses to boot with header fallback unless break-glass is explicit', () => {
    const clerkKey = '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----'
    // Header fallback in prod without the break-glass flag → refuse to boot.
    expect(() =>
      loadAuthConfig({ APP_TIER: 'prod', CLERK_JWT_KEY: clerkKey, AUTH_ALLOW_HEADER_FALLBACK: '1' }),
    ).toThrow(AuthConfigError)
    // Prod with Clerk configured and no header fallback → boots, fallback off.
    // (CLERK_ISSUER is mandatory in prod since the 2026-06-12 JWT hardening.)
    const ok = loadAuthConfig({
      APP_TIER: 'prod',
      CLERK_JWT_KEY: clerkKey,
      CLERK_ISSUER: 'https://clerk.sandolab.xyz',
      AUTH_ALLOW_HEADER_FALLBACK: '0',
    })
    expect(ok.allowHeaderFallback).toBe(false)
  })

  it('prod refuses to boot without any configured auth provider', () => {
    expect(() => loadAuthConfig({ APP_TIER: 'prod' })).toThrow(AuthConfigError)
  })
})

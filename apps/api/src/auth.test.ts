import type { IncomingMessage } from 'node:http'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AuthConfigError, AuthError, loadAuthConfig, resolveActAsOverride, resolveIdentity } from './auth.js'

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

// --- RS256 JWT signing helpers for verifyClerkJwt (via resolveIdentity) ---
function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const { publicKey: CLERK_PUBLIC_KEY, privateKey: CLERK_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  signer.end()
  const sig = signer
    .sign(CLERK_PRIVATE_KEY)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${header}.${body}.${sig}`
}

function clerkReq(payload: Record<string, unknown>): IncomingMessage {
  return fakeReq({ authorization: `Bearer ${signJwt(payload)}` })
}

const clerkConfig = loadAuthConfig({
  APP_TIER: 'preview',
  CLERK_JWT_KEY: CLERK_PUBLIC_KEY,
  AUTH_ALLOW_HEADER_FALLBACK: '0',
})

describe('loadAuthConfig', () => {
  it('allows local header fallback when auth is not configured', () => {
    const config = loadAuthConfig({ APP_TIER: 'local' })
    expect(config.allowHeaderFallback).toBe(true)
  })

  it('refuses to start prod without a configured auth provider', () => {
    expect(() => loadAuthConfig({ APP_TIER: 'prod' })).toThrow(AuthConfigError)
  })

  it('refuses prod header fallback unless the break-glass flag is explicit', () => {
    expect(() =>
      loadAuthConfig({
        APP_TIER: 'prod',
        CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
        AUTH_ALLOW_HEADER_FALLBACK: '1',
      }),
    ).toThrow(AuthConfigError)
  })

  it('allows explicit prod auth without header fallback', () => {
    const config = loadAuthConfig({
      APP_TIER: 'prod',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      AUTH_ALLOW_HEADER_FALLBACK: '0',
    })
    expect(config.allowHeaderFallback).toBe(false)
  })

  // --- Fail-closed default once an auth provider is configured (sec fix) ---
  // Regression guard for the public dev copy: a dev/preview tier WITH a real
  // Clerk key must default the header fallback OFF, so it demands a real (even
  // shared) Clerk session instead of accepting x-sitelayer-user-id / the
  // ACTIVE_USER_ID default user. Previously the unset default was
  // `!authConfigured || tier !== 'prod'`, which left it ON for these tiers.
  it('defaults header fallback OFF on dev when a Clerk key is configured', () => {
    const config = loadAuthConfig({
      APP_TIER: 'dev',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
    })
    expect(config.allowHeaderFallback).toBe(false)
  })

  it('defaults header fallback OFF on preview/demo when a Clerk key is configured', () => {
    for (const tier of ['preview', 'demo']) {
      const config = loadAuthConfig({
        APP_TIER: tier,
        CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      })
      expect(config.allowHeaderFallback, `tier ${tier}`).toBe(false)
    }
  })

  it('defaults header fallback OFF on dev when only an internal auth token is configured', () => {
    const config = loadAuthConfig({ APP_TIER: 'dev', INTERNAL_AUTH_TOKEN: 'svc-token' })
    expect(config.allowHeaderFallback).toBe(false)
  })

  it('keeps header fallback ON on a key-less dev box (RoleSwitcher QA path unchanged)', () => {
    // No CLERK_JWT_KEY / INTERNAL_AUTH_TOKEN ⇒ no real auth to enforce, so the
    // local/dev convenience fallback stays on. This is the case the operator
    // env step closes on the live droplet (wire a shared key + set =0, or
    // front with Cloudflare Access / IP-allowlist).
    expect(loadAuthConfig({ APP_TIER: 'dev' }).allowHeaderFallback).toBe(true)
    expect(loadAuthConfig({ APP_TIER: 'local' }).allowHeaderFallback).toBe(true)
  })

  it('honours an explicit AUTH_ALLOW_HEADER_FALLBACK=1 on dev (deliberate opt-in still works)', () => {
    const config = loadAuthConfig({
      APP_TIER: 'dev',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      AUTH_ALLOW_HEADER_FALLBACK: '1',
    })
    expect(config.allowHeaderFallback).toBe(true)
  })

  it('honours an explicit AUTH_ALLOW_HEADER_FALLBACK=0 on a key-less dev box', () => {
    const config = loadAuthConfig({ APP_TIER: 'dev', AUTH_ALLOW_HEADER_FALLBACK: '0' })
    expect(config.allowHeaderFallback).toBe(false)
  })
})

describe('resolveActAsOverride', () => {
  it('returns the act-as user when the header is set in non-prod', () => {
    const req = fakeReq({ 'x-sitelayer-act-as': 'e2e-foreman' })
    const warn = vi.fn()
    expect(resolveActAsOverride(req, 'local', warn)).toBe('e2e-foreman')
    expect(resolveActAsOverride(req, 'preview', warn)).toBe('e2e-foreman')
    expect(resolveActAsOverride(req, 'dev', warn)).toBe('e2e-foreman')
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns null when the act-as header is absent (existing fallback behavior unchanged)', () => {
    const req = fakeReq({ 'x-sitelayer-user-id': 'demo-user' })
    const warn = vi.fn()
    expect(resolveActAsOverride(req, 'local', warn)).toBeNull()
    expect(resolveActAsOverride(req, 'prod', warn)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores the header in prod and logs a warning', () => {
    const req = fakeReq({ 'x-sitelayer-act-as': 'e2e-admin' })
    const warn = vi.fn()
    expect(resolveActAsOverride(req, 'prod', warn)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const [msg, ctx] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(msg).toMatch(/x-sitelayer-act-as/)
    expect(ctx).toMatchObject({ tier: 'prod', header_value: 'e2e-admin' })
  })

  it('trims surrounding whitespace', () => {
    const req = fakeReq({ 'x-sitelayer-act-as': '  e2e-office  ' })
    expect(resolveActAsOverride(req, 'local')).toBe('e2e-office')
  })

  it('handles missing request gracefully', () => {
    expect(resolveActAsOverride(undefined, 'local')).toBeNull()
  })
})

describe('resolveIdentity — Clerk JWT + impersonation act claim', () => {
  it('resolves a normal session to the subject with no actor', () => {
    const identity = resolveIdentity(clerkReq({ sub: 'user_subject' }), clerkConfig)
    expect(identity).toEqual({ userId: 'user_subject', source: 'clerk' })
    expect(identity.actorUserId).toBeUndefined()
    expect(identity.mode).toBeUndefined()
  })

  it('reads a Clerk actor-token `act: { sub }` claim as impersonation', () => {
    const identity = resolveIdentity(clerkReq({ sub: 'user_subject', act: { sub: 'user_admin' } }), clerkConfig)
    // Data scoping stays on the subject; the actor is the real admin.
    expect(identity.userId).toBe('user_subject')
    expect(identity.source).toBe('clerk')
    expect(identity.actorUserId).toBe('user_admin')
    expect(identity.mode).toBe('impersonate')
  })

  it('accepts a bare-string `act` claim', () => {
    const identity = resolveIdentity(clerkReq({ sub: 'user_subject', act: 'user_admin' }), clerkConfig)
    expect(identity.actorUserId).toBe('user_admin')
    expect(identity.mode).toBe('impersonate')
  })

  it('ignores a malformed `act` claim (no sub) and stays self-auth', () => {
    const identity = resolveIdentity(clerkReq({ sub: 'user_subject', act: { foo: 'bar' } }), clerkConfig)
    expect(identity).toEqual({ userId: 'user_subject', source: 'clerk' })
  })

  // --- Malformed-credential → 401, NOT 500 (regression guard) ---
  // A bearer with three dot-separated segments LOOKS like a JWT but whose
  // base64/JSON is garbage previously tripped an unguarded JSON.parse in
  // decodeJwtSegment: the SyntaxError escaped the AuthError catch in server.ts
  // and surfaced as a 500. It must REJECT as a 401 'malformed token' instead —
  // it never bypasses auth, it just reports the right status.
  function expectMalformed401(token: string) {
    let thrown: unknown
    try {
      resolveIdentity(fakeReq({ authorization: `Bearer ${token}` }), clerkConfig)
    } catch (err) {
      thrown = err
    }
    expect(thrown, `token ${token} must throw`).toBeInstanceOf(AuthError)
    expect((thrown as AuthError).status, `token ${token} status`).toBe(401)
    expect((thrown as AuthError).message).toBe('malformed token')
  }

  it('rejects a 3-segment bearer whose header segment is not valid base64-JSON as 401', () => {
    // `@@@` decodes to bytes that are not parseable JSON → SyntaxError path.
    expectMalformed401('@@@.@@@.@@@')
  })

  it('rejects a 3-segment bearer with non-JSON ascii segments as 401', () => {
    // `notbase64json` base64-decodes to bytes that JSON.parse cannot parse.
    expectMalformed401('notbase64json.notbase64json.sig')
  })

  it('rejects a 3-segment bearer whose header decodes to a non-object (bare value) as 401', () => {
    // A segment that successfully JSON.parses to a bare number is still unusable
    // as a JWT header — the explicit non-object guard turns it into a 401, not a
    // later crash on `header.alg` of a primitive.
    const bareNumberHeader = b64url('42')
    expectMalformed401(`${bareNumberHeader}.${b64url('{}')}.sig`)
  })

  it('rejects a valid-RS256-header but garbage-payload bearer as 401 (not 500)', () => {
    // Header parses fine (alg RS256) but the payload segment is junk JSON. This
    // reaches decodeJwtSegment for the payload only AFTER signature verify; here
    // the signature is wrong so it 401s at the signature step — but the point of
    // the guard is that NO segment decode can produce a 500.
    const goodHeader = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    let thrown: unknown
    try {
      resolveIdentity(fakeReq({ authorization: `Bearer ${goodHeader}.@@@.sig` }), clerkConfig)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AuthError)
    expect((thrown as AuthError).status).toBe(401)
  })
})

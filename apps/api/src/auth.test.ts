import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AuthConfigError, loadAuthConfig, resolveActAsOverride } from './auth.js'

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

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

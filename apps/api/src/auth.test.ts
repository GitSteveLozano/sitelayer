import { describe, expect, it } from 'vitest'
import { AuthConfigError, loadAuthConfig } from './auth.js'

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

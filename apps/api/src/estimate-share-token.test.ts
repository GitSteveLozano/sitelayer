import { describe, expect, it } from 'vitest'
import {
  generateShareToken,
  resolveShareSecret,
  resolveShareSecretConfig,
  verifyShareToken,
} from './estimate-share-token.js'

describe('generateShareToken / verifyShareToken', () => {
  it('round-trips: a freshly-generated token verifies under the same secret', () => {
    const secret = 'estimate-share-secret-abc'
    const { id, token } = generateShareToken(secret)
    expect(typeof id).toBe('string')
    expect(token).toContain('.')
    expect(token.length).toBeGreaterThanOrEqual(32)

    const result = verifyShareToken(token, secret)
    expect(result).toEqual({ ok: true, id })
  })

  it('produces distinct tokens on repeated calls (random id per call)', () => {
    const secret = 'estimate-share-secret-abc'
    const a = generateShareToken(secret)
    const b = generateShareToken(secret)
    expect(a.token).not.toBe(b.token)
    expect(a.id).not.toBe(b.id)
  })

  it('rejects a token signed under a different secret', () => {
    const a = generateShareToken('secret-a')
    expect(verifyShareToken(a.token, 'secret-b')).toEqual({ ok: false })
  })

  it('rejects a tampered random id (signature no longer matches)', () => {
    const secret = 'estimate-share-secret-abc'
    const { token } = generateShareToken(secret)
    const [id, sig] = token.split('.')
    const tampered = `${id!.slice(0, -1)}X.${sig}`
    expect(verifyShareToken(tampered, secret)).toEqual({ ok: false })
  })

  it('rejects a tampered signature', () => {
    const secret = 'estimate-share-secret-abc'
    const { token } = generateShareToken(secret)
    const [id, sig] = token.split('.')
    const tampered = `${id}.${sig!.slice(0, -1)}X`
    expect(verifyShareToken(tampered, secret)).toEqual({ ok: false })
  })

  it('rejects malformed tokens', () => {
    const secret = 'estimate-share-secret-abc'
    expect(verifyShareToken('', secret)).toEqual({ ok: false })
    expect(verifyShareToken('no-dot', secret)).toEqual({ ok: false })
    expect(verifyShareToken('.no-id', secret)).toEqual({ ok: false })
    expect(verifyShareToken('no-sig.', secret)).toEqual({ ok: false })
    expect(verifyShareToken('id with spaces.sig', secret)).toEqual({ ok: false })
    expect(verifyShareToken('id.sig with spaces', secret)).toEqual({ ok: false })
  })

  it('rejects when the secret is empty/null/undefined', () => {
    const { token } = generateShareToken('s')
    expect(verifyShareToken(token, '')).toEqual({ ok: false })
    expect(verifyShareToken(token, undefined as unknown as string)).toEqual({ ok: false })
  })
})

describe('resolveShareSecret', () => {
  it('prefers ESTIMATE_SHARE_SECRET when set', () => {
    expect(resolveShareSecret({ ESTIMATE_SHARE_SECRET: 'a', QBO_STATE_SECRET: 'b' })).toBe('a')
  })

  it('falls back to QBO_STATE_SECRET when ESTIMATE_SHARE_SECRET is unset', () => {
    expect(resolveShareSecret({ QBO_STATE_SECRET: 'b' })).toBe('b')
  })

  it('returns null when neither is set', () => {
    expect(resolveShareSecret({})).toBeNull()
  })

  it('treats whitespace-only values as unset', () => {
    expect(resolveShareSecret({ ESTIMATE_SHARE_SECRET: '   ' })).toBeNull()
  })
})

describe('resolveShareSecretConfig', () => {
  it('prefers ESTIMATE_SHARE_SECRET in prod', () => {
    expect(resolveShareSecretConfig({ tier: 'prod', env: { ESTIMATE_SHARE_SECRET: 'a' } })).toEqual({
      ok: true,
      secret: 'a',
      source: 'estimate',
    })
  })

  it('accepts QBO fallback in non-prod when ESTIMATE_SHARE_SECRET is missing', () => {
    expect(resolveShareSecretConfig({ tier: 'dev', env: { QBO_STATE_SECRET: 'b' } })).toEqual({
      ok: true,
      secret: 'b',
      source: 'qbo-fallback',
    })
  })

  it('refuses prod when no secret is configured', () => {
    expect(resolveShareSecretConfig({ tier: 'prod', env: {} })).toEqual({ ok: false, reason: 'missing' })
  })

  it('returns missing in non-prod when neither secret is set (caller decides)', () => {
    expect(resolveShareSecretConfig({ tier: 'local', env: {} })).toEqual({ ok: false, reason: 'missing' })
  })
})

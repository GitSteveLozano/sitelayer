import { describe, expect, it } from 'vitest'
import {
  EMAIL_PATTERN,
  buildInviteUrl,
  generateInviteToken,
  inviteAcceptBaseUrl,
  isInviteRole,
  normalizeEmail,
  tokensEqual,
} from './invites.js'

describe('generateInviteToken', () => {
  it('mints a base64url token of at least 43 chars (256 bits)', () => {
    const token = generateInviteToken()
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is distinct across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i += 1) seen.add(generateInviteToken())
    expect(seen.size).toBe(100)
  })
})

describe('tokensEqual', () => {
  it('is true for identical strings', () => {
    expect(tokensEqual('abc123', 'abc123')).toBe(true)
  })
  it('is false for differing strings of equal length', () => {
    expect(tokensEqual('abc123', 'abc124')).toBe(false)
  })
  it('is false for length mismatch (no throw)', () => {
    expect(tokensEqual('abc', 'abcdef')).toBe(false)
  })
})

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com')
  })
})

describe('EMAIL_PATTERN', () => {
  it('accepts a plausible address', () => {
    expect(EMAIL_PATTERN.test('a@b.co')).toBe(true)
  })
  it('rejects missing domain / spaces', () => {
    expect(EMAIL_PATTERN.test('nope')).toBe(false)
    expect(EMAIL_PATTERN.test('a b@c.co')).toBe(false)
    expect(EMAIL_PATTERN.test('a@bco')).toBe(false)
  })
})

describe('isInviteRole', () => {
  it('accepts the five canonical roles', () => {
    for (const r of ['admin', 'foreman', 'office', 'member', 'bookkeeper']) {
      expect(isInviteRole(r)).toBe(true)
    }
  })
  it('rejects unknowns and non-strings', () => {
    expect(isInviteRole('owner')).toBe(false)
    expect(isInviteRole(42)).toBe(false)
    expect(isInviteRole(null)).toBe(false)
  })
})

describe('buildInviteUrl', () => {
  it('encodes the token and strips a trailing slash off the base', () => {
    expect(buildInviteUrl('https://x.test/', 'tok+en/with')).toBe('https://x.test/invite/accept/tok%2Ben%2Fwith')
  })
  it('uses the path /invite/accept/:token', () => {
    expect(buildInviteUrl('https://x.test', 'abc')).toBe('https://x.test/invite/accept/abc')
  })
})

describe('inviteAcceptBaseUrl', () => {
  it('reads APP_PUBLIC_BASE_URL and strips trailing slash', () => {
    expect(inviteAcceptBaseUrl({ APP_PUBLIC_BASE_URL: 'https://app.test/' } as NodeJS.ProcessEnv)).toBe(
      'https://app.test',
    )
  })
  it('falls back to the prod base when unset', () => {
    expect(inviteAcceptBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://sitelayer.sandolab.xyz')
  })
})

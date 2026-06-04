import { describe, expect, it } from 'vitest'
import {
  feedbackInviteSecretMap,
  generateFeedbackInviteToken,
  verifyFeedbackInviteToken,
} from './feedback-invite-token.js'

describe('feedback invite tokens', () => {
  it('generates and verifies purpose-bound signed tokens', () => {
    const token = generateFeedbackInviteToken('secret-a', 'kid-a')

    expect(token.token).toMatch(/^fbiv1\.kid-a\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyFeedbackInviteToken(token.token, { 'kid-a': 'secret-a' })).toEqual({
      ok: true,
      id: token.id,
      kid: 'kid-a',
    })
  })

  it('rejects tampered, malformed, and wrong-key tokens', () => {
    const token = generateFeedbackInviteToken('secret-a', 'kid-a')
    const tampered = token.token.replace(/.$/, (char) => (char === 'a' ? 'b' : 'a'))

    expect(verifyFeedbackInviteToken(tampered, { 'kid-a': 'secret-a' })).toEqual({ ok: false })
    expect(verifyFeedbackInviteToken(token.token, { 'kid-a': 'secret-b' })).toEqual({ ok: false })
    expect(verifyFeedbackInviteToken(token.token, { 'kid-b': 'secret-a' })).toEqual({ ok: false })
    expect(verifyFeedbackInviteToken('not-a-feedback-token', { 'kid-a': 'secret-a' })).toEqual({ ok: false })
  })

  it('returns an empty verifier map when no secret is configured', () => {
    expect(feedbackInviteSecretMap(null)).toEqual({})
    expect(feedbackInviteSecretMap('  ')).toEqual({})
    expect(feedbackInviteSecretMap('secret')).toEqual({ default: 'secret' })
  })
})

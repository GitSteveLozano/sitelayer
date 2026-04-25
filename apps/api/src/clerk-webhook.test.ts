import { describe, expect, it } from 'vitest'
import { Webhook } from 'svix'
import { extractSvixHeaders, verifyClerkWebhook } from './clerk-webhook.js'

// Svix only accepts secrets that look like base64 (no `whsec_` prefix in the raw form).
// This is a fixed test secret; do NOT reuse outside tests.
const TEST_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

function signPayload(secret: string, body: string) {
  const wh = new Webhook(secret)
  const id = `msg_${Math.random().toString(16).slice(2)}`
  const timestamp = new Date()
  const signature = wh.sign(id, timestamp, body)
  return {
    'svix-id': id,
    'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
    'svix-signature': signature,
  }
}

describe('clerk-webhook verifyClerkWebhook', () => {
  it('returns ok for a properly signed Clerk user.created payload', () => {
    const body = JSON.stringify({
      type: 'user.created',
      object: 'event',
      data: { id: 'user_test123', email_addresses: [{ email_address: 'a@b.com' }] },
    })
    const headers = signPayload(TEST_SECRET, body)
    const result = verifyClerkWebhook(body, extractSvixHeaders(headers), TEST_SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.type).toBe('user.created')
      expect((result.event.data as { id: string }).id).toBe('user_test123')
    }
  })

  it('returns 401 when signature is invalid', () => {
    const body = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } })
    const headers = signPayload(TEST_SECRET, body)
    // Tamper with body after signing
    const tamperedBody = body.replace('user_x', 'user_evil')
    const result = verifyClerkWebhook(tamperedBody, extractSvixHeaders(headers), TEST_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
    }
  })

  it('returns 400 when svix headers are missing', () => {
    const body = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } })
    const result = verifyClerkWebhook(body, extractSvixHeaders({}), TEST_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/svix-id/)
    }
  })

  it('returns 401 when verifying with the wrong secret', () => {
    const body = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } })
    const headers = signPayload(TEST_SECRET, body)
    const result = verifyClerkWebhook(body, extractSvixHeaders(headers), 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
    }
  })

  it('extractSvixHeaders normalizes array values to first element', () => {
    const headers = extractSvixHeaders({
      'svix-id': ['msg_a', 'msg_b'],
      'svix-timestamp': '1700000000',
      'svix-signature': 'v1,signature',
    })
    expect(headers.svixId).toBe('msg_a')
    expect(headers.svixTimestamp).toBe('1700000000')
    expect(headers.svixSignature).toBe('v1,signature')
  })
})

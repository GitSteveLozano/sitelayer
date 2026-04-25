import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  extractIntuitSignature,
  flattenQboWebhookPayload,
  mapQboEntityType,
  parseQboWebhookPayload,
  verifyQboWebhook,
} from './qbo-webhook.js'

const TEST_VERIFIER = 'test-verifier-token-1234567890'

function sign(body: string, secret: string = TEST_VERIFIER): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64')
}

describe('qbo-webhook verifyQboWebhook', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    const sig = sign(body)
    const result = verifyQboWebhook(body, sig, TEST_VERIFIER)
    expect(result.ok).toBe(true)
  })

  it('rejects a tampered body with 401', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    const sig = sign(body)
    const tampered = body + ' '
    const result = verifyQboWebhook(tampered, sig, TEST_VERIFIER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it('rejects missing signature header with 401', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    const result = verifyQboWebhook(body, null, TEST_VERIFIER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.error).toMatch(/intuit-signature/)
    }
  })

  it('rejects signature computed with a different secret with 401', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    const sig = sign(body, 'wrong-secret')
    const result = verifyQboWebhook(body, sig, TEST_VERIFIER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it('rejects a signature of the wrong length with 401 (no throw)', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    // 8 bytes of base64 — deliberately too short for SHA-256.
    const shortSig = Buffer.from('12345678').toString('base64')
    const result = verifyQboWebhook(body, shortSig, TEST_VERIFIER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it('returns 500 when verifier token is not configured', () => {
    const body = JSON.stringify({ eventNotifications: [] })
    const sig = sign(body)
    const result = verifyQboWebhook(body, sig, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(500)
  })
})

describe('qbo-webhook extractIntuitSignature', () => {
  it('returns the string header value', () => {
    expect(extractIntuitSignature({ 'intuit-signature': 'abc' })).toBe('abc')
  })

  it('returns the first element when header value is an array', () => {
    expect(extractIntuitSignature({ 'intuit-signature': ['abc', 'def'] })).toBe('abc')
  })

  it('returns null when header is missing', () => {
    expect(extractIntuitSignature({})).toBeNull()
  })
})

describe('qbo-webhook parseQboWebhookPayload', () => {
  it('parses a well-formed payload', () => {
    const body = JSON.stringify({
      eventNotifications: [
        {
          realmId: '9341452890',
          dataChangeEvent: {
            entities: [{ name: 'Customer', id: '42', operation: 'Create', lastUpdated: '2026-04-24T20:00:00Z' }],
          },
        },
      ],
    })
    const result = parseQboWebhookPayload(body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.eventNotifications?.[0]?.realmId).toBe('9341452890')
    }
  })

  it('rejects malformed JSON with 400', () => {
    const result = parseQboWebhookPayload('not-json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects non-object payload with 400', () => {
    const result = parseQboWebhookPayload('"a string"')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects payload missing eventNotifications array with 400', () => {
    const result = parseQboWebhookPayload('{}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('accepts an empty eventNotifications array', () => {
    const result = parseQboWebhookPayload('{"eventNotifications":[]}')
    expect(result.ok).toBe(true)
  })
})

describe('qbo-webhook mapQboEntityType', () => {
  it('maps the four canonical names', () => {
    expect(mapQboEntityType('Customer')).toBe('customer')
    expect(mapQboEntityType('Item')).toBe('service_item')
    expect(mapQboEntityType('Bill')).toBe('material_bill')
    expect(mapQboEntityType('Invoice')).toBe('invoice')
  })

  it('lowercases unknown entity names (pass-through)', () => {
    expect(mapQboEntityType('Preferences')).toBe('preferences')
  })
})

describe('qbo-webhook flattenQboWebhookPayload', () => {
  it('fans out multiple notifications and entities', () => {
    const flat = flattenQboWebhookPayload({
      eventNotifications: [
        {
          realmId: '1',
          dataChangeEvent: {
            entities: [
              { name: 'Customer', id: '10', operation: 'Create' },
              { name: 'Bill', id: '11', operation: 'Update', lastUpdated: '2026-04-24T00:00:00Z' },
            ],
          },
        },
        {
          realmId: '2',
          dataChangeEvent: { entities: [{ name: 'Item', id: '99', operation: 'Create' }] },
        },
      ],
    })
    expect(flat).toHaveLength(3)
    expect(flat[0]).toMatchObject({ realmId: '1', entityType: 'customer', entityId: '10', operation: 'Create' })
    expect(flat[1]).toMatchObject({ realmId: '1', entityType: 'material_bill', entityId: '11' })
    expect(flat[2]).toMatchObject({ realmId: '2', entityType: 'service_item', entityId: '99' })
  })

  it('skips entities missing name or id', () => {
    const flat = flattenQboWebhookPayload({
      eventNotifications: [
        {
          realmId: '1',
          dataChangeEvent: {
            entities: [
              { name: '', id: '10', operation: 'Create' },
              { name: 'Customer', id: '', operation: 'Create' },
            ],
          },
        },
      ],
    })
    expect(flat).toHaveLength(0)
  })

  it('skips notifications missing realmId', () => {
    const flat = flattenQboWebhookPayload({
      eventNotifications: [
        {
          realmId: '',
          dataChangeEvent: { entities: [{ name: 'Customer', id: '10', operation: 'Create' }] },
        },
      ],
    })
    expect(flat).toHaveLength(0)
  })
})

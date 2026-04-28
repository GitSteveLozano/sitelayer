import { describe, expect, it } from 'vitest'
import { scrubSentryEvent } from './sentry-scrub.js'

describe('scrubSentryEvent', () => {
  it('redacts authorization and cookie headers case-insensitively', () => {
    const result = scrubSentryEvent({
      request: {
        headers: {
          Authorization: 'Bearer abc.def.ghi',
          cookie: 'session=secret',
          'X-Sitelayer-User-Id': 'user-1',
          'content-type': 'application/json',
        },
      },
    })
    expect(result.request?.headers?.Authorization).toBe('[REDACTED]')
    expect(result.request?.headers?.cookie).toBe('[REDACTED]')
    expect(result.request?.headers?.['X-Sitelayer-User-Id']).toBe('[REDACTED]')
    expect(result.request?.headers?.['content-type']).toBe('application/json')
  })

  it('replaces request.cookies wholesale', () => {
    const result = scrubSentryEvent({
      request: { cookies: { session: 'secret', tracking: 'abc' } },
    })
    expect(result.request?.cookies).toBe('[REDACTED]')
  })

  it('redacts PDF body strings', () => {
    const pdf = '%PDF-1.7\n%binary content...'
    const result = scrubSentryEvent({ request: { data: pdf } })
    expect(result.request?.data).toBe('[REDACTED:pdf]')
  })

  it('redacts PDF body buffers', () => {
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
    const result = scrubSentryEvent({ request: { data: buffer } })
    expect(result.request?.data).toBe('[REDACTED:pdf]')
  })

  it('redacts oversized binary buffers', () => {
    const buffer = new Uint8Array(64 * 1024)
    const result = scrubSentryEvent({ request: { data: buffer } })
    expect(result.request?.data).toMatch(/^\[REDACTED:binary \d+b\]$/)
  })

  it('redacts oversized string bodies', () => {
    const big = 'x'.repeat(40 * 1024)
    const result = scrubSentryEvent({ request: { data: big } })
    expect(result.request?.data).toMatch(/^\[REDACTED:string \d+b\]$/)
  })

  it('redacts known sensitive JSON fields by name', () => {
    const result = scrubSentryEvent({
      request: {
        data: {
          access_token: 'qbo-access',
          refresh_token: 'qbo-refresh',
          client_secret: 'shh',
          password: 'plaintext',
          name: 'Project A',
          nested: { webhook_secret: 'whatever', label: 'keep' },
        },
      },
    })
    const data = result.request?.data as Record<string, unknown>
    expect(data.access_token).toBe('[REDACTED]')
    expect(data.refresh_token).toBe('[REDACTED]')
    expect(data.client_secret).toBe('[REDACTED]')
    expect(data.password).toBe('[REDACTED]')
    expect(data.name).toBe('Project A')
    expect((data.nested as Record<string, unknown>).webhook_secret).toBe('[REDACTED]')
    expect((data.nested as Record<string, unknown>).label).toBe('keep')
  })

  it('redacts PDF magic strings nested inside bodies', () => {
    const result = scrubSentryEvent({
      request: { data: { name: 'Project', body: '%PDF-1.7 inline' } },
    })
    const data = result.request?.data as Record<string, unknown>
    expect(data.body).toBe('[REDACTED:pdf]')
  })

  it('passes events without request through unchanged', () => {
    const event = { extra: { foo: 'bar' } }
    const result = scrubSentryEvent(event)
    expect(result).toEqual({ extra: { foo: 'bar' } })
  })

  it('caps recursion depth on pathological objects', () => {
    type Chain = { next?: Chain; access_token?: string }
    const root: Chain = {}
    let cur: Chain = root
    for (let i = 0; i < 50; i += 1) {
      const next: Chain = {}
      cur.next = next
      cur = next
    }
    cur.access_token = 'leak'
    const result = scrubSentryEvent({ extra: { root } })
    expect(result.extra).toBeDefined()
  })
})

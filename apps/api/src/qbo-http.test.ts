import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Replace `./instrument.js` so we can spy on Sentry.startSpan. Real ESM
 * namespace exports are non-configurable, so `vi.spyOn(Sentry, 'startSpan')`
 * fails. Mocking the whole module gives us a vi.fn we control.
 */
vi.mock('./instrument.js', () => ({
  Sentry: {
    startSpan: vi.fn(),
  },
}))

import { appendQboRequestId, qboFetch, qboGet, qboPost, sanitizeQboRequestId } from './qbo-http.js'
import { Sentry } from './instrument.js'

type FetchMock = ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Capture the per-attempt Sentry span(s) so tests can assert
 * setAttribute / setStatus invocations.
 */
type CapturedSpan = {
  setAttribute: ReturnType<typeof vi.fn>
  setStatus: ReturnType<typeof vi.fn>
}

type SentryCall = {
  name: string | undefined
  op: string | undefined
  attributes: Record<string, unknown> | undefined
}

function installSentrySpy(): { spans: CapturedSpan[]; calls: SentryCall[] } {
  const spans: CapturedSpan[] = []
  const calls: SentryCall[] = []
  const startSpan = Sentry.startSpan as unknown as ReturnType<typeof vi.fn>
  startSpan.mockImplementation((options: unknown, cb: (span: unknown) => unknown) => {
    const opts = options as { name?: string; op?: string; attributes?: Record<string, unknown> }
    calls.push({
      name: opts.name,
      op: opts.op,
      attributes: opts.attributes,
    })
    const span: CapturedSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
    }
    spans.push(span)
    return cb(span)
  })
  return { spans, calls }
}

describe('qboFetch', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    ;(Sentry.startSpan as unknown as ReturnType<typeof vi.fn>).mockReset()
  })

  it('returns parsed JSON on the happy path (single request)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hello: 'world' }))
    const { spans, calls } = installSentrySpy()

    const result = await qboFetch<{ hello: string }>('https://example.test/v3/foo', { method: 'GET' })
    expect(result).toEqual({ hello: 'world' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      name: 'qbo.request',
      op: 'http.client',
      attributes: {
        'http.url': 'https://example.test/v3/foo',
        'http.method': 'GET',
        'qbo.attempt': 0,
      },
    })
    expect(spans[0]!.setAttribute).toHaveBeenCalledWith('http.status_code', 200)
    expect(spans[0]!.setStatus).not.toHaveBeenCalled()
  })

  it('retries on 429 and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate' }, 'Too Many Requests'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const { spans } = installSentrySpy()

    const promise = qboFetch<{ ok: boolean }>('https://example.test/v3/foo', { method: 'GET' })
    // Drain the first retry delay (200ms).
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First span: 429 status + error status set.
    expect(spans[0]!.setAttribute).toHaveBeenCalledWith('http.status_code', 429)
    expect(spans[0]!.setStatus).toHaveBeenCalledWith({ code: 2, message: 'qbo_429' })
    // Second span: 200, no error status.
    expect(spans[1]!.setAttribute).toHaveBeenCalledWith('http.status_code', 200)
    expect(spans[1]!.setStatus).not.toHaveBeenCalled()
  })

  it('retries on 503 and succeeds after the delay', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: 'svc' }, 'Service Unavailable'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }))
    installSentrySpy()

    const promise = qboFetch<{ ok: number }>('https://example.test/v3/foo', { method: 'POST' })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws after retry exhaustion: 4 attempts total (initial + 3 retries)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'svc' }, 'Service Unavailable'))
    installSentrySpy()

    const promise = qboFetch<unknown>('https://example.test/v3/foo', { method: 'GET' })
    // Attach the catch handler before draining timers so the rejection isn't
    // an unhandled promise rejection between awaits.
    const assertion = expect(promise).rejects.toThrow('QBO API error: 503 Service Unavailable')
    await vi.runAllTimersAsync()
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does NOT retry on 4xx other than 429', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'auth' }, 'Unauthorized'))
    const { spans } = installSentrySpy()

    await expect(qboFetch<unknown>('https://example.test/v3/foo', { method: 'GET' })).rejects.toThrow(
      'QBO API error: 401 Unauthorized',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(spans[0]!.setStatus).toHaveBeenCalledWith({ code: 2, message: 'qbo_401' })
  })

  it('sets the failure status attribute on the span when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'bad' }, 'Bad Request'))
    const { spans } = installSentrySpy()

    await expect(qboFetch<unknown>('https://example.test/v3/foo', { method: 'POST' })).rejects.toThrow(
      'QBO API error: 400 Bad Request',
    )
    expect(spans[0]!.setAttribute).toHaveBeenCalledWith('http.status_code', 400)
    expect(spans[0]!.setStatus).toHaveBeenCalledWith({ code: 2, message: 'qbo_400' })
  })

  it('defaults the http.method attribute to GET when init.method is omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    const { calls } = installSentrySpy()

    await qboFetch('https://example.test/v3/foo', {})
    expect(calls[0]?.attributes?.['http.method']).toBe('GET')
  })
})

describe('qboGet', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    ;(Sentry.startSpan as unknown as ReturnType<typeof vi.fn>).mockReset()
  })

  it('builds the QBO v3 URL and sends Authorization + Accept headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }))
    installSentrySpy()

    await qboGet('https://sandbox.qbo.test', '/companyinfo/1', 'realm-7', 'token-abc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://sandbox.qbo.test/v3/company/realm-7/companyinfo/1')
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-abc',
      Accept: 'application/json',
    })
  })
})

describe('qboPost', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    ;(Sentry.startSpan as unknown as ReturnType<typeof vi.fn>).mockReset()
  })

  it('builds the QBO v3 URL and serializes the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { Bill: { Id: '42' } }))
    installSentrySpy()

    await qboPost('https://sandbox.qbo.test', '/bill', 'realm-9', 'token-xyz', { Line: [{ Amount: 100 }] })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://sandbox.qbo.test/v3/company/realm-9/bill')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-xyz',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual({ Line: [{ Amount: 100 }] })
  })

  it('appends ?requestid=<key> when an idempotency key is supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { Estimate: { Id: '7' } }))
    installSentrySpy()

    await qboPost('https://sandbox.qbo.test', '/estimate', 'realm-9', 'token-xyz', {}, 'run-1234-abcd')

    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://sandbox.qbo.test/v3/company/realm-9/estimate?requestid=run-1234-abcd')
  })

  it('omits ?requestid when the key is null/undefined (back-compat)', async () => {
    // Fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})))
    installSentrySpy()

    await qboPost('https://sandbox.qbo.test', '/estimate', 'r', 't', {}, null)
    await qboPost('https://sandbox.qbo.test', '/estimate', 'r', 't', {})

    expect(fetchMock.mock.calls[0]![0]).toBe('https://sandbox.qbo.test/v3/company/r/estimate')
    expect(fetchMock.mock.calls[1]![0]).toBe('https://sandbox.qbo.test/v3/company/r/estimate')
  })

  it('is deterministic: same key → same requestid across retries', async () => {
    // A crash/retry of the SAME logical create must reproduce the SAME
    // requestid byte-for-byte, otherwise Intuit can't dedupe it.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})))
    installSentrySpy()

    await qboPost('https://sandbox.qbo.test', '/invoice', 'r', 't', {}, 'rental_billing_run:post:abc')
    await qboPost('https://sandbox.qbo.test', '/invoice', 'r', 't', {}, 'rental_billing_run:post:abc')

    expect(fetchMock.mock.calls[0]![0]).toBe(fetchMock.mock.calls[1]![0])
  })
})

describe('sanitizeQboRequestId', () => {
  it('passes through URL-safe tokens (UUIDs) unchanged', () => {
    const uuid = '4b9a7f10-3c2d-4e5a-8b1c-9f0e1d2c3b4a'
    expect(sanitizeQboRequestId(uuid)).toBe(uuid)
  })

  it('replaces unsafe chars (e.g. outbox key colons) with hyphens', () => {
    expect(sanitizeQboRequestId('rental_billing_run:post:abc')).toBe('rental_billing_run-post-abc')
  })

  it('collapses runs of hyphens and trims leading/trailing ones', () => {
    expect(sanitizeQboRequestId('::a  b::')).toBe('a-b')
  })

  it('caps the token at Intuit’s 50-char limit', () => {
    const long = 'x'.repeat(120)
    expect(sanitizeQboRequestId(long)).toHaveLength(50)
  })

  it('is deterministic for the same input', () => {
    const input = 'labor_payroll_run:post:9999'
    expect(sanitizeQboRequestId(input)).toBe(sanitizeQboRequestId(input))
  })
})

describe('appendQboRequestId', () => {
  it('uses ? when the URL has no query string', () => {
    expect(appendQboRequestId('https://q.test/invoice', 'k')).toBe('https://q.test/invoice?requestid=k')
  })

  it('uses & when the URL already has a query string', () => {
    expect(appendQboRequestId('https://q.test/invoice?minorversion=70', 'k')).toBe(
      'https://q.test/invoice?minorversion=70&requestid=k',
    )
  })

  it('returns the URL unchanged for a falsy or all-unsafe key', () => {
    expect(appendQboRequestId('https://q.test/invoice', null)).toBe('https://q.test/invoice')
    expect(appendQboRequestId('https://q.test/invoice', '')).toBe('https://q.test/invoice')
    expect(appendQboRequestId('https://q.test/invoice', '::')).toBe('https://q.test/invoice')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sentry trace headers are read off the lazy facade at request time.
// vi.mock has to come BEFORE the SUT import so the Sentry namespace
// is intercepted; we use vi.hoisted so the spy persists across calls.
const sentryMock = vi.hoisted(() => ({
  getTraceData: vi.fn<() => Record<string, string>>(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('@/instrument', () => ({
  Sentry: sentryMock,
}))

vi.mock('@/lib/auth', () => ({
  isClerkConfigured: () => false,
}))

import { startLocalCaptureSession } from '../capture-session'
import { request, requestBlob, buildAuthHeaders } from './client'

describe('api client trace forwarding', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    window.sessionStorage.clear()
    sentryMock.getTraceData.mockReset()
    sentryMock.captureException.mockReset()
    sentryMock.addBreadcrumb.mockReset()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('forwards sentry-trace + baggage when Sentry has trace data', async () => {
    sentryMock.getTraceData.mockReturnValue({
      'sentry-trace': '0123456789abcdef0123456789abcdef-0123456789abcdef-1',
      baggage: 'sentry-environment=test,sentry-trace_id=0123456789abcdef0123456789abcdef',
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await request('/api/test')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('sentry-trace')).toBe('0123456789abcdef0123456789abcdef-0123456789abcdef-1')
    expect(headers.get('baggage')).toBe('sentry-environment=test,sentry-trace_id=0123456789abcdef0123456789abcdef')
    expect(headers.get('x-request-id')).toBeTruthy()
  })

  it('omits trace headers when Sentry has no trace data (early boot)', async () => {
    sentryMock.getTraceData.mockReturnValue({})
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await request('/api/test')

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('sentry-trace')).toBeNull()
    expect(headers.get('baggage')).toBeNull()
    // x-request-id always goes out — it's the SPA-side correlation id
    // and is independent of Sentry being initialized.
    expect(headers.get('x-request-id')).toBeTruthy()
  })

  it('does not throw if getTraceData itself throws (Sentry not initialized)', async () => {
    sentryMock.getTraceData.mockImplementation(() => {
      throw new Error('Sentry not initialized')
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(request('/api/test')).resolves.toBeDefined()
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('sentry-trace')).toBeNull()
    expect(headers.get('baggage')).toBeNull()
  })

  it('buildAuthHeaders also includes trace headers for multipart callers', async () => {
    sentryMock.getTraceData.mockReturnValue({
      'sentry-trace': 'cafe1234cafe1234cafe1234cafe1234-feedfacefeedface-1',
      baggage: 'sentry-environment=test',
    })
    const headers = await buildAuthHeaders()
    expect(headers.get('sentry-trace')).toBe('cafe1234cafe1234cafe1234cafe1234-feedfacefeedface-1')
    expect(headers.get('baggage')).toBe('sentry-environment=test')
  })

  it('respects caller-supplied sentry-trace header (does not overwrite)', async () => {
    sentryMock.getTraceData.mockReturnValue({
      'sentry-trace': 'should-not-overwrite',
      baggage: 'should-not-overwrite',
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await request('/api/test', {
      headers: { 'sentry-trace': 'caller-supplied-trace' },
    })

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('sentry-trace')).toBe('caller-supplied-trace')
  })

  it('forwards the active capture session id on JSON requests', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await request('/api/test')

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('x-sitelayer-capture-session-id')).toBe('00000000-0000-4000-8000-000000000123')
  })

  it('forwards the active capture session id for multipart callers', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })

    const headers = await buildAuthHeaders()

    expect(headers.get('x-sitelayer-capture-session-id')).toBe('00000000-0000-4000-8000-000000000123')
  })

  it('forwards the active capture session id on blob requests', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response('asset-bytes', { headers: { 'content-type': 'text/plain' } }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await requestBlob('/api/assets/file')

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('x-sitelayer-capture-session-id')).toBe('00000000-0000-4000-8000-000000000123')
  })
})

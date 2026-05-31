import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { startLocalCaptureSession } from '@/lib/capture-session'
import {
  appendPortalRentalCaptureEvents,
  fetchPortalEstimate,
  startPortalEstimateCaptureSession,
} from './api'

describe('public portal API capture headers', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    window.sessionStorage.clear()
    sentryMock.getTraceData.mockReset()
    sentryMock.getTraceData.mockReturnValue({
      'sentry-trace': '0123456789abcdef0123456789abcdef-0123456789abcdef-1',
      baggage: 'sentry-environment=test',
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends request/trace/capture headers on public estimate reads without auth or company headers', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'share-1',
          project_name: 'Riverbend',
          company_name: 'Acme',
          recipient_email: null,
          recipient_name: null,
          sent_at: '2026-05-31T12:00:00.000Z',
          expires_at: '2026-06-30T12:00:00.000Z',
          status: 'pending',
          estimate: { bid_total: 1, scope_total: 1, lines: [], captured_at: '2026-05-31T12:00:00.000Z' },
          accepted_at: null,
          declined_at: null,
          decline_reason: null,
          signer_name: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await fetchPortalEstimate('token-1')

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('x-request-id')).toMatch(/^web-/)
    expect(headers.get('sentry-trace')).toBe('0123456789abcdef0123456789abcdef-0123456789abcdef-1')
    expect(headers.get('x-sitelayer-capture-session-id')).toBe('00000000-0000-4000-8000-000000000123')
    expect(headers.get('x-sitelayer-company-slug')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
  })

  it('posts estimate capture-session start payloads to the token-bound public route', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          capture_session: {
            id: '00000000-0000-4000-8000-000000000123',
            mode: 'feedback',
            status: 'open',
            started_at: '2026-05-31T12:00:00.000Z',
            last_seen_at: '2026-05-31T12:00:01.000Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await startPortalEstimateCaptureSession('share.token', {
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/api/portal/estimates/share.token/capture-sessions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(String(init.body))).toMatchObject({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
    })
  })

  it('posts rental capture events to the token-bound public route', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: 1 }), { status: 202, headers: { 'content-type': 'application/json' } }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await appendPortalRentalCaptureEvents('rental.token', '00000000-0000-4000-8000-000000000123', [
      { event_type: 'portal.cart.added', payload: { item_id: 'item-1' } },
    ])

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain(
      '/api/portal/rentals/rental.token/capture-sessions/00000000-0000-4000-8000-000000000123/events',
    )
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      events: [{ event_type: 'portal.cart.added', payload: { item_id: 'item-1' } }],
    })
  })
})

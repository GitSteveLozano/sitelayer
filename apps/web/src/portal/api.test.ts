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
  discardPortalEstimateCaptureSession,
  discardPortalRentalCaptureSession,
  fetchPortalEstimate,
  finalizePortalEstimateCaptureSession,
  finalizePortalRentalCaptureSession,
  startPortalEstimateCaptureSession,
  uploadFeedbackInviteCaptureArtifact,
  uploadPortalEstimateCaptureArtifact,
  uploadPortalRentalCaptureArtifact,
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
    const fetchSpy = vi.fn(
      async () =>
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
    const fetchSpy = vi.fn(
      async () =>
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
    const fetchSpy = vi.fn(
      async () =>
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

  it('uploads estimate capture artifacts without auth headers or a forced multipart content-type', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            artifact: {
              id: 'artifact-1',
              kind: 'audio',
              storage_key: 'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/audio.webm',
              content_type: 'audio/webm',
              byte_size: 12,
              content_hash: 'sha256:abc',
              redaction_version: 'capture-session-v1',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await uploadPortalEstimateCaptureArtifact('share.token', '00000000-0000-4000-8000-000000000123', {
      kind: 'audio',
      file: new Blob(['hello'], { type: 'audio/webm' }),
      fileName: 'feedback.webm',
      duration_ms: 1200,
      pii_level: 'private',
      metadata: { source: 'portal_mic' },
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain(
      '/api/portal/estimates/share.token/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload',
    )
    expect(init.method).toBe('POST')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('kind')).toBe('audio')
    expect(form.get('duration_ms')).toBe('1200')
    expect(form.get('pii_level')).toBe('private')
    expect(form.get('metadata')).toBe(JSON.stringify({ source: 'portal_mic' }))
  })

  it('uploads feedback invite capture artifacts with the token header and no forced multipart content-type', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            artifact: {
              id: 'artifact-1',
              kind: 'state_snapshot',
              storage_key: 'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/state.json',
              content_type: 'application/json',
              byte_size: 24,
              content_hash: 'sha256:state',
              redaction_version: 'capture-session-v1',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await uploadFeedbackInviteCaptureArtifact('feedback.token', '00000000-0000-4000-8000-000000000123', {
      kind: 'state_snapshot',
      file: new Blob(['{"ok":true}'], { type: 'application/json' }),
      fileName: 'state.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: { source: 'feedback_invite_page' },
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain(
      '/api/portal/feedback-invites/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload',
    )
    expect(init.method).toBe('POST')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-sitelayer-feedback-invite')).toBe('feedback.token')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('kind')).toBe('state_snapshot')
    expect(form.get('pii_level')).toBe('internal')
    expect(form.get('access_policy')).toBe('support_only')
  })

  it('finalizes rental capture sessions through the token-bound public route', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            work_item: {
              id: 'work-item-1',
              title: 'Portal issue',
              summary: 'Customer narrated the issue.',
              status: 'new',
              lane: 'triage',
              severity: 'high',
              route: '/portal/rentals/token',
              capture_session_id: '00000000-0000-4000-8000-000000000123',
            },
            support_packet: { id: 'support-1', expires_at: null },
            event: null,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await finalizePortalRentalCaptureSession('rental.token', '00000000-0000-4000-8000-000000000123', {
      title: 'Portal issue',
      severity: 'high',
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain(
      '/api/portal/rentals/rental.token/capture-sessions/00000000-0000-4000-8000-000000000123/finalize',
    )
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Portal issue', severity: 'high' })
  })

  it('supports estimate finalize and rental artifact upload helper parity', async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url)
      if (href.includes('/artifacts/upload')) {
        return new Response(
          JSON.stringify({
            artifact: {
              id: 'artifact-1',
              kind: 'rrweb',
              storage_key: 'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/replay.json',
              content_type: 'application/json',
              byte_size: 48,
              content_hash: 'sha256:rrweb',
              redaction_version: 'capture-session-v1',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          work_item: {
            id: 'work-item-1',
            title: 'Estimate portal issue',
            summary: 'Customer narrated the issue.',
            status: 'new',
            lane: 'triage',
            severity: null,
            route: '/portal/estimates/token',
            capture_session_id: '00000000-0000-4000-8000-000000000123',
          },
          support_packet: { id: 'support-1', expires_at: null },
          event: null,
          idempotent_replay: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await finalizePortalEstimateCaptureSession('share.token', '00000000-0000-4000-8000-000000000123', {
      title: 'Estimate portal issue',
    })
    await uploadPortalRentalCaptureArtifact('rental.token', '00000000-0000-4000-8000-000000000123', {
      kind: 'rrweb',
      file: new Blob(['{"events":[]}'], { type: 'application/json' }),
      fileName: 'replay.json',
      pii_level: 'private',
    })

    const [finalizeUrl, finalizeInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(finalizeUrl)).toContain(
      '/api/portal/estimates/share.token/capture-sessions/00000000-0000-4000-8000-000000000123/finalize',
    )
    expect(finalizeInit.method).toBe('POST')
    expect(JSON.parse(String(finalizeInit.body))).toEqual({ title: 'Estimate portal issue' })

    const [uploadUrl, uploadInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(uploadUrl)).toContain(
      '/api/portal/rentals/rental.token/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload',
    )
    expect(uploadInit.method).toBe('POST')
    expect(uploadInit.body).toBeInstanceOf(FormData)
    expect((uploadInit.body as FormData).get('kind')).toBe('rrweb')
  })

  it('posts portal capture discard requests to token-bound public routes', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            capture_session: {
              id: '00000000-0000-4000-8000-000000000123',
              mode: 'feedback',
              status: 'discarded',
              started_at: '2026-05-31T12:00:00.000Z',
              last_seen_at: '2026-05-31T12:00:01.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await discardPortalEstimateCaptureSession('share.token', '00000000-0000-4000-8000-000000000123', {
      metadata: {
        capture_failure: {
          event_type: 'recording_start_failed',
          message: 'screen share permission denied',
        },
      },
    })
    await discardPortalRentalCaptureSession('rental.token', '00000000-0000-4000-8000-000000000123')

    const [estimateUrl, estimateInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const [rentalUrl, rentalInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(estimateUrl)).toContain(
      '/api/portal/estimates/share.token/capture-sessions/00000000-0000-4000-8000-000000000123/discard',
    )
    expect(String(rentalUrl)).toContain(
      '/api/portal/rentals/rental.token/capture-sessions/00000000-0000-4000-8000-000000000123/discard',
    )
    expect(estimateInit.method).toBe('POST')
    expect(rentalInit.method).toBe('POST')
    expect(estimateInit.body).toBe(
      JSON.stringify({
        metadata: {
          capture_failure: {
            event_type: 'recording_start_failed',
            message: 'screen share permission denied',
          },
        },
      }),
    )
    expect(rentalInit.body).toBe(JSON.stringify({}))
  })
})

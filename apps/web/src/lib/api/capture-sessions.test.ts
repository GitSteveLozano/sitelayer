import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_SESSION_STORAGE_KEY, getActiveCaptureSessionId, startLocalCaptureSession } from '../capture-session'
import { buildAuthHeaders, request } from './client'
import {
  discardCaptureSession,
  fetchCaptureSession,
  finalizeCaptureSession,
  stopCaptureSession,
  uploadCaptureArtifact,
  type CaptureSessionResponse,
} from './capture-sessions'

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>()
  return {
    ...actual,
    API_URL: 'https://api.test',
    buildAuthHeaders: vi.fn(async () => new Headers({ 'x-request-id': 'web-test-request' })),
    request: vi.fn(),
  }
})

const requestMock = vi.mocked(request)
const buildAuthHeadersMock = vi.mocked(buildAuthHeaders)

function response(status: string): CaptureSessionResponse {
  return {
    capture_session: {
      id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      status,
      started_at: '2026-05-31T12:00:00.000Z',
      last_seen_at: '2026-05-31T12:00:01.000Z',
    },
  }
}

describe('capture session API client', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    window.sessionStorage.clear()
    requestMock.mockReset()
    buildAuthHeadersMock.mockClear()
    globalThis.fetch = originalFetch
    window.history.replaceState({}, '', '/desktop/takeoff?sheet=A101')
  })

  it('clears the local capture session after a successful stop', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    requestMock.mockResolvedValueOnce(response('stopped'))

    await expect(stopCaptureSession('00000000-0000-4000-8000-000000000123')).resolves.toMatchObject({
      capture_session: { status: 'stopped' },
    })

    expect(requestMock).toHaveBeenCalledWith('/api/capture-sessions/00000000-0000-4000-8000-000000000123', {
      method: 'PATCH',
      json: { status: 'stopped', route_path: '/desktop/takeoff' },
    })
    expect(getActiveCaptureSessionId()).toBeNull()
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('keeps the local capture session when stop fails so upload can retry', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    requestMock.mockRejectedValueOnce(new Error('network down'))

    await expect(stopCaptureSession('00000000-0000-4000-8000-000000000123')).rejects.toThrow('network down')

    expect(getActiveCaptureSessionId()).toBe('00000000-0000-4000-8000-000000000123')
  })

  it('does not clear a newer local capture session when stopping an older id', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000999', mode: 'feedback' })
    requestMock.mockResolvedValueOnce(response('stopped'))

    await stopCaptureSession('00000000-0000-4000-8000-000000000123')

    expect(getActiveCaptureSessionId()).toBe('00000000-0000-4000-8000-000000000999')
  })

  it('keeps the local capture session when discard fails so server state is not lost', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    requestMock.mockRejectedValueOnce(new Error('server unavailable'))

    await expect(discardCaptureSession('00000000-0000-4000-8000-000000000123')).rejects.toThrow('server unavailable')

    expect(getActiveCaptureSessionId()).toBe('00000000-0000-4000-8000-000000000123')
  })

  it('fetches capture session counts from the detail route', async () => {
    requestMock.mockResolvedValueOnce({
      ...response('open'),
      event_count: 3,
      artifact_count: 2,
    })

    await expect(fetchCaptureSession('00000000-0000-4000-8000-000000000123')).resolves.toMatchObject({
      event_count: 3,
      artifact_count: 2,
    })

    expect(requestMock).toHaveBeenCalledWith('/api/capture-sessions/00000000-0000-4000-8000-000000000123')
  })

  it('uploads a binary capture artifact using the multipart route', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          artifact: {
            id: '00000000-0000-4000-8000-000000000456',
            kind: 'audio',
            storage_key: 'companies/co/capture-sessions/s/artifacts/audio.webm',
            content_type: 'audio/webm',
            byte_size: 11,
            content_hash: 'sha256:abc',
            redaction_version: 'capture-session-v1',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const file = new Blob(['audio-bytes'], { type: 'audio/webm' })
    await expect(
      uploadCaptureArtifact('00000000-0000-4000-8000-000000000123', {
        kind: 'audio',
        file,
        fileName: 'field-note.webm',
        duration_ms: 1234.9,
        pii_level: 'private',
        metadata: { source: 'mic' },
      }),
    ).resolves.toMatchObject({ artifact: { kind: 'audio', content_hash: 'sha256:abc' } })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/api/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload')
    expect(init.method).toBe('POST')
    expect((init.headers as Headers).get('x-request-id')).toBe('web-test-request')
    const body = init.body as FormData
    expect(body.get('kind')).toBe('audio')
    expect(body.get('duration_ms')).toBe('1234')
    expect(body.get('pii_level')).toBe('private')
    expect(body.get('metadata')).toBe(JSON.stringify({ source: 'mic' }))
    const uploaded = body.get('file') as File
    expect(uploaded.name).toBe('field-note.webm')
    expect(uploaded.type).toBe('audio/webm')
  })

  it('surfaces multipart upload errors as ApiError instances', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'capture artifact exceeds limit' }), {
        status: 413,
        headers: { 'content-type': 'application/json', 'x-request-id': 'api-req-1' },
      }),
    ) as unknown as typeof fetch

    await expect(
      uploadCaptureArtifact('00000000-0000-4000-8000-000000000123', {
        kind: 'audio',
        file: new Blob(['audio'], { type: 'audio/webm' }),
      }),
    ).rejects.toMatchObject({
      status: 413,
      path: '/api/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload',
      requestId: 'api-req-1',
      body: { error: 'capture artifact exceeds limit' },
    })
  })

  it('finalizes a capture session and clears the local id only after success', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    requestMock.mockResolvedValueOnce({
      work_item: {
        id: 'wi_1',
        title: 'Recorded feedback',
        summary: 'User narrated the issue.',
        status: 'new',
        lane: 'agent',
        severity: 'high',
        route: '/desktop/takeoff',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
      },
      support_packet: { id: 'sp_1', expires_at: null },
      event: null,
    })

    await expect(
      finalizeCaptureSession('00000000-0000-4000-8000-000000000123', {
        title: 'Recorded feedback',
        lane: 'agent',
        severity: 'high',
      }),
    ).resolves.toMatchObject({ work_item: { id: 'wi_1' } })

    expect(requestMock).toHaveBeenCalledWith('/api/capture-sessions/00000000-0000-4000-8000-000000000123/finalize', {
      method: 'POST',
      json: {
        route_path: '/desktop/takeoff',
        title: 'Recorded feedback',
        lane: 'agent',
        severity: 'high',
      },
    })
    expect(getActiveCaptureSessionId()).toBeNull()
  })
})

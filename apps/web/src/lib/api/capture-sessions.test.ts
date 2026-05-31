import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_SESSION_STORAGE_KEY, getActiveCaptureSessionId, startLocalCaptureSession } from '../capture-session'
import { request } from './client'
import { discardCaptureSession, stopCaptureSession, type CaptureSessionResponse } from './capture-sessions'

vi.mock('./client', () => ({
  request: vi.fn(),
}))

const requestMock = vi.mocked(request)

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
  beforeEach(() => {
    window.sessionStorage.clear()
    requestMock.mockReset()
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

  it('keeps the local capture session when discard fails so server state is not lost', async () => {
    startLocalCaptureSession({ id: '00000000-0000-4000-8000-000000000123', mode: 'feedback' })
    requestMock.mockRejectedValueOnce(new Error('server unavailable'))

    await expect(discardCaptureSession('00000000-0000-4000-8000-000000000123')).rejects.toThrow('server unavailable')

    expect(getActiveCaptureSessionId()).toBe('00000000-0000-4000-8000-000000000123')
  })
})

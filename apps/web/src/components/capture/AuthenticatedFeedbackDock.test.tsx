import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureArtifactProvidersForTests,
  registerCaptureArtifactProvider,
} from '@/lib/capture-artifact-providers'
import { CAPTURE_SESSION_STORAGE_KEY } from '@/lib/capture-session'
import {
  AUTH_FEEDBACK_AUDIO_STORAGE_KEY,
  AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY,
  AUTH_FEEDBACK_ENABLED_STORAGE_KEY,
  AUTH_FEEDBACK_REPLAY_STORAGE_KEY,
  STEVE_COLLAB_MODE_STORAGE_KEY,
  STEVE_COLLAB_MODE_VALUE,
} from '@/lib/steve-collab'
import { AuthenticatedFeedbackDock } from './AuthenticatedFeedbackDock'

const captureApi = vi.hoisted(() => ({
  appendCaptureSessionEvents: vi.fn(),
  createCaptureSession: vi.fn(),
  discardCaptureSession: vi.fn(),
  finalizeCaptureSession: vi.fn(),
  uploadCaptureArtifact: vi.fn(),
}))

vi.mock('@/lib/api/capture-sessions', () => captureApi)

const rrweb = vi.hoisted(() => ({
  record: vi.fn(),
}))

vi.mock('@rrweb/record', () => rrweb)

class FakeTrack {
  stop = vi.fn()
}

class FakeStream {
  readonly tracks = [new FakeTrack()]

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeMediaRecorder {
  static isTypeSupported(mimeType: string): boolean {
    return mimeType === 'audio/webm'
  }

  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly stream: MediaStream) {}

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

describe('AuthenticatedFeedbackDock', () => {
  const originalMediaRecorder = globalThis.MediaRecorder
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCaptureArtifactProvidersForTests()
    window.history.pushState(null, '', '/projects/p1')
    window.sessionStorage.clear()
    window.localStorage.removeItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_REPLAY_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_AUDIO_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY)
    window.localStorage.removeItem(STEVE_COLLAB_MODE_STORAGE_KEY)
    rrweb.record.mockImplementation((options?: { emit?: (event: unknown) => void }) => {
      options?.emit?.({ type: 'rrweb-full-snapshot', data: { source: 'authenticated-test' } })
      return vi.fn()
    })
    captureApi.appendCaptureSessionEvents.mockResolvedValue({ accepted: 1 })
    captureApi.createCaptureSession.mockImplementation(async (payload: { capture_session_id: string }) => ({
      capture_session: {
        id: payload.capture_session_id,
        mode: 'feedback',
        status: 'open',
        started_at: '2026-05-31T12:00:00.000Z',
        last_seen_at: '2026-05-31T12:00:00.000Z',
      },
    }))
    captureApi.uploadCaptureArtifact.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        kind: 'audio',
        storage_key: 'co-1/capture-sessions/session-1/audio.webm',
        content_type: 'audio/webm',
        byte_size: 5,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })
    captureApi.finalizeCaptureSession.mockResolvedValue({
      work_item: {
        id: 'work-item-1',
        title: 'In-app feedback recording',
        summary: 'The Verify Scale button did nothing.',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/projects/p1',
        capture_session_id: 'capture-session-1',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
    })
    captureApi.discardCaptureSession.mockResolvedValue({
      capture_session: {
        id: 'capture-session-1',
        mode: 'feedback',
        status: 'discarded',
        started_at: '2026-05-31T12:00:00.000Z',
        last_seen_at: '2026-05-31T12:00:01.000Z',
      },
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => new FakeStream() as unknown as MediaStream) },
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    })
  })

  afterEach(() => {
    cleanup()
    __resetCaptureArtifactProvidersForTests()
    window.sessionStorage.clear()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: originalMediaRecorder,
    })
  })

  it('stays hidden until authenticated feedback capture is explicitly enabled', () => {
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    expect(screen.queryByRole('button', { name: /record feedback/i })).toBeNull()
  })

  it('records authenticated audio feedback and finalizes it into triage', async () => {
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.change(screen.getByPlaceholderText('What happened?'), {
      target: { value: 'The Verify Scale button did nothing.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
      metadata: Record<string, unknown>
    }
    expect(startPayload).toMatchObject({
      mode: 'feedback',
      consent_version: 'authenticated-feedback-v1',
      route_path: '/projects/p1',
      metadata: {
        surface: 'authenticated_app',
        company_slug: 'la-operations',
      },
      consent_scope: {
        surface: 'authenticated_app',
        streams: ['audio'],
        dom_replay: false,
      },
    })
    expect(screen.getByText('Recording feedback')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        kind: 'audio',
        fileName: 'audio.webm',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'record_feedback',
          surface: 'authenticated_app',
          company_slug: 'la-operations',
          mime_type: 'audio/webm',
        }),
      }),
    )
    expect(captureApi.finalizeCaptureSession).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        category: 'record_feedback',
        title: 'In-app feedback recording',
        summary: 'The Verify Scale button did nothing.',
        lane: 'triage',
        severity: 'normal',
      }),
    )
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
      expect.objectContaining({ event_type: 'authenticated.feedback.recording_started' }),
    ])
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
      expect.objectContaining({ event_type: 'authenticated.feedback.recording_stopped' }),
    ])
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('sends Steve text issues without requesting microphone access', async () => {
    window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
    window.localStorage.setItem(AUTH_FEEDBACK_AUDIO_STORAGE_KEY, '0')
    window.localStorage.setItem(STEVE_COLLAB_MODE_STORAGE_KEY, STEVE_COLLAB_MODE_VALUE)
    const provider = vi.fn(async () => ({ artifact: { id: 'screen-1', kind: 'screen_context' } }))
    registerCaptureArtifactProvider('screen:test', provider)
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /report issue/i }))
    fireEvent.change(screen.getByPlaceholderText('What is wrong?'), {
      target: { value: 'The project total is wrong after I change markup.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send issue/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
      metadata: Record<string, unknown>
    }
    expect(startPayload).toMatchObject({
      mode: 'feedback',
      consent_version: 'authenticated-feedback-v1',
      route_path: '/projects/p1',
      metadata: {
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        capture_profile: 'text_issue',
        collab_mode: 'steve',
      },
      consent_scope: {
        surface: 'authenticated_app',
        streams: ['text_note', 'registered_artifacts'],
        audio: false,
        dom_replay: false,
      },
    })
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    expect(provider).toHaveBeenCalledWith({
      captureSessionId: startPayload.capture_session_id,
      metadata: expect.objectContaining({
        source: 'text_issue',
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        collab_mode: 'steve',
        trigger: 'text_issue_submit',
      }),
    })
    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    expect(captureApi.finalizeCaptureSession).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        category: 'record_feedback',
        title: 'In-app issue report',
        summary: 'The project total is wrong after I change markup.',
        lane: 'triage',
        severity: 'normal',
      }),
    )
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
      expect.objectContaining({ event_type: 'authenticated.feedback.issue_submitted' }),
    ])
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('adds DOM replay only when authenticated replay is explicitly enabled', async () => {
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1&capture_replay=1')
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
    }
    expect(startPayload.consent_scope).toMatchObject({
      streams: ['audio', 'dom_replay'],
      dom_replay: true,
    })
    expect(rrweb.record).toHaveBeenCalledWith(
      expect.objectContaining({
        maskAllInputs: true,
        inlineImages: false,
        recordCanvas: false,
        recordCrossOriginIframes: false,
        emit: expect.any(Function),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledTimes(2))
    const replayCall = captureApi.uploadCaptureArtifact.mock.calls.find((call) => call[1]?.kind === 'rrweb')
    expect(replayCall).toBeDefined()
    expect(replayCall?.[0]).toBe(startPayload.capture_session_id)
    expect(replayCall?.[1]).toMatchObject({
      kind: 'rrweb',
      fileName: 'replay.json',
      pii_level: 'private',
      access_policy: 'support_only',
      metadata: expect.objectContaining({
        source: 'capture_replay_recorder',
        artifact_type: 'capture.rrweb_replay',
        schema_version: 1,
        event_count: 1,
        surface: 'authenticated_app',
        dom_replay: true,
      }),
    })
    await expect((replayCall?.[1]?.file as Blob).text().then(JSON.parse)).resolves.toMatchObject({
      artifact_type: 'capture.rrweb_replay',
      event_count: 1,
      events: [{ type: 'rrweb-full-snapshot', data: { source: 'authenticated-test' } }],
    })
  })

  it('uploads registered extra artifacts before finalizing', async () => {
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    const provider = vi.fn(async () => ({ artifact: { id: 'canvas-1', kind: 'canvas_geometry' } }))
    registerCaptureArtifactProvider('takeoff:test', provider)
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as { capture_session_id: string }

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    expect(provider).toHaveBeenCalledWith({
      captureSessionId: startPayload.capture_session_id,
      metadata: expect.objectContaining({
        source: 'record_feedback',
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        trigger: 'record_feedback_stop',
      }),
    })
    expect(provider.mock.invocationCallOrder[0]!).toBeLessThan(
      captureApi.finalizeCaptureSession.mock.invocationCallOrder[0]!,
    )
  })
})

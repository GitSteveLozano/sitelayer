import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureArtifactProvidersForTests,
  registerCaptureArtifactProvider,
} from '@/lib/capture-artifact-providers'
import { __resetCaptureStateProvidersForTests, registerCaptureStateProvider } from '@/lib/capture-state-providers'
import { CAPTURE_SESSION_STORAGE_KEY } from '@/lib/capture-session'
import { CAPTURE_LEVEL_STORAGE_KEY } from '@/lib/capture-level'
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

// P0 — identity-driven visibility. The dock reads the caller's PLATFORM
// app_issue.* capabilities off /api/session via this hook; the tests drive it
// directly so we can assert capability-gated visibility without a live API.
const appIssuesApi = vi.hoisted(() => ({
  capabilities: [] as string[],
  useAppIssueCapabilities: vi.fn(),
}))

vi.mock('@/lib/api/app-issues', () => ({
  useAppIssueCapabilities: appIssuesApi.useAppIssueCapabilities,
}))

// P1 — sticky receipt "Copy agent bundle" fetches the support packet's agent
// prompt; mocked so the action is exercised without a network call.
const supportPacketsApi = vi.hoisted(() => ({
  fetchSupportPacket: vi.fn(),
}))

vi.mock('@/lib/api/support-packets', () => supportPacketsApi)

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
  static supported = new Set(['audio/webm'])

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported.has(mimeType)
  }

  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

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
    vi.unstubAllEnvs()
    __resetCaptureArtifactProvidersForTests()
    __resetCaptureStateProvidersForTests()
    // Default: no platform app_issue capability. Tests that exercise visibility
    // set `appIssuesApi.capabilities` before render. The hook is a thin query
    // shim, so returning `{ data }` is enough for the dock's consumption.
    appIssuesApi.capabilities = []
    appIssuesApi.useAppIssueCapabilities.mockImplementation(() => ({ data: appIssuesApi.capabilities }))
    supportPacketsApi.fetchSupportPacket.mockResolvedValue({
      support_packet: { id: 'support-1' },
      agent_prompt: 'AGENT PROMPT for support-1',
    })
    window.history.pushState(null, '', '/projects/p1')
    window.sessionStorage.clear()
    window.localStorage.removeItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_REPLAY_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_AUDIO_STORAGE_KEY)
    window.localStorage.removeItem(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY)
    window.localStorage.removeItem(STEVE_COLLAB_MODE_STORAGE_KEY)
    window.localStorage.removeItem(CAPTURE_LEVEL_STORAGE_KEY)
    rrweb.record.mockImplementation((options?: { emit?: (event: unknown) => void }) => {
      options?.emit?.({ type: 'rrweb-full-snapshot', data: { source: 'authenticated-test' } })
      return vi.fn()
    })
    FakeMediaRecorder.supported = new Set(['audio/webm'])
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
    __resetCaptureStateProvidersForTests()
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
    // Default level is now 'note' (P1); dial up to 'audio' so the Start action
    // is offered (the level persists via localStorage, mirroring a user choice).
    window.localStorage.setItem(CAPTURE_LEVEL_STORAGE_KEY, 'audio')
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
        streams: ['audio', 'registered_artifacts', 'text_note'],
        artifacts: expect.objectContaining({
          audio: true,
          transcript: true,
          text_note: true,
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
        }),
        event_classes: ['authenticated_feedback'],
        audio: true,
        dom_replay: false,
        registered_artifacts: true,
        screen_video: false,
        text_note: true,
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
    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const prewarmPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      metadata: Record<string, unknown>
    }
    expect(prewarmPayload).toMatchObject({
      mode: 'feedback',
      consent_version: 'authenticated-feedback-v1',
      route_path: '/projects/p1',
      metadata: {
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        capture_profile: 'text_issue_prewarm',
        collab_mode: 'steve',
      },
      consent_scope: {
        surface: 'authenticated_app',
        streams: ['text_note', 'registered_artifacts'],
        artifacts: expect.objectContaining({
          text_note: true,
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
        }),
        event_classes: ['authenticated_feedback'],
        audio: false,
        dom_replay: false,
        registered_artifacts: true,
        screen_video: false,
        text_note: true,
      },
    })

    fireEvent.change(screen.getByPlaceholderText('What is wrong?'), {
      target: { value: 'The project total is wrong after I change markup.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send issue/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(2))
    const startPayload = captureApi.createCaptureSession.mock.calls[1]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
      metadata: Record<string, unknown>
    }
    expect(startPayload.capture_session_id).toBe(prewarmPayload.capture_session_id)
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
        artifacts: expect.objectContaining({
          text_note: true,
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
        }),
        event_classes: ['authenticated_feedback'],
        audio: false,
        dom_replay: false,
        registered_artifacts: true,
        screen_video: false,
        text_note: true,
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

  it('prewarms a Steve issue capture session when the dock auto-opens', async () => {
    window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
    window.localStorage.setItem(AUTH_FEEDBACK_AUDIO_STORAGE_KEY, '0')
    window.localStorage.setItem(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY, '1')
    window.localStorage.setItem(STEVE_COLLAB_MODE_STORAGE_KEY, STEVE_COLLAB_MODE_VALUE)
    const stateProvider = vi.fn(() => ({
      schema: 'test.route-state.v1',
      payload: { route: '/projects/p1', opened: true },
    }))
    registerCaptureStateProvider('route:opened', stateProvider)

    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    expect(captureApi.createCaptureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'feedback',
        consent_version: 'authenticated-feedback-v1',
        route_path: '/projects/p1',
        metadata: expect.objectContaining({
          surface: 'authenticated_app',
          company_slug: 'la-operations',
          capture_profile: 'text_issue_prewarm',
          collab_mode: 'steve',
        }),
        consent_scope: expect.objectContaining({
          streams: ['text_note', 'registered_artifacts'],
          artifacts: expect.objectContaining({
            text_note: true,
            canvas_geometry: true,
            screen_context: true,
            state_snapshot: true,
          }),
          event_classes: ['authenticated_feedback'],
          audio: false,
          dom_replay: false,
          registered_artifacts: true,
          screen_video: false,
          text_note: true,
        }),
      }),
    )
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ event_type: 'authenticated.feedback.issue_opened' }),
    ])
    await waitFor(() => expect(stateProvider).toHaveBeenCalledTimes(1))
    expect(stateProvider).toHaveBeenCalledWith({
      captureSessionId: expect.any(String),
      reason: 'issue_opened',
      metadata: expect.objectContaining({
        source: 'text_issue_prewarm',
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        collab_mode: 'steve',
        trigger: 'issue_opened',
      }),
    })
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(captureApi.finalizeCaptureSession).not.toHaveBeenCalled()
  })

  it('adds DOM replay only when authenticated replay is explicitly enabled', async () => {
    // Dial up to 'audio' (P1 default is 'note') so Start is offered; audio rung
    // includes the DOM replay below it.
    window.localStorage.setItem(CAPTURE_LEVEL_STORAGE_KEY, 'audio')
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1&capture_replay=1')
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
    }
    expect(startPayload.consent_scope).toMatchObject({
      streams: ['audio', 'dom_replay', 'registered_artifacts', 'text_note'],
      artifacts: expect.objectContaining({
        audio: true,
        transcript: true,
        rrweb: true,
      }),
      audio: true,
      dom_replay: true,
      registered_artifacts: true,
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

  it('records optional screen video through the browser screen picker', async () => {
    // Dial up to 'screen' (P1 default is 'note') so the Record screen action is
    // offered. The level clamps to device caps, which include video here.
    window.localStorage.setItem(CAPTURE_LEVEL_STORAGE_KEY, 'screen')
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1&capture_audio=0')
    FakeMediaRecorder.supported = new Set(['video/webm'])
    const getUserMedia = vi.fn()
    const getDisplayMedia = vi.fn(async () => new FakeStream() as unknown as MediaStream)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        getDisplayMedia,
      },
    })
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.change(screen.getByPlaceholderText('What happened?'), {
      target: { value: 'The invoice drawer flickered while I shared the tab.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /record screen/i }))

    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false }))
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
        capture_profile: 'screen_recording',
      },
      consent_scope: {
        surface: 'authenticated_app',
        streams: ['screen_video', 'text_note', 'registered_artifacts'],
        artifacts: expect.objectContaining({
          video: true,
          video_clip_manifest: true,
          text_note: true,
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
        }),
        event_classes: ['authenticated_feedback'],
        audio: false,
        dom_replay: false,
        screen_video: true,
        registered_artifacts: true,
        text_note: true,
      },
    })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(screen.getByText('Recording screen')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledTimes(2))
    expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        kind: 'video',
        fileName: 'screen-video.webm',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'screen_recording',
          artifact_type: 'capture.screen_video',
          surface: 'authenticated_app',
          company_slug: 'la-operations',
          mime_type: 'video/webm',
        }),
      }),
    )
    expect(captureApi.uploadCaptureArtifact).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        kind: 'video_clip_manifest',
        fileName: 'video-clip-manifest.json',
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'screen_recording',
          artifact_type: 'capture.video_clip_manifest',
          surface: 'authenticated_app',
          company_slug: 'la-operations',
        }),
      }),
    )
    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    expect(captureApi.finalizeCaptureSession).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({
        category: 'record_feedback',
        title: 'In-app screen recording',
        summary: 'The invoice drawer flickered while I shared the tab.',
        lane: 'triage',
        severity: 'normal',
      }),
    )
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
      expect.objectContaining({ event_type: 'authenticated.feedback.screen_recording_started' }),
    ])
    expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
      expect.objectContaining({ event_type: 'authenticated.feedback.screen_recording_stopped' }),
    ])
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('lets Steve start a reproduction even with the text-issue prewarm active', async () => {
    // Regression: the Steve dock auto-opens and prewarms an (idle) text-issue
    // feedback session. The start-guard must not mistake that for an active
    // recording, or "Reproduce a bug" / "Start" / "Record screen" are blocked
    // in the primary Steve path with a false "Recording is already active."
    window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
    window.localStorage.setItem(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY, '1')
    window.localStorage.setItem(STEVE_COLLAB_MODE_STORAGE_KEY, STEVE_COLLAB_MODE_VALUE)
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const prewarm = captureApi.createCaptureSession.mock.calls[0]?.[0] as { metadata: Record<string, unknown> }
    expect(prewarm.metadata).toMatchObject({ capture_profile: 'text_issue_prewarm' })

    fireEvent.click(screen.getByRole('button', { name: /reproduce a bug/i }))

    // The reproduction starts (a 2nd session with repro consent) instead of erroring.
    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(2))
    const reproPayload = captureApi.createCaptureSession.mock.calls[1]?.[0] as {
      consent_scope: Record<string, unknown>
    }
    expect(reproPayload.consent_scope).toMatchObject({
      artifacts: expect.objectContaining({ repro_bracket: true }),
      event_classes: expect.arrayContaining(['repro']),
    })
    expect(screen.getByText('Reproducing a bug')).toBeTruthy()
    expect(screen.queryByText('Recording is already active.')).toBeNull()
  })

  it('brackets a reproduction with start/end conditions, a mark, and a repro_bracket artifact', async () => {
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /reproduce a bug/i }))

    // Start condition: one feedback session whose consent scope opts into the
    // repro_bracket artifact + the repro event class.
    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as {
      capture_session_id: string
      consent_scope: Record<string, unknown>
    }
    expect(startPayload.consent_scope).toMatchObject({
      artifacts: expect.objectContaining({ repro_bracket: true }),
      event_classes: expect.arrayContaining(['repro']),
    })
    await waitFor(() =>
      expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
        expect.objectContaining({ event_type: 'repro.bracket_started', event_class: 'repro' }),
      ]),
    )
    expect(screen.getByText('Reproducing a bug')).toBeTruthy()

    // Mark a moment with a typed label ("the bug is here").
    fireEvent.change(screen.getByPlaceholderText('Label this moment (optional)'), {
      target: { value: 'total is wrong here' },
    })
    fireEvent.click(screen.getByRole('button', { name: /mark this moment/i }))
    await waitFor(() =>
      expect(captureApi.appendCaptureSessionEvents).toHaveBeenCalledWith(startPayload.capture_session_id, [
        expect.objectContaining({
          event_type: 'repro.mark',
          event_class: 'repro',
          payload: expect.objectContaining({ label: 'total is wrong here' }),
        }),
      ]),
    )

    // End condition + report.
    fireEvent.change(screen.getByPlaceholderText('What went wrong? (the end condition)'), {
      target: { value: 'The estimate total doubled after I changed markup.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /end & report/i }))

    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    const reproArtifactCall = captureApi.uploadCaptureArtifact.mock.calls.find(
      (call) => call[1]?.kind === 'repro_bracket',
    )
    expect(reproArtifactCall).toBeDefined()
    expect(reproArtifactCall?.[0]).toBe(startPayload.capture_session_id)
    const reproSummary = JSON.parse(await (reproArtifactCall?.[1]?.file as Blob).text())
    expect(reproSummary).toMatchObject({
      artifact_type: 'capture.repro_bracket',
      end_condition: { note: 'The estimate total doubled after I changed markup.' },
    })
    expect(reproSummary.marks).toHaveLength(1)
    expect(captureApi.finalizeCaptureSession).toHaveBeenCalledWith(
      startPayload.capture_session_id,
      expect.objectContaining({ category: 'reproduction', title: 'Reproduction report' }),
    )
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('uploads registered extra artifacts before finalizing', async () => {
    // Dial up to 'audio' (P1 default is 'note') so the Start action is offered.
    window.localStorage.setItem(CAPTURE_LEVEL_STORAGE_KEY, 'audio')
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    const provider = vi.fn(async () => ({ artifact: { id: 'canvas-1', kind: 'canvas_geometry' } }))
    registerCaptureArtifactProvider('takeoff:test', provider)
    const stateProvider = vi.fn(() => ({
      schema: 'test.route-state.v1',
      payload: { route: '/projects/p1', state: 'drawing' },
    }))
    registerCaptureStateProvider('route:test', stateProvider)
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(captureApi.createCaptureSession).toHaveBeenCalledTimes(1))
    const startPayload = captureApi.createCaptureSession.mock.calls[0]?.[0] as { capture_session_id: string }

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(stateProvider).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    expect(stateProvider).toHaveBeenCalledWith({
      captureSessionId: startPayload.capture_session_id,
      reason: 'recording_stopped',
      metadata: expect.objectContaining({
        source: 'record_feedback',
        surface: 'authenticated_app',
        company_slug: 'la-operations',
        trigger: 'record_feedback_stop',
      }),
    })
    const stateSnapshotCall = captureApi.uploadCaptureArtifact.mock.calls.find(
      (call) => call[1]?.kind === 'state_snapshot',
    )
    expect(stateSnapshotCall).toBeDefined()
    expect(stateSnapshotCall?.[0]).toBe(startPayload.capture_session_id)
    expect(stateSnapshotCall?.[1]).toMatchObject({
      kind: 'state_snapshot',
      fileName: 'route-test-state_snapshot.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: expect.objectContaining({
        source: 'capture_state_provider',
        artifact_type: 'capture.state_snapshot',
        provider_id: 'route:test',
        reason: 'recording_stopped',
        schema: 'test.route-state.v1',
      }),
    })
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

  // P0 — IDENTITY-DRIVEN VISIBILITY. In prod the dock is shown iff the signed-in
  // user holds `app_issue.capture`; the URL/env/localStorage flag is a non-prod
  // dev override only. The predicate reads app_issue.capture, NEVER field_request.
  describe('identity-driven visibility', () => {
    it('PROD: hidden for a user WITHOUT app_issue.capture even with the legacy flag set', () => {
      vi.stubEnv('MODE', 'production')
      window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
      window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
      appIssuesApi.capabilities = ['app_issue.view'] // a non-capture cap must not show the dock
      render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

      expect(screen.queryByRole('button', { name: /report issue|record feedback/i })).toBeNull()
    })

    it('PROD: shown for a user WHO HOLDS app_issue.capture (no flag needed)', () => {
      vi.stubEnv('MODE', 'production')
      appIssuesApi.capabilities = ['app_issue.capture']
      render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

      expect(screen.getByRole('button', { name: /record feedback/i })).toBeTruthy()
    })

    it('does NOT key off any field_request capability', () => {
      vi.stubEnv('MODE', 'production')
      appIssuesApi.capabilities = ['field_request.create', 'field_request.view', 'field_request.triage']
      render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

      expect(screen.queryByRole('button', { name: /report issue|record feedback/i })).toBeNull()
    })

    it('NON-PROD: still forced on by the legacy flag without any capability', () => {
      // MODE defaults to 'test' under vitest → non-prod → the dev override applies.
      window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
      appIssuesApi.capabilities = []
      render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

      expect(screen.getByRole('button', { name: /record feedback/i })).toBeTruthy()
    })
  })

  // P1 — DEFAULT CAPTURE LEVEL = 'note'. The 2-tap text floor must not imply a
  // recording/permission step, so the capture level defaults to 'note'.
  it('defaults the capture level to "note" so the text floor has no permission step', () => {
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    const select = screen.getByLabelText('Recording level') as HTMLSelectElement
    expect(select.value).toBe('note')
    // The audio "Start" / "Record screen" actions are not offered at the floor.
    expect(screen.queryByRole('button', { name: /^start$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /record screen/i })).toBeNull()
    // Text + repro (no-prompt) paths are always present.
    expect(screen.getByRole('button', { name: /send issue/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /reproduce a bug/i })).toBeTruthy()
  })

  // P1 — PERSISTENT RECEIPT + actions. After sending, a sticky card keeps the
  // ids, offers "View issue" + "Copy agent bundle", and does NOT auto-dismiss.
  it('shows a sticky receipt with View issue + Copy agent bundle after a text issue', async () => {
    window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
    window.history.pushState(null, '', '/projects/p1?capture_feedback=1')
    const clipboard = { writeText: vi.fn(async () => undefined) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    supportPacketsApi.fetchSupportPacket.mockResolvedValue({
      support_packet: { id: 'support-9' },
      agent_prompt: 'AGENT PROMPT for support-9',
    })
    captureApi.finalizeCaptureSession.mockResolvedValueOnce({
      work_item: {
        id: 'work-item-9',
        title: 'In-app issue report',
        summary: 'x',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/projects/p1',
        capture_session_id: 'capture-session-9',
      },
      support_packet: { id: 'support-9', expires_at: null },
      event: null,
    })
    render(<AuthenticatedFeedbackDock companySlug="la-operations" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.change(screen.getByPlaceholderText('What happened?'), {
      target: { value: 'The estimate total is wrong.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send issue/i }))

    await waitFor(() => expect(captureApi.finalizeCaptureSession).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Issue sent')).toBeTruthy())
    expect(screen.getByText(/support packet support-9 · work item work-item-9/i)).toBeTruthy()

    // "View issue" points at the internal /issues board entry for the work item.
    const viewIssue = screen.getByRole('link', { name: /view issue/i }) as HTMLAnchorElement
    expect(viewIssue.getAttribute('href')).toBe('/issues/work-item-9')

    // "Copy agent bundle" fetches the support packet's agent_prompt + copies it.
    fireEvent.click(screen.getByRole('button', { name: /copy agent bundle/i }))
    await waitFor(() => expect(supportPacketsApi.fetchSupportPacket).toHaveBeenCalledWith('support-9'))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('AGENT PROMPT for support-9'))
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy())
  })
})

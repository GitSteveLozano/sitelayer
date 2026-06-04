import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureStateProvidersForTests,
  registerCaptureStateProvider,
} from '@/lib/capture-state-providers'
import { FeedbackInviteEntry } from './FeedbackInviteEntry'

const api = vi.hoisted(() => {
  class PortalApiError extends Error {
    readonly status = 500
    readonly path = '/api/test'
    readonly body = null

    message_for_user(): string {
      return this.message
    }
  }

  return {
    PortalApiError,
    appendFeedbackInviteCaptureEvents: vi.fn(),
    discardFeedbackInviteCaptureSession: vi.fn(),
    finalizeFeedbackInviteCaptureSession: vi.fn(),
    resolveFeedbackInvite: vi.fn(),
    startFeedbackInviteCaptureSession: vi.fn(),
    uploadFeedbackInviteCaptureArtifact: vi.fn(),
  }
})

vi.mock('@/portal/api', () => api)

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
  static instances: FakeMediaRecorder[] = []

  static isTypeSupported(mimeType: string): boolean {
    return mimeType.includes('webm')
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
    this.mimeType = options?.mimeType ?? 'video/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    const payload = this.mimeType.startsWith('audio/') ? 'voice' : 'screen-video'
    this.ondataavailable?.({ data: new Blob([payload], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

describe('FeedbackInviteEntry', () => {
  const originalMediaRecorder = globalThis.MediaRecorder
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    cleanup()
    window.history.pushState(null, '', '/feedback?token=feedback.token')
    window.localStorage.clear()
    window.sessionStorage.clear()
    FakeMediaRecorder.instances = []
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => new FakeStream() as unknown as MediaStream),
        getDisplayMedia: vi.fn(async () => new FakeStream() as unknown as MediaStream),
      },
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    })
    api.resolveFeedbackInvite.mockResolvedValue({
      invite: {
        id: 'invite-1',
        company_slug: 'la-ops',
        company_name: 'LA Ops',
        reviewer_ref: 'steve',
        source: 'settings_external_reviewer',
        target_route: '/desktop',
        allowed_capture_modes: ['text', 'state', 'audio', 'screen'],
        expires_at: '2026-06-18T12:00:00.000Z',
      },
    })
    api.startFeedbackInviteCaptureSession.mockImplementation(
      async (_token: string, payload: { capture_session_id: string }) => ({
        capture_session: {
          id: payload.capture_session_id,
          mode: 'feedback',
          status: 'open',
          started_at: '2026-06-04T12:00:00.000Z',
          last_seen_at: '2026-06-04T12:00:00.000Z',
        },
      }),
    )
    api.appendFeedbackInviteCaptureEvents.mockResolvedValue({ accepted: 1 })
    api.uploadFeedbackInviteCaptureArtifact.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        kind: 'state_snapshot',
        storage_key: 'co-1/capture-sessions/session-1/state.json',
        content_type: 'application/json',
        byte_size: 10,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })
    api.finalizeFeedbackInviteCaptureSession.mockResolvedValue({
      work_item: {
        id: 'work-item-123456',
        title: 'The takeoff total looks wrong.',
        summary: 'The takeoff total looks wrong.',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/desktop',
        capture_session_id: 'capture-session-1',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
    })
    api.discardFeedbackInviteCaptureSession.mockResolvedValue({
      capture_session: {
        id: 'capture-session-1',
        mode: 'feedback',
        status: 'discarded',
        started_at: '2026-06-04T12:00:00.000Z',
        last_seen_at: '2026-06-04T12:00:01.000Z',
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCaptureStateProvidersForTests()
    window.localStorage.clear()
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

  it('strips the token and submits a text issue with an opted-in state snapshot', async () => {
    registerCaptureStateProvider('route:feedback-test', ({ metadata, reason }) => ({
      schema: 'feedback.route-state.v1',
      payload: {
        route: metadata.route_path,
        reason,
        token: 'do-not-serialize',
        visible_state: 'board-column-open',
      },
      metadata: { route_state: true },
    }))

    render(<FeedbackInviteEntry />)

    await screen.findByRole('heading', { name: 'Submit feedback' })

    expect(api.resolveFeedbackInvite).toHaveBeenCalledWith('feedback.token')
    expect(window.location.href).not.toContain('token=')

    fireEvent.change(screen.getByPlaceholderText('What should we fix?'), {
      target: { value: 'The takeoff total looks wrong.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /submit issue/i }))

    await waitFor(() => expect(api.startFeedbackInviteCaptureSession).toHaveBeenCalledTimes(1))
    const startCall = api.startFeedbackInviteCaptureSession.mock.calls[0]
    expect(startCall?.[0]).toBe('feedback.token')
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id
    expect(startCall?.[1]).toMatchObject({
      mode: 'feedback',
      consent_version: 'feedback-invite-v1',
      route_path: '/desktop',
      metadata: {
        source: 'feedback_invite_page',
        reviewer_ref: 'steve',
        target_route: '/desktop',
      },
      consent_scope: {
        surface: 'feedback_invite',
        allowed_capture_modes: ['text', 'state', 'audio', 'screen'],
        selected_capture_modes: ['text', 'state'],
        streams: ['text_note', 'registered_artifacts'],
        text_issue: true,
        artifacts: expect.objectContaining({
          text_note: true,
          state_snapshot: true,
          audio: false,
          video: false,
        }),
      },
    })

    await waitFor(() => expect(api.uploadFeedbackInviteCaptureArtifact).toHaveBeenCalledTimes(2))
    expect(api.uploadFeedbackInviteCaptureArtifact).toHaveBeenCalledWith(
      'feedback.token',
      captureSessionId,
      expect.objectContaining({
        kind: 'state_snapshot',
        fileName: 'feedback-invite-state.json',
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'feedback_invite_page',
          artifact_type: 'capture.state_snapshot',
          trigger: 'text_issue_submit',
          feedback_invite_id: 'invite-1',
          route_path: '/desktop',
        }),
      }),
    )
    await expect((api.uploadFeedbackInviteCaptureArtifact.mock.calls[0]?.[2]?.file as Blob).text().then(JSON.parse))
      .resolves.toMatchObject({
        artifact_type: 'capture.state_snapshot',
        capture_session_id: captureSessionId,
        route_path: '/desktop',
        invite: {
          id: 'invite-1',
          company_slug: 'la-ops',
          reviewer_ref: 'steve',
          target_route: '/desktop',
          allowed_capture_modes: ['text', 'state', 'audio', 'screen'],
        },
        form: { note_length: 30 },
      })

    const providerCall = api.uploadFeedbackInviteCaptureArtifact.mock.calls.find(
      (call) => call[2]?.metadata?.provider_id === 'route:feedback-test',
    )
    expect(providerCall).toBeDefined()
    expect(providerCall?.[0]).toBe('feedback.token')
    expect(providerCall?.[1]).toBe(captureSessionId)
    expect(providerCall?.[2]).toMatchObject({
      kind: 'state_snapshot',
      fileName: 'route-feedback-test-state_snapshot.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: expect.objectContaining({
        source: 'capture_state_provider',
        surface: 'feedback_invite',
        trigger: 'text_issue_submit',
        provider_id: 'route:feedback-test',
        schema: 'feedback.route-state.v1',
        route_state: true,
      }),
    })
    const providerBody = JSON.parse(await (providerCall?.[2]?.file as Blob).text()) as Record<string, unknown>
    expect(providerBody).toMatchObject({
      artifact_type: 'capture.state_snapshot',
      provider_id: 'route:feedback-test',
      reason: 'issue_submitted',
      schema: 'feedback.route-state.v1',
      payload: {
        route: '/desktop',
        reason: 'issue_submitted',
        visible_state: 'board-column-open',
      },
    })
    expect(JSON.stringify(providerBody)).not.toContain('do-not-serialize')

    await waitFor(() => expect(api.finalizeFeedbackInviteCaptureSession).toHaveBeenCalledTimes(1))
    expect(api.finalizeFeedbackInviteCaptureSession).toHaveBeenCalledWith(
      'feedback.token',
      captureSessionId,
      expect.objectContaining({
        title: 'The takeoff total looks wrong.',
        summary: 'The takeoff total looks wrong.',
        severity: 'normal',
        route_path: '/desktop',
        category: 'feedback_invite',
        client_request_id: `feedback_invite:invite-1:${captureSessionId}`,
      }),
    )
    expect(screen.getByText('Sent')).toBeTruthy()
  })

  it('records screen feedback only after the invite and browser both allow it', async () => {
    render(<FeedbackInviteEntry />)

    await screen.findByRole('button', { name: /record screen/i })
    fireEvent.change(screen.getByPlaceholderText('What should we fix?'), {
      target: { value: 'The board dragged the card into the wrong lane.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /record screen/i }))

    await waitFor(() => expect(api.startFeedbackInviteCaptureSession).toHaveBeenCalledTimes(1))
    const startCall = api.startFeedbackInviteCaptureSession.mock.calls[0]
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id
    expect(startCall?.[1]).toMatchObject({
      route_path: '/desktop',
      metadata: {
        source: 'feedback_invite_page',
        capture_profile: 'screen_recording',
        reviewer_ref: 'steve',
        target_route: '/desktop',
      },
      consent_scope: {
        selected_capture_modes: ['text', 'screen', 'state'],
        streams: ['text_note', 'screen_video', 'registered_artifacts'],
        screen_video: true,
        registered_artifacts: true,
        artifacts: expect.objectContaining({
          video: true,
          video_clip_manifest: true,
          state_snapshot: true,
        }),
      },
    })
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false })
    expect(screen.getByRole('button', { name: /stop and submit screen/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /stop and submit screen/i }))

    await waitFor(() => expect(api.uploadFeedbackInviteCaptureArtifact).toHaveBeenCalledTimes(2))
    expect(api.uploadFeedbackInviteCaptureArtifact).toHaveBeenCalledWith(
      'feedback.token',
      captureSessionId,
      expect.objectContaining({
        kind: 'video',
        fileName: 'screen-video.webm',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'feedback_invite_page',
          capture_profile: 'screen_recording',
          artifact_type: 'capture.screen_video',
          feedback_invite_id: 'invite-1',
          mime_type: 'video/webm;codecs=vp9,opus',
        }),
      }),
    )
    expect(api.uploadFeedbackInviteCaptureArtifact).toHaveBeenCalledWith(
      'feedback.token',
      captureSessionId,
      expect.objectContaining({ kind: 'state_snapshot' }),
    )
    await waitFor(() => expect(api.finalizeFeedbackInviteCaptureSession).toHaveBeenCalledTimes(1))
    expect(api.finalizeFeedbackInviteCaptureSession).toHaveBeenCalledWith(
      'feedback.token',
      captureSessionId,
      expect.objectContaining({
        title: 'The board dragged the card into the wrong lane.',
        summary: 'The board dragged the card into the wrong lane.',
        category: 'feedback_invite',
        route_path: '/desktop',
      }),
    )
  })
})

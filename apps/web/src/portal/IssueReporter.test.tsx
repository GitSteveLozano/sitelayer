import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_SESSION_STORAGE_KEY } from '@/lib/capture-session'
import { __resetCaptureStateProvidersForTests, registerCaptureStateProvider } from '@/lib/capture-state-providers'
import { IssueReporter } from './IssueReporter'

const api = vi.hoisted(() => ({
  appendPortalEstimateCaptureEvents: vi.fn(),
  appendPortalRentalCaptureEvents: vi.fn(),
  discardPortalEstimateCaptureSession: vi.fn(),
  discardPortalRentalCaptureSession: vi.fn(),
  finalizePortalEstimateCaptureSession: vi.fn(),
  finalizePortalRentalCaptureSession: vi.fn(),
  startPortalEstimateCaptureSession: vi.fn(),
  startPortalRentalCaptureSession: vi.fn(),
  uploadPortalEstimateCaptureArtifact: vi.fn(),
  uploadPortalRentalCaptureArtifact: vi.fn(),
}))

vi.mock('./api', () => api)

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
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(mimeType: string): boolean {
    return mimeType === 'audio/webm'
  }

  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly stream: MediaStream) {
    FakeMediaRecorder.instances.push(this)
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

describe('IssueReporter', () => {
  const originalMediaRecorder = globalThis.MediaRecorder
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    cleanup()
    window.history.pushState(null, '', '/portal/estimates/share-token')
    window.sessionStorage.clear()
    FakeMediaRecorder.instances = []
    rrweb.record.mockReset()
    rrweb.record.mockImplementation((options?: { emit?: (event: unknown) => void }) => {
      options?.emit?.({ type: 'rrweb-full-snapshot', data: { source: 'portal-test' } })
      return vi.fn()
    })
    api.appendPortalEstimateCaptureEvents.mockResolvedValue({ accepted: 1 })
    api.appendPortalRentalCaptureEvents.mockResolvedValue({ accepted: 1 })
    api.discardPortalEstimateCaptureSession.mockResolvedValue({
      capture_session: {
        id: '00000000-0000-4000-8000-000000000123',
        mode: 'feedback',
        status: 'discarded',
        started_at: '2026-05-31T12:00:00.000Z',
        last_seen_at: '2026-05-31T12:00:01.000Z',
      },
    })
    api.discardPortalRentalCaptureSession.mockResolvedValue({
      capture_session: {
        id: '00000000-0000-4000-8000-000000000123',
        mode: 'feedback',
        status: 'discarded',
        started_at: '2026-05-31T12:00:00.000Z',
        last_seen_at: '2026-05-31T12:00:01.000Z',
      },
    })
    api.startPortalEstimateCaptureSession.mockImplementation(
      async (_shareToken: string, payload: { capture_session_id: string }) => ({
        capture_session: {
          id: payload.capture_session_id,
          mode: 'feedback',
          status: 'open',
          started_at: '2026-05-31T12:00:00.000Z',
          last_seen_at: '2026-05-31T12:00:00.000Z',
        },
      }),
    )
    api.startPortalRentalCaptureSession.mockImplementation(
      async (_shareToken: string, payload: { capture_session_id: string }) => ({
        capture_session: {
          id: payload.capture_session_id,
          mode: 'feedback',
          status: 'open',
          started_at: '2026-05-31T12:00:00.000Z',
          last_seen_at: '2026-05-31T12:00:00.000Z',
        },
      }),
    )
    api.uploadPortalEstimateCaptureArtifact.mockResolvedValue({
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
    api.uploadPortalRentalCaptureArtifact.mockResolvedValue({
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
    api.finalizePortalEstimateCaptureSession.mockResolvedValue({
      work_item: {
        id: 'work-item-1',
        title: 'Portal feedback recording',
        summary: 'The quote total looks wrong.',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/portal/estimates/share-token',
        capture_session_id: 'capture-session-1',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
    })
    api.finalizePortalRentalCaptureSession.mockResolvedValue({
      work_item: {
        id: 'work-item-1',
        title: 'Portal feedback recording',
        summary: 'The rental dates look wrong.',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/portal/rentals/share-token',
        capture_session_id: 'capture-session-1',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
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
    vi.clearAllMocks()
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

  it('stays hidden on public links without an explicit capture invite', () => {
    render(<IssueReporter surface="estimate_portal" shareToken="share-token" />)

    expect(screen.queryByRole('button', { name: /record feedback/i })).toBeNull()
  })

  it('records invited estimate-portal feedback and finalizes it through public helpers', async () => {
    window.history.pushState(null, '', '/portal/estimates/share-token?capture_invite=invite-1')
    render(<IssueReporter surface="estimate_portal" shareToken="share-token" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.change(screen.getByPlaceholderText('What should we look at?'), {
      target: { value: 'The quote total looks wrong.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(api.startPortalEstimateCaptureSession).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Recording feedback')).toBeTruthy()

    const startCall = api.startPortalEstimateCaptureSession.mock.calls[0]
    expect(startCall).toBeTruthy()
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(api.uploadPortalEstimateCaptureArtifact).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.finalizePortalEstimateCaptureSession).toHaveBeenCalledTimes(1))

    expect(api.uploadPortalEstimateCaptureArtifact).toHaveBeenCalledWith(
      'share-token',
      captureSessionId,
      expect.objectContaining({
        kind: 'audio',
        fileName: 'audio.webm',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'record_feedback',
          portal_surface: 'estimate_portal',
          mime_type: 'audio/webm',
        }),
      }),
    )
    expect(api.finalizePortalEstimateCaptureSession).toHaveBeenCalledWith(
      'share-token',
      captureSessionId,
      expect.objectContaining({
        category: 'record_feedback',
        severity: 'normal',
        summary: 'The quote total looks wrong.',
      }),
    )
    expect(api.appendPortalEstimateCaptureEvents).toHaveBeenCalledWith('share-token', captureSessionId, [
      expect.objectContaining({ event_type: 'portal.feedback.recording_started' }),
    ])
    expect(api.appendPortalEstimateCaptureEvents).toHaveBeenCalledWith('share-token', captureSessionId, [
      expect.objectContaining({ event_type: 'portal.feedback.recording_stopped' }),
    ])
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('adds a DOM replay artifact only when capture replay is explicitly enabled', async () => {
    window.history.pushState(null, '', '/portal/estimates/share-token?capture_invite=invite-1&capture_replay=1')
    render(<IssueReporter surface="estimate_portal" shareToken="share-token" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(api.startPortalEstimateCaptureSession).toHaveBeenCalledTimes(1))
    const startCall = api.startPortalEstimateCaptureSession.mock.calls[0]
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id
    expect(startCall?.[1]).toMatchObject({
      consent_scope: {
        portal_surface: 'estimate_portal',
        streams: ['audio', 'dom_replay', 'registered_artifacts'],
        artifacts: expect.objectContaining({
          audio: true,
          transcript: true,
          rrweb: true,
          canvas_geometry: true,
          screen_context: true,
          state_snapshot: true,
        }),
        event_classes: ['portal_feedback'],
        audio: true,
        dom_replay: true,
        registered_artifacts: true,
        screen_video: false,
        text_note: false,
      },
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

    await waitFor(() => expect(api.uploadPortalEstimateCaptureArtifact).toHaveBeenCalledTimes(2))
    const replayCall = api.uploadPortalEstimateCaptureArtifact.mock.calls.find((call) => call[2]?.kind === 'rrweb')
    expect(replayCall).toBeDefined()
    expect(replayCall?.[0]).toBe('share-token')
    expect(replayCall?.[1]).toBe(captureSessionId)
    expect(replayCall?.[2]).toMatchObject({
      kind: 'rrweb',
      fileName: 'replay.json',
      pii_level: 'private',
      access_policy: 'support_only',
      metadata: expect.objectContaining({
        source: 'capture_replay_recorder',
        artifact_type: 'capture.rrweb_replay',
        schema_version: 1,
        event_count: 1,
        portal_surface: 'estimate_portal',
        dom_replay: true,
      }),
    })
    await expect((replayCall?.[2]?.file as Blob).text().then(JSON.parse)).resolves.toMatchObject({
      artifact_type: 'capture.rrweb_replay',
      event_count: 1,
      events: [{ type: 'rrweb-full-snapshot', data: { source: 'portal-test' } }],
    })
    await waitFor(() => expect(api.finalizePortalEstimateCaptureSession).toHaveBeenCalledTimes(1))
  })

  it('uploads public portal state providers through the token-bound portal artifact route', async () => {
    registerCaptureStateProvider('portal:estimate-test', ({ metadata, reason }) => ({
      schema: 'portal.estimate-state.v1',
      payload: {
        surface: metadata.portal_surface,
        reason,
        token: 'do-not-serialize',
        visible_state: 'acceptance-panel-open',
      },
      metadata: { portal_state: true },
    }))
    window.history.pushState(null, '', '/portal/estimates/share-token?capture_invite=invite-1')
    render(<IssueReporter surface="estimate_portal" shareToken="share-token" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(api.startPortalEstimateCaptureSession).toHaveBeenCalledTimes(1))
    const startCall = api.startPortalEstimateCaptureSession.mock.calls[0]
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    await waitFor(() => expect(api.uploadPortalEstimateCaptureArtifact).toHaveBeenCalledTimes(2))
    const stateCall = api.uploadPortalEstimateCaptureArtifact.mock.calls.find(
      (call) => call[2]?.metadata?.provider_id === 'portal:estimate-test',
    )
    expect(stateCall).toBeDefined()
    expect(stateCall?.[0]).toBe('share-token')
    expect(stateCall?.[1]).toBe(captureSessionId)
    expect(stateCall?.[2]).toMatchObject({
      kind: 'state_snapshot',
      fileName: 'portal-estimate-test-state_snapshot.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: expect.objectContaining({
        source: 'capture_state_provider',
        artifact_type: 'capture.state_snapshot',
        provider_id: 'portal:estimate-test',
        reason: 'recording_stopped',
        schema: 'portal.estimate-state.v1',
        portal_surface: 'estimate_portal',
        portal_state: true,
      }),
    })
    const stateBody = JSON.parse(await (stateCall?.[2]?.file as Blob).text()) as Record<string, unknown>
    expect(stateBody).toMatchObject({
      artifact_type: 'capture.state_snapshot',
      provider_id: 'portal:estimate-test',
      reason: 'recording_stopped',
      payload: {
        surface: 'estimate_portal',
        reason: 'recording_stopped',
        visible_state: 'acceptance-panel-open',
      },
    })
    expect(JSON.stringify(stateBody)).not.toContain('do-not-serialize')
  })

  it('discards an active portal capture session on the server before clearing local state', async () => {
    window.history.pushState(null, '', '/portal/estimates/share-token?capture_invite=invite-1')
    render(<IssueReporter surface="estimate_portal" shareToken="share-token" />)

    fireEvent.click(screen.getByRole('button', { name: /record feedback/i }))
    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(api.startPortalEstimateCaptureSession).toHaveBeenCalledTimes(1))
    const startCall = api.startPortalEstimateCaptureSession.mock.calls[0]
    const captureSessionId = (startCall?.[1] as { capture_session_id: string }).capture_session_id
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toContain(captureSessionId)

    fireEvent.click(screen.getByRole('button', { name: /discard/i }))

    await waitFor(() =>
      expect(api.discardPortalEstimateCaptureSession).toHaveBeenCalledWith('share-token', captureSessionId),
    )
    expect(api.uploadPortalEstimateCaptureArtifact).not.toHaveBeenCalled()
    expect(api.finalizePortalEstimateCaptureSession).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)).toBeNull()
  })
})

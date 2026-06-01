import { describe, expect, it, vi } from 'vitest'
import {
  FeedbackCaptureController,
  FeedbackCaptureQueuedError,
  type FeedbackCaptureBackend,
} from './feedback-capture-controller'

function backend(): FeedbackCaptureBackend & {
  startSession: ReturnType<typeof vi.fn>
  uploadArtifact: ReturnType<typeof vi.fn>
  finalizeSession: ReturnType<typeof vi.fn>
  discardSession: ReturnType<typeof vi.fn>
} {
  return {
    startSession: vi.fn(async (payload) => ({
      capture_session: {
        id: payload.capture_session_id,
        mode: payload.mode,
        status: 'open',
        started_at: '2026-05-31T12:00:00.000Z',
        last_seen_at: '2026-05-31T12:00:00.000Z',
      },
    })),
    uploadArtifact: vi.fn(async (_captureSessionId, input) => ({
      artifact: {
        id: `${input.kind}-artifact-1`,
        kind: input.kind,
        storage_key: `co-1/capture-sessions/session-1/${input.fileName ?? input.kind}`,
        content_type: input.file.type || 'application/octet-stream',
        byte_size: input.file.size,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })),
    finalizeSession: vi.fn(async () => ({
      work_item: {
        id: 'work-item-1',
        title: 'Portal issue',
        summary: 'Customer narrated the issue.',
        status: 'new',
        lane: 'triage',
        severity: 'high',
        route: null,
        capture_session_id: '00000000-0000-4000-8000-000000000123',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
    })),
    discardSession: vi.fn(async () => undefined),
  }
}

function audioRecorder() {
  return {
    isRecording: false,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      blob: new Blob(['voice'], { type: 'audio/webm' }),
      duration_ms: 1400,
      mime_type: 'audio/webm',
    })),
    cancel: vi.fn(),
  }
}

function replayRecorder() {
  return {
    supported: true,
    eventCount: 2,
    start: vi.fn(() => true),
    stop: vi.fn(async () => ({
      blob: new Blob(['{"events":[]}'], { type: 'application/json' }),
      eventCount: 2,
      upload: null,
    })),
    cancel: vi.fn(),
  }
}

describe('FeedbackCaptureController', () => {
  it('starts mic and replay, uploads audio, uploads replay, and finalizes once', async () => {
    const api = backend()
    const audio = audioRecorder()
    const replay = replayRecorder()
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: replay,
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/rentals/token',
    })
    expect(controller.status).toBe('recording')
    expect(audio.start).toHaveBeenCalledTimes(1)
    expect(replay.start).toHaveBeenCalledTimes(1)

    const result = await controller.stop({
      title: 'Portal issue',
      severity: 'high',
      artifact_metadata: { surface: 'rental_portal' },
    })

    expect(result.capture_session_id).toBe('00000000-0000-4000-8000-000000000123')
    expect(result.audio?.artifact.kind).toBe('audio')
    expect(result.replay?.upload?.artifact.kind).toBe('rrweb')
    expect(result.finalize.work_item.id).toBe('work-item-1')
    expect(api.uploadArtifact).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000123',
      expect.objectContaining({
        kind: 'audio',
        fileName: 'audio.webm',
        duration_ms: 1400,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          source: 'record_feedback',
          surface: 'rental_portal',
          mime_type: 'audio/webm',
        },
      }),
    )
    expect(replay.stop).toHaveBeenCalledWith({
      capture_session_id: null,
      metadata: { source: 'record_feedback', surface: 'rental_portal' },
    })
    expect(api.uploadArtifact).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000123',
      expect.objectContaining({
        kind: 'rrweb',
        fileName: 'replay.json',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'capture_replay_recorder',
          surface: 'rental_portal',
          artifact_type: 'capture.rrweb_replay',
          schema_version: 1,
          event_count: 2,
        }),
      }),
    )
    expect(api.finalizeSession).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123', {
      category: 'record_feedback',
      title: 'Portal issue',
      severity: 'high',
    })
    expect(controller.status).toBe('finalized')
    expect(controller.activeCaptureSessionId).toBeNull()
  })

  it('discards local recorders and calls the optional discard backend', async () => {
    const api = backend()
    const audio = audioRecorder()
    const replay = replayRecorder()
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: replay,
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })
    await controller.discard()

    expect(audio.cancel).toHaveBeenCalledTimes(1)
    expect(replay.cancel).toHaveBeenCalledTimes(1)
    expect(api.discardSession).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123')
    expect(controller.status).toBe('discarded')
    expect(controller.activeCaptureSessionId).toBeNull()
  })

  it('retries finalize after uploads without double-stopping or double-uploading audio', async () => {
    const api = backend()
    const audio = audioRecorder()
    api.finalizeSession.mockRejectedValueOnce(new Error('server unavailable')).mockResolvedValueOnce({
      work_item: {
        id: 'work-item-1',
        title: 'Portal issue',
        summary: 'Customer narrated the issue.',
        status: 'new',
        lane: 'triage',
        severity: 'high',
        route: null,
        capture_session_id: '00000000-0000-4000-8000-000000000123',
      },
      support_packet: { id: 'support-1', expires_at: null },
      event: null,
    })
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: null,
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })

    await expect(controller.stop({ title: 'Portal issue' })).rejects.toThrow('server unavailable')
    expect(controller.status).toBe('error')
    expect(controller.canRetryStop).toBe(true)
    expect(controller.activeCaptureSessionId).toBe('00000000-0000-4000-8000-000000000123')

    const result = await controller.stop()

    expect(result.finalize.work_item.id).toBe('work-item-1')
    expect(audio.stop).toHaveBeenCalledTimes(1)
    expect(api.uploadArtifact).toHaveBeenCalledTimes(1)
    expect(api.finalizeSession).toHaveBeenCalledTimes(2)
    expect(controller.status).toBe('finalized')
    expect(controller.activeCaptureSessionId).toBeNull()
  })

  it('retries a failed audio upload using the retained recording blob', async () => {
    const api = backend()
    const audio = audioRecorder()
    api.uploadArtifact.mockRejectedValueOnce(new Error('upload failed'))
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: null,
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })

    await expect(controller.stop({ title: 'Portal issue' })).rejects.toThrow('upload failed')
    expect(controller.status).toBe('error')
    expect(controller.canRetryStop).toBe(true)

    await controller.stop()

    expect(audio.stop).toHaveBeenCalledTimes(1)
    expect(api.uploadArtifact).toHaveBeenCalledTimes(2)
    expect(api.finalizeSession).toHaveBeenCalledTimes(1)
    expect(controller.status).toBe('finalized')
  })

  it('queues stopped audio and finalize for offline replay when upload loses the network', async () => {
    const api = backend()
    const audio = audioRecorder()
    let enqueueIndex = 0
    const enqueueMutation = vi.fn(async (kind: string) => ({ id: `queued-${kind}-${enqueueIndex++}` }))
    api.uploadArtifact.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: null,
      offlineQueue: {
        target: { type: 'authenticated' },
        enqueueMutation,
      },
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })

    await expect(controller.stop({ title: 'Portal issue', severity: 'normal' })).rejects.toBeInstanceOf(
      FeedbackCaptureQueuedError,
    )

    expect(enqueueMutation).toHaveBeenCalledTimes(2)
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      1,
      'capture_artifact_upload',
      expect.objectContaining({
        target: { type: 'authenticated' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        kind: 'audio',
        fileName: 'audio.webm',
        duration_ms: 1400,
        pii_level: 'private',
        access_policy: 'support_only',
      }),
    )
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      2,
      'capture_session_finalize',
      expect.objectContaining({
        target: { type: 'authenticated' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        input: expect.objectContaining({
          category: 'record_feedback',
          title: 'Portal issue',
          severity: 'normal',
          offline_replay: true,
        }),
      }),
    )
    expect(audio.stop).toHaveBeenCalledTimes(1)
    expect(api.finalizeSession).not.toHaveBeenCalled()
    expect(controller.status).toBe('queued')
    expect(controller.activeCaptureSessionId).toBeNull()
  })

  it('queues stopped replay JSON and finalize when rrweb upload loses the network', async () => {
    const api = backend()
    const audio = audioRecorder()
    const replay = replayRecorder()
    const enqueueMutation = vi.fn(async (kind: string) => ({
      id: `queued-${kind}-${enqueueMutation.mock.calls.length}`,
    }))
    api.uploadArtifact
      .mockResolvedValueOnce({
        artifact: {
          id: 'audio-artifact-1',
          kind: 'audio',
          storage_key: 'co-1/capture-sessions/session-1/audio.webm',
          content_type: 'audio/webm',
          byte_size: 5,
          content_hash: 'sha256:audio',
          redaction_version: 'capture-session-v1',
        },
      })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: replay,
      offlineQueue: {
        target: { type: 'portal', portal_surface: 'estimate_portal', share_token: 'share-token' },
        enqueueMutation,
      },
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })

    await expect(controller.stop({ title: 'Portal issue' })).rejects.toBeInstanceOf(FeedbackCaptureQueuedError)

    expect(enqueueMutation).toHaveBeenCalledTimes(2)
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      1,
      'capture_artifact_upload',
      expect.objectContaining({
        target: { type: 'portal', portal_surface: 'estimate_portal', share_token: 'share-token' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        kind: 'rrweb',
        fileName: 'replay.json',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'capture_replay_recorder',
          event_count: 2,
        }),
      }),
    )
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      2,
      'capture_session_finalize',
      expect.objectContaining({
        target: { type: 'portal', portal_surface: 'estimate_portal', share_token: 'share-token' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
      }),
    )
    expect(replay.stop).toHaveBeenCalledWith({
      capture_session_id: null,
      metadata: { source: 'record_feedback' },
    })
    expect(api.finalizeSession).not.toHaveBeenCalled()
    expect(controller.status).toBe('queued')
  })

  it('records locally when session start is queued and replays start before upload/finalize', async () => {
    const api = backend()
    const audio = audioRecorder()
    let enqueueIndex = 0
    const enqueueMutation = vi.fn(async (kind: string) => ({ id: `queued-${kind}-${enqueueIndex++}` }))
    api.startSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: null,
      offlineQueue: {
        target: { type: 'authenticated' },
        enqueueMutation,
      },
    })

    const session = await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
      route_path: '/desktop/takeoff',
    })

    expect(session.capture_session).toMatchObject({
      id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      status: 'open',
    })
    expect(controller.status).toBe('recording')
    expect(audio.start).toHaveBeenCalledTimes(1)
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      1,
      'capture_session_start',
      expect.objectContaining({
        target: { type: 'authenticated' },
        input: expect.objectContaining({
          capture_session_id: '00000000-0000-4000-8000-000000000123',
          consent_version: 'portal-feedback-v1',
          route_path: '/desktop/takeoff',
          mode: 'feedback',
        }),
      }),
    )

    await expect(controller.stop({ title: 'Queued from the beginning' })).rejects.toMatchObject({
      name: 'FeedbackCaptureQueuedError',
      queued_mutation_ids: [
        'queued-capture_session_start-0',
        'queued-capture_artifact_upload-1',
        'queued-capture_session_finalize-2',
      ],
    })

    expect(api.uploadArtifact).not.toHaveBeenCalled()
    expect(api.finalizeSession).not.toHaveBeenCalled()
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      2,
      'capture_artifact_upload',
      expect.objectContaining({
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        kind: 'audio',
      }),
    )
    expect(enqueueMutation).toHaveBeenNthCalledWith(
      3,
      'capture_session_finalize',
      expect.objectContaining({
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        input: expect.objectContaining({
          title: 'Queued from the beginning',
          offline_replay: true,
        }),
      }),
    )
    expect(controller.status).toBe('queued')
    expect(controller.activeCaptureSessionId).toBeNull()
  })

  it('removes a queued session start when a locally started recording is discarded', async () => {
    const api = backend()
    const audio = audioRecorder()
    const enqueueMutation = vi.fn(async () => ({ id: 'queued-start-1' }))
    const removeMutation = vi.fn(async () => undefined)
    api.startSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const controller = new FeedbackCaptureController({
      backend: api,
      audioRecorder: audio,
      replayRecorder: null,
      offlineQueue: {
        target: { type: 'authenticated' },
        enqueueMutation,
        removeMutation,
      },
    })

    await controller.start({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      consent_version: 'portal-feedback-v1',
    })
    await controller.discard()

    expect(audio.cancel).toHaveBeenCalledTimes(1)
    expect(removeMutation).toHaveBeenCalledWith('queued-start-1')
    expect(api.discardSession).not.toHaveBeenCalled()
    expect(controller.status).toBe('discarded')
    expect(controller.activeCaptureSessionId).toBeNull()
  })
})

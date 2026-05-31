import { describe, expect, it, vi } from 'vitest'
import { FeedbackCaptureController, type FeedbackCaptureBackend } from './feedback-capture-controller'

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
      upload: {
        artifact: {
          id: 'rrweb-artifact-1',
          kind: 'rrweb',
          storage_key: 'co-1/capture-sessions/session-1/replay.json',
          content_type: 'application/json',
          byte_size: 13,
          content_hash: 'sha256:rrweb',
          redaction_version: 'capture-session-v1',
        },
      },
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
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      metadata: { source: 'record_feedback', surface: 'rental_portal' },
    })
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
})

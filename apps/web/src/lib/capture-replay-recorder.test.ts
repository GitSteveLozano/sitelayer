import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadCaptureArtifact } from './api/capture-sessions'
import {
  CaptureReplayRecorder,
  captureReplayArtifactBlob,
  createRrwebCaptureReplayRecorder,
  isCaptureReplayRecorderSupported,
  type CaptureReplayRecord,
} from './capture-replay-recorder'

vi.mock('./api/capture-sessions', () => ({
  uploadCaptureArtifact: vi.fn(),
}))

const rrweb = vi.hoisted(() => ({
  record: vi.fn(),
}))

vi.mock('@rrweb/record', () => rrweb)

const uploadCaptureArtifactMock = vi.mocked(uploadCaptureArtifact)

function recordStub(events: unknown[] = []): {
  record: CaptureReplayRecord
  stop: ReturnType<typeof vi.fn>
} {
  const stop = vi.fn()
  const record: CaptureReplayRecord = ({ emit }) => {
    events.forEach((event) => emit(event))
    return stop
  }
  return { record, stop }
}

describe('capture replay recorder', () => {
  beforeEach(() => {
    uploadCaptureArtifactMock.mockReset()
    rrweb.record.mockReset()
  })

  it('reports unsupported without an injected rrweb record function', () => {
    expect(isCaptureReplayRecorderSupported({ isBrowserSupported: () => true })).toBe(false)

    const recorder = new CaptureReplayRecorder({ isBrowserSupported: () => true })

    expect(recorder.supported).toBe(false)
    expect(recorder.start()).toBe(false)
    expect(recorder.status).toBe('idle')
  })

  it('buffers emitted events and serializes an application/json replay blob', async () => {
    const { record, stop } = recordStub([
      { type: 2, data: { node: { id: 1, tagName: 'HTML' } } },
      { type: 3, data: { source: 0, id: 1, x: 10, y: 20 } },
    ])
    const recorder = new CaptureReplayRecorder({
      record,
      isBrowserSupported: () => true,
      now: () => '2026-05-31T12:00:00.000Z',
    })

    expect(recorder.start()).toBe(true)
    expect(recorder.eventCount).toBe(2)

    const result = await recorder.stop()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(result.eventCount).toBe(2)
    expect(result.upload).toBeNull()
    expect(result.blob.type).toBe('application/json')
    await expect(result.blob.text().then(JSON.parse)).resolves.toEqual({
      schema_version: 1,
      artifact_type: 'capture.rrweb_replay',
      captured_at: '2026-05-31T12:00:00.000Z',
      event_count: 2,
      events: [
        { type: 2, data: { node: { id: 1, tagName: 'HTML' } } },
        { type: 3, data: { source: 0, id: 1, x: 10, y: 20 } },
      ],
    })
  })

  it('uploads rrweb artifacts when a capture_session_id is provided', async () => {
    const { record } = recordStub([{ type: 4, data: { href: '/projects/1' } }])
    uploadCaptureArtifactMock.mockResolvedValueOnce({
      artifact: {
        id: 'artifact-1',
        kind: 'rrweb',
        storage_key: 'co-1/capture-sessions/session-1/artifacts/replay.json',
        content_type: 'application/json',
        byte_size: 100,
        content_hash: 'sha256:abc',
        redaction_version: 'capture-session-v1',
      },
    })
    const recorder = new CaptureReplayRecorder({
      record,
      isBrowserSupported: () => true,
      now: () => '2026-05-31T12:01:00.000Z',
    })

    recorder.start()
    await expect(
      recorder.stop({
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        metadata: { trigger: 'finalize' },
      }),
    ).resolves.toMatchObject({ upload: { artifact: { kind: 'rrweb' } } })

    expect(uploadCaptureArtifactMock).toHaveBeenCalledTimes(1)
    const [captureSessionId, input] = uploadCaptureArtifactMock.mock.calls[0]!
    expect(captureSessionId).toBe('00000000-0000-4000-8000-000000000123')
    expect(input).toMatchObject({
      kind: 'rrweb',
      fileName: 'replay.json',
      pii_level: 'private',
      access_policy: 'support_only',
      metadata: {
        source: 'capture_replay_recorder',
        artifact_type: 'capture.rrweb_replay',
        schema_version: 1,
        event_count: 1,
        trigger: 'finalize',
      },
    })
    expect(input.file.type).toBe('application/json')
    expect(await input.file.text()).toBe(
      await captureReplayArtifactBlob({
        schema_version: 1,
        artifact_type: 'capture.rrweb_replay',
        captured_at: '2026-05-31T12:01:00.000Z',
        event_count: 1,
        events: [{ type: 4, data: { href: '/projects/1' } }],
      }).text(),
    )
  })

  it('cancels an active recorder without leaving buffered events', () => {
    let emitEvent: ((event: unknown) => void) | null = null
    const stop = vi.fn(() => emitEvent?.({ type: 'after-stop' }))
    const record: CaptureReplayRecord = ({ emit }) => {
      emitEvent = emit
      emit({ type: 'initial' })
      return stop
    }
    const recorder = new CaptureReplayRecorder({ record, isBrowserSupported: () => true })

    recorder.start()
    recorder.cancel()
    const emitAfterCancel = emitEvent as ((event: unknown) => void) | null
    emitAfterCancel?.({ type: 'late' })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(recorder.status).toBe('canceled')
    expect(recorder.eventCount).toBe(0)
    expect(recorder.buildPayload().events).toEqual([])
  })

  it('constructs a real rrweb-backed recorder with privacy-preserving defaults', async () => {
    const stop = vi.fn()
    rrweb.record.mockImplementation((options?: { emit?: (event: unknown) => void }) => {
      options?.emit?.({ type: 'rrweb-event' })
      return stop
    })
    const recorder = createRrwebCaptureReplayRecorder({
      isBrowserSupported: () => true,
      now: () => '2026-05-31T12:02:00.000Z',
    })

    expect(recorder.start()).toBe(true)
    await expect(recorder.stop()).resolves.toMatchObject({ eventCount: 1, upload: null })

    expect(rrweb.record).toHaveBeenCalledWith(
      expect.objectContaining({
        maskAllInputs: true,
        blockClass: 'sl-capture-block',
        blockSelector: expect.stringContaining('data-capture-block'),
        ignoreClass: 'sl-capture-ignore',
        inlineImages: false,
        recordCanvas: false,
        recordCrossOriginIframes: false,
        collectFonts: false,
        emit: expect.any(Function),
      }),
    )
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

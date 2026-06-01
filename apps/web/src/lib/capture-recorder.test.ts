import { describe, expect, it, vi } from 'vitest'
import { AudioCaptureRecorder, isAudioCaptureSupported, preferredAudioMimeType } from './capture-recorder'

class FakeTrack {
  stop = vi.fn()
}

class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supported = new Set<string>()
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
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['hello '], { type: this.mimeType || 'audio/webm' }) } as BlobEvent)
    this.ondataavailable?.({ data: new Blob(['world'], { type: this.mimeType || 'audio/webm' }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

function recorderCtor(): typeof FakeMediaRecorder {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.supported = new Set(['audio/webm'])
  return FakeMediaRecorder
}

describe('capture audio recorder', () => {
  it('reports unsupported when mic or MediaRecorder is unavailable', () => {
    expect(
      isAudioCaptureSupported({
        mediaDevices: null,
        MediaRecorderCtor: recorderCtor() as unknown as typeof MediaRecorder,
      }),
    ).toBe(false)
    expect(
      isAudioCaptureSupported({
        mediaDevices: { getUserMedia: vi.fn() as unknown as MediaDevices['getUserMedia'] },
        MediaRecorderCtor: null,
      }),
    ).toBe(false)
  })

  it('chooses the first supported audio mime type', () => {
    const Recorder = recorderCtor()
    Recorder.supported = new Set(['audio/ogg', 'audio/webm'])

    expect(preferredAudioMimeType(Recorder as unknown as Parameters<typeof preferredAudioMimeType>[0])).toBe(
      'audio/webm',
    )
  })

  it('records mic audio, stops tracks, and returns a blob with duration', async () => {
    const stream = new FakeMediaStream()
    const getUserMedia = vi.fn(async () => stream as unknown as MediaStream)
    let now = 1_000
    const recorder = new AudioCaptureRecorder({
      mediaDevices: { getUserMedia: getUserMedia as unknown as MediaDevices['getUserMedia'] },
      MediaRecorderCtor: recorderCtor() as unknown as typeof MediaRecorder,
      now: () => now,
    })

    await recorder.start()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(recorder.isRecording).toBe(true)
    expect(FakeMediaRecorder.instances[0]?.mimeType).toBe('audio/webm')

    now = 2_250
    const result = await recorder.stop()

    expect(result.duration_ms).toBe(1250)
    expect(result.mime_type).toBe('audio/webm')
    expect(await result.blob.text()).toBe('hello world')
    expect(stream.tracks[0]?.stop).toHaveBeenCalledTimes(1)
    expect(recorder.isRecording).toBe(false)
  })

  it('rejects when stopped before start', async () => {
    const recorder = new AudioCaptureRecorder({
      mediaDevices: { getUserMedia: vi.fn() as unknown as MediaDevices['getUserMedia'] },
      MediaRecorderCtor: recorderCtor() as unknown as typeof MediaRecorder,
    })

    await expect(recorder.stop()).rejects.toThrow('Audio recording has not been started.')
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  AudioCaptureRecorder,
  ScreenCaptureRecorder,
  isAudioCaptureSupported,
  isScreenCaptureSupported,
  preferredAudioMimeType,
  preferredScreenMimeType,
} from './capture-recorder'

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
  startTimeslice: number | undefined

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    this.startTimeslice = timeslice
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
    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBeUndefined()

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

describe('capture screen recorder', () => {
  it('reports unsupported when display capture or MediaRecorder is unavailable', () => {
    expect(
      isScreenCaptureSupported({
        mediaDevices: null,
        MediaRecorderCtor: recorderCtor() as unknown as typeof MediaRecorder,
      }),
    ).toBe(false)
    expect(
      isScreenCaptureSupported({
        mediaDevices: { getDisplayMedia: vi.fn() as unknown as MediaDevices['getDisplayMedia'] },
        MediaRecorderCtor: null,
      }),
    ).toBe(false)
  })

  it('chooses the first supported screen mime type', () => {
    const Recorder = recorderCtor()
    Recorder.supported = new Set(['video/webm', 'video/mp4'])

    expect(preferredScreenMimeType(Recorder as unknown as Parameters<typeof preferredScreenMimeType>[0])).toBe(
      'video/webm',
    )
  })

  it('records display video, stops tracks, and returns a blob with duration', async () => {
    const Recorder = recorderCtor()
    Recorder.supported = new Set(['video/webm'])
    const stream = new FakeMediaStream()
    const getDisplayMedia = vi.fn(async () => stream as unknown as MediaStream)
    let now = 5_000
    const recorder = new ScreenCaptureRecorder({
      mediaDevices: { getDisplayMedia: getDisplayMedia as unknown as MediaDevices['getDisplayMedia'] },
      MediaRecorderCtor: Recorder as unknown as typeof MediaRecorder,
      now: () => now,
    })

    await recorder.start()
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false })
    expect(recorder.isRecording).toBe(true)
    expect(FakeMediaRecorder.instances[0]?.mimeType).toBe('video/webm')
    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBe(5000)

    now = 8_333
    const result = await recorder.stop()

    expect(result.duration_ms).toBe(3333)
    expect(result.mime_type).toBe('video/webm')
    expect(await result.blob.text()).toBe('hello world')
    expect(result.chunks).toEqual([
      {
        seq: 0,
        start_ms: 0,
        end_ms: 3333,
        byte_size: 6,
        content_type: 'video/webm',
      },
      {
        seq: 1,
        start_ms: 3333,
        end_ms: 3333,
        byte_size: 5,
        content_type: 'video/webm',
      },
    ])
    expect(stream.tracks[0]?.stop).toHaveBeenCalledTimes(1)
    expect(recorder.isRecording).toBe(false)
  })

  it('can disable screen recorder timeslice chunking for single-blob browsers', async () => {
    const Recorder = recorderCtor()
    Recorder.supported = new Set(['video/webm'])
    const stream = new FakeMediaStream()
    const getDisplayMedia = vi.fn(async () => stream as unknown as MediaStream)
    const recorder = new ScreenCaptureRecorder({
      mediaDevices: { getDisplayMedia: getDisplayMedia as unknown as MediaDevices['getDisplayMedia'] },
      MediaRecorderCtor: Recorder as unknown as typeof MediaRecorder,
      timesliceMs: null,
    })

    await recorder.start()

    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBeUndefined()
    await recorder.stop()
  })
})

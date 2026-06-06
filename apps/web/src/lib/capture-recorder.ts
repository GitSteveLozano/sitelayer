export type CaptureRecordingChunk = {
  seq: number
  start_ms: number
  end_ms: number
  byte_size: number
  content_type: string
}

export type CaptureRecordingResult = {
  blob: Blob
  duration_ms: number
  mime_type: string
  chunks?: CaptureRecordingChunk[]
}

type MediaRecorderConstructor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder
  isTypeSupported?: (mimeType: string) => boolean
}

export type AudioCaptureRecorderDeps = {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | null
  MediaRecorderCtor?: MediaRecorderConstructor | null
  now?: () => number
}

export type ScreenCaptureRecorderDeps = {
  mediaDevices?: Pick<MediaDevices, 'getDisplayMedia'> | null
  MediaRecorderCtor?: MediaRecorderConstructor | null
  now?: () => number
  displayMediaConstraints?: DisplayMediaStreamOptions
  timesliceMs?: number | null
}

const AUDIO_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
] as const

const SCREEN_MIME_PREFERENCES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const

function defaultMediaDevices(): Pick<MediaDevices, 'getUserMedia'> | null {
  if (typeof navigator === 'undefined') return null
  return navigator.mediaDevices ?? null
}

function defaultScreenMediaDevices(): Pick<MediaDevices, 'getDisplayMedia'> | null {
  if (typeof navigator === 'undefined') return null
  const mediaDevices = navigator.mediaDevices as Partial<Pick<MediaDevices, 'getDisplayMedia'>> | undefined
  return typeof mediaDevices?.getDisplayMedia === 'function'
    ? (mediaDevices as Pick<MediaDevices, 'getDisplayMedia'>)
    : null
}

function defaultMediaRecorder(): MediaRecorderConstructor | null {
  return typeof MediaRecorder === 'undefined' ? null : MediaRecorder
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

function errorFromRecorderEvent(event: Event): Error {
  const maybeError = (event as Event & { error?: unknown }).error
  if (maybeError instanceof Error) return maybeError
  if (maybeError && typeof maybeError === 'object' && 'message' in maybeError) {
    return new Error(String((maybeError as { message?: unknown }).message ?? 'audio recorder failed'))
  }
  return new Error('audio recorder failed')
}

export function isAudioCaptureSupported(deps: AudioCaptureRecorderDeps = {}): boolean {
  const mediaDevices = deps.mediaDevices ?? defaultMediaDevices()
  const Recorder = deps.MediaRecorderCtor ?? defaultMediaRecorder()
  return Boolean(mediaDevices?.getUserMedia && Recorder)
}

export function preferredAudioMimeType(
  Recorder: MediaRecorderConstructor | null = defaultMediaRecorder(),
): string | null {
  if (!Recorder?.isTypeSupported) return null
  return AUDIO_MIME_PREFERENCES.find((mime) => Recorder.isTypeSupported?.(mime)) ?? null
}

export function isScreenCaptureSupported(deps: ScreenCaptureRecorderDeps = {}): boolean {
  const mediaDevices = deps.mediaDevices ?? defaultScreenMediaDevices()
  const Recorder = deps.MediaRecorderCtor ?? defaultMediaRecorder()
  return Boolean(mediaDevices?.getDisplayMedia && Recorder)
}

export function preferredScreenMimeType(
  Recorder: MediaRecorderConstructor | null = defaultMediaRecorder(),
): string | null {
  if (!Recorder?.isTypeSupported) return null
  return SCREEN_MIME_PREFERENCES.find((mime) => Recorder.isTypeSupported?.(mime)) ?? null
}

export class AudioCaptureRecorder {
  private readonly mediaDevices: Pick<MediaDevices, 'getUserMedia'> | null
  private readonly Recorder: MediaRecorderConstructor | null
  private readonly now: () => number
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private startedAt = 0
  private stopPromise: Promise<CaptureRecordingResult> | null = null
  private resolveStop: ((value: CaptureRecordingResult) => void) | null = null
  private rejectStop: ((error: Error) => void) | null = null

  constructor(deps: AudioCaptureRecorderDeps = {}) {
    this.mediaDevices = deps.mediaDevices ?? defaultMediaDevices()
    this.Recorder = deps.MediaRecorderCtor ?? defaultMediaRecorder()
    this.now = deps.now ?? Date.now
  }

  get isRecording(): boolean {
    return Boolean(this.recorder && this.recorder.state !== 'inactive')
  }

  async start(): Promise<void> {
    if (!this.mediaDevices?.getUserMedia || !this.Recorder) {
      throw new Error('Audio recording is not available in this browser.')
    }
    if (this.isRecording) throw new Error('Audio recording is already active.')

    const stream = await this.mediaDevices.getUserMedia({ audio: true })
    const mimeType = preferredAudioMimeType(this.Recorder)
    const recorder = new this.Recorder(stream, mimeType ? { mimeType } : undefined)
    this.stream = stream
    this.recorder = recorder
    this.chunks = []
    this.startedAt = this.now()
    this.stopPromise = new Promise<CaptureRecordingResult>((resolve, reject) => {
      this.resolveStop = resolve
      this.rejectStop = reject
    })

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.onstop = () => {
      const resolvedMime = recorder.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(this.chunks, { type: resolvedMime })
      const result = {
        blob,
        duration_ms: Math.max(0, Math.trunc(this.now() - this.startedAt)),
        mime_type: resolvedMime,
      }
      const resolve = this.resolveStop
      this.cleanup()
      resolve?.(result)
    }
    recorder.onerror = (event) => {
      const error = errorFromRecorderEvent(event)
      const reject = this.rejectStop
      this.cleanup()
      reject?.(error)
    }

    try {
      recorder.start()
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  async stop(): Promise<CaptureRecordingResult> {
    const recorder = this.recorder
    const stopPromise = this.stopPromise
    if (!recorder || !stopPromise) throw new Error('Audio recording has not been started.')
    if (recorder.state !== 'inactive') recorder.stop()
    return stopPromise
  }

  cancel(): void {
    const error = new Error('Audio recording cancelled.')
    const reject = this.rejectStop
    const stopPromise = this.stopPromise
    void stopPromise?.catch(() => undefined)
    this.cleanup()
    reject?.(error)
  }

  private cleanup(): void {
    stopStreamTracks(this.stream)
    this.stream = null
    this.recorder = null
    this.chunks = []
    this.startedAt = 0
    this.stopPromise = null
    this.resolveStop = null
    this.rejectStop = null
  }
}

export class ScreenCaptureRecorder {
  private readonly mediaDevices: Pick<MediaDevices, 'getDisplayMedia'> | null
  private readonly Recorder: MediaRecorderConstructor | null
  private readonly now: () => number
  private readonly displayMediaConstraints: DisplayMediaStreamOptions
  private readonly timesliceMs: number | null
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private chunkManifest: CaptureRecordingChunk[] = []
  private startedAt = 0
  private stopPromise: Promise<CaptureRecordingResult> | null = null
  private resolveStop: ((value: CaptureRecordingResult) => void) | null = null
  private rejectStop: ((error: Error) => void) | null = null

  constructor(deps: ScreenCaptureRecorderDeps = {}) {
    this.mediaDevices = deps.mediaDevices ?? defaultScreenMediaDevices()
    this.Recorder = deps.MediaRecorderCtor ?? defaultMediaRecorder()
    this.now = deps.now ?? Date.now
    this.displayMediaConstraints = deps.displayMediaConstraints ?? { video: true, audio: false }
    this.timesliceMs = deps.timesliceMs === null ? null : Math.max(1000, Math.trunc(deps.timesliceMs ?? 5000))
  }

  get isRecording(): boolean {
    return Boolean(this.recorder && this.recorder.state !== 'inactive')
  }

  async start(): Promise<void> {
    if (!this.mediaDevices?.getDisplayMedia || !this.Recorder) {
      throw new Error('Screen recording is not available in this browser.')
    }
    if (this.isRecording) throw new Error('Screen recording is already active.')

    const stream = await this.mediaDevices.getDisplayMedia(this.displayMediaConstraints)
    const mimeType = preferredScreenMimeType(this.Recorder)
    const recorder = new this.Recorder(stream, mimeType ? { mimeType } : undefined)
    this.stream = stream
    this.recorder = recorder
    this.chunks = []
    this.startedAt = this.now()
    this.stopPromise = new Promise<CaptureRecordingResult>((resolve, reject) => {
      this.resolveStop = resolve
      this.rejectStop = reject
    })

    recorder.ondataavailable = (event) => this.recordChunk(event.data)
    recorder.onstop = () => {
      const resolvedMime = recorder.mimeType || mimeType || 'video/webm'
      const blob = new Blob(this.chunks, { type: resolvedMime })
      const result = {
        blob,
        duration_ms: Math.max(0, Math.trunc(this.now() - this.startedAt)),
        mime_type: resolvedMime,
        chunks: this.chunkManifest.slice(),
      }
      const resolve = this.resolveStop
      this.cleanup()
      resolve?.(result)
    }
    recorder.onerror = (event) => {
      const error = errorFromRecorderEvent(event)
      const reject = this.rejectStop
      this.cleanup()
      reject?.(error)
    }

    try {
      if (this.timesliceMs === null) recorder.start()
      else recorder.start(this.timesliceMs)
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  async stop(): Promise<CaptureRecordingResult> {
    const recorder = this.recorder
    const stopPromise = this.stopPromise
    if (!recorder || !stopPromise) throw new Error('Screen recording has not been started.')
    if (recorder.state !== 'inactive') recorder.stop()
    return stopPromise
  }

  cancel(): void {
    const error = new Error('Screen recording cancelled.')
    const reject = this.rejectStop
    const stopPromise = this.stopPromise
    void stopPromise?.catch(() => undefined)
    this.cleanup()
    reject?.(error)
  }

  private recordChunk(data: Blob | undefined): void {
    if (!data || data.size <= 0) return
    const seq = this.chunkManifest.length
    const startMs = seq === 0 ? 0 : (this.chunkManifest[seq - 1]?.end_ms ?? 0)
    const endMs = Math.max(startMs, Math.trunc(this.now() - this.startedAt))
    this.chunks.push(data)
    this.chunkManifest.push({
      seq,
      start_ms: startMs,
      end_ms: endMs,
      byte_size: data.size,
      content_type: data.type || this.recorder?.mimeType || 'video/webm',
    })
  }

  private cleanup(): void {
    stopStreamTracks(this.stream)
    this.stream = null
    this.recorder = null
    this.chunks = []
    this.chunkManifest = []
    this.startedAt = 0
    this.stopPromise = null
    this.resolveStop = null
    this.rejectStop = null
  }
}

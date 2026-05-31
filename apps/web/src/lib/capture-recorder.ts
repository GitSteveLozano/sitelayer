export type CaptureRecordingResult = {
  blob: Blob
  duration_ms: number
  mime_type: string
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

const AUDIO_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
] as const

function defaultMediaDevices(): Pick<MediaDevices, 'getUserMedia'> | null {
  if (typeof navigator === 'undefined') return null
  return navigator.mediaDevices ?? null
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

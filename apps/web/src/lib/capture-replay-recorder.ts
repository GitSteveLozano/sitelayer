import { record as rrwebRecord } from '@rrweb/record'
import {
  uploadCaptureArtifact,
  type CaptureArtifactUploadResponse,
  type CaptureArtifactUploadInput,
} from './api/capture-sessions'

export type CaptureReplayEvent = unknown
export type CaptureReplayStopHandle = () => void

export type CaptureReplayRecord = (options: {
  emit: (event: CaptureReplayEvent) => void
}) => CaptureReplayStopHandle | void

export type CaptureReplayRecorderStatus = 'idle' | 'recording' | 'stopped' | 'canceled'

export interface CaptureReplayRecorderDependencies {
  record?: CaptureReplayRecord | null | undefined
  upload?: (captureSessionId: string, input: CaptureArtifactUploadInput) => Promise<CaptureArtifactUploadResponse>
  now?: () => string
  isBrowserSupported?: () => boolean
}

type RrwebRecordOptions = NonNullable<Parameters<typeof rrwebRecord>[0]>

export type RrwebCaptureReplayOptions = Omit<RrwebRecordOptions, 'emit'>

export interface CreateRrwebCaptureReplayRecorderOptions extends CaptureReplayRecorderDependencies {
  rrwebOptions?: RrwebCaptureReplayOptions
}

export interface CaptureReplayArtifactPayload {
  schema_version: 1
  artifact_type: 'capture.rrweb_replay'
  captured_at: string
  event_count: number
  events: CaptureReplayEvent[]
}

export interface StopCaptureReplayRecorderOptions {
  capture_session_id?: string | null
  metadata?: Record<string, unknown>
}

export interface CaptureReplayRecorderStopResult {
  blob: Blob
  eventCount: number
  upload: CaptureArtifactUploadResponse | null
}

export function isCaptureReplayRecorderSupported(deps: CaptureReplayRecorderDependencies = {}): boolean {
  const browserSupported = deps.isBrowserSupported ?? defaultBrowserSupport
  return typeof deps.record === 'function' && browserSupported()
}

export function captureReplayArtifactBlob(payload: CaptureReplayArtifactPayload): Blob {
  return new Blob([JSON.stringify(payload)], { type: 'application/json' })
}

export function createRrwebCaptureReplayRecorder(
  options: CreateRrwebCaptureReplayRecorderOptions = {},
): CaptureReplayRecorder {
  const { rrwebOptions, record, ...deps } = options
  return new CaptureReplayRecorder({
    ...deps,
    record:
      record ??
      (({ emit }) =>
        rrwebRecord({
          ...DEFAULT_RRWEB_OPTIONS,
          ...rrwebOptions,
          emit: (event) => emit(event),
        })),
  })
}

export class CaptureReplayRecorder {
  private readonly record: CaptureReplayRecord | null | undefined
  private readonly upload: (
    captureSessionId: string,
    input: CaptureArtifactUploadInput,
  ) => Promise<CaptureArtifactUploadResponse>
  private readonly now: () => string
  private readonly isBrowserSupported: () => boolean
  private events: CaptureReplayEvent[] = []
  private stopHandle: CaptureReplayStopHandle | null = null
  private capturedAt: string | null = null
  private currentStatus: CaptureReplayRecorderStatus = 'idle'

  constructor(deps: CaptureReplayRecorderDependencies = {}) {
    this.record = deps.record
    this.upload = deps.upload ?? uploadCaptureArtifact
    this.now = deps.now ?? (() => new Date().toISOString())
    this.isBrowserSupported = deps.isBrowserSupported ?? defaultBrowserSupport
  }

  get status(): CaptureReplayRecorderStatus {
    return this.currentStatus
  }

  get eventCount(): number {
    return this.events.length
  }

  get supported(): boolean {
    return typeof this.record === 'function' && this.isBrowserSupported()
  }

  start(): boolean {
    if (this.currentStatus === 'recording') return true
    if (!this.supported || !this.record) return false

    this.events = []
    this.capturedAt = this.now()
    this.currentStatus = 'recording'
    const stopHandle = this.record({
      emit: (event) => {
        if (this.currentStatus === 'recording') this.events.push(event)
      },
    })
    this.stopHandle = typeof stopHandle === 'function' ? stopHandle : null
    return true
  }

  async stop(options: StopCaptureReplayRecorderOptions = {}): Promise<CaptureReplayRecorderStopResult> {
    if (this.currentStatus === 'recording') this.stopActiveRecording()
    this.currentStatus = 'stopped'

    const payload = this.buildPayload()
    const blob = captureReplayArtifactBlob(payload)
    const captureSessionId = normalizeCaptureSessionId(options.capture_session_id)
    const upload = captureSessionId
      ? await this.upload(captureSessionId, {
          kind: 'rrweb',
          file: blob,
          fileName: 'replay.json',
          client_upload_id: `capture_replay:${captureSessionId}:rrweb`,
          pii_level: 'private',
          access_policy: 'support_only',
          metadata: {
            ...options.metadata,
            source: 'capture_replay_recorder',
            artifact_type: payload.artifact_type,
            schema_version: payload.schema_version,
            event_count: payload.event_count,
          },
        })
      : null

    return { blob, eventCount: payload.event_count, upload }
  }

  cancel(): void {
    if (this.currentStatus === 'recording') this.stopActiveRecording()
    this.events = []
    this.capturedAt = null
    this.currentStatus = 'canceled'
  }

  buildPayload(): CaptureReplayArtifactPayload {
    return {
      schema_version: 1,
      artifact_type: 'capture.rrweb_replay',
      captured_at: this.capturedAt ?? this.now(),
      event_count: this.events.length,
      events: [...this.events],
    }
  }

  buildBlob(): Blob {
    return captureReplayArtifactBlob(this.buildPayload())
  }

  private stopActiveRecording(): void {
    const stopHandle = this.stopHandle
    this.stopHandle = null
    if (stopHandle) stopHandle()
  }
}

function defaultBrowserSupport(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof Blob !== 'undefined'
}

function normalizeCaptureSessionId(captureSessionId: string | null | undefined): string | null {
  const trimmed = captureSessionId?.trim()
  return trimmed ? trimmed : null
}

const DEFAULT_RRWEB_OPTIONS: RrwebCaptureReplayOptions = {
  maskAllInputs: true,
  blockClass: 'sl-capture-block',
  blockSelector: '[data-capture-block], [data-capture-private], [data-pii]',
  ignoreClass: 'sl-capture-ignore',
  ignoreSelector: '[data-capture-ignore]',
  inlineImages: false,
  recordCanvas: false,
  recordCrossOriginIframes: false,
  collectFonts: false,
}

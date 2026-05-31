import { AudioCaptureRecorder, type CaptureRecordingResult } from './capture-recorder'
import { CaptureReplayRecorder, type CaptureReplayRecorderStopResult } from './capture-replay-recorder'
import type {
  CaptureArtifactUploadInput,
  CaptureArtifactUploadResponse,
  CaptureFinalizeInput,
  CaptureFinalizeResponse,
} from './api/capture-sessions'

export type FeedbackCaptureStatus = 'idle' | 'recording' | 'stopping' | 'finalized' | 'discarded' | 'error'

export type FeedbackCaptureSessionInput = {
  capture_session_id: string
  mode?: 'feedback' | 'trace' | 'desktop' | 'native' | 'manual_upload'
  consent_version?: string
  route_path?: string
  device_kind?: string
  platform?: string
  viewport?: string
  app_build_sha?: string
  metadata?: Record<string, unknown>
  consent_scope?: Record<string, unknown>
  retention_days?: number
}

export type FeedbackCaptureSessionResponse = {
  capture_session: {
    id: string
    mode: string
    status: string
    started_at?: string
    last_seen_at?: string
  }
}

export type FeedbackCaptureBackend = {
  startSession: (payload: FeedbackCaptureSessionInput) => Promise<FeedbackCaptureSessionResponse>
  uploadArtifact: (
    captureSessionId: string,
    input: CaptureArtifactUploadInput,
  ) => Promise<CaptureArtifactUploadResponse>
  finalizeSession: (captureSessionId: string, input?: CaptureFinalizeInput) => Promise<CaptureFinalizeResponse>
  discardSession?: (captureSessionId: string) => Promise<unknown>
}

export type FeedbackCaptureControllerDeps = {
  backend: FeedbackCaptureBackend
  audioRecorder?: Pick<AudioCaptureRecorder, 'start' | 'stop' | 'cancel' | 'isRecording'> | null
  replayRecorder?: Pick<CaptureReplayRecorder, 'start' | 'stop' | 'cancel' | 'supported' | 'eventCount'> | null
}

export type FeedbackCaptureStartInput = Omit<FeedbackCaptureSessionInput, 'mode'> & {
  mode?: FeedbackCaptureSessionInput['mode']
}

export type FeedbackCaptureStopInput = CaptureFinalizeInput & {
  artifact_metadata?: Record<string, unknown>
}

export type FeedbackCaptureStopResult = {
  capture_session_id: string
  audio: CaptureArtifactUploadResponse | null
  replay: CaptureReplayRecorderStopResult | null
  finalize: CaptureFinalizeResponse
}

export class FeedbackCaptureController {
  private readonly backend: FeedbackCaptureBackend
  private readonly audioRecorder: FeedbackCaptureControllerDeps['audioRecorder']
  private readonly replayRecorder: FeedbackCaptureControllerDeps['replayRecorder']
  private captureSessionId: string | null = null
  private audioStarted = false
  private replayStarted = false
  private currentStatus: FeedbackCaptureStatus = 'idle'

  constructor(deps: FeedbackCaptureControllerDeps) {
    this.backend = deps.backend
    this.audioRecorder = deps.audioRecorder ?? new AudioCaptureRecorder()
    this.replayRecorder = deps.replayRecorder ?? null
  }

  get status(): FeedbackCaptureStatus {
    return this.currentStatus
  }

  get activeCaptureSessionId(): string | null {
    return this.captureSessionId
  }

  async start(input: FeedbackCaptureStartInput): Promise<FeedbackCaptureSessionResponse> {
    if (this.currentStatus === 'recording') throw new Error('Feedback capture is already recording.')
    const session = await this.backend.startSession({
      ...input,
      mode: input.mode ?? 'feedback',
    })
    const id = session.capture_session.id
    this.captureSessionId = id

    try {
      if (this.audioRecorder) {
        await this.audioRecorder.start()
        this.audioStarted = true
      }
      if (this.replayRecorder?.supported && this.replayRecorder.start()) {
        this.replayStarted = true
      }
      this.currentStatus = 'recording'
      return session
    } catch (error) {
      this.currentStatus = 'error'
      this.audioRecorder?.cancel()
      this.replayRecorder?.cancel()
      throw error
    }
  }

  async stop(input: FeedbackCaptureStopInput = {}): Promise<FeedbackCaptureStopResult> {
    const id = this.captureSessionId
    if (!id || this.currentStatus !== 'recording') throw new Error('Feedback capture is not recording.')
    this.currentStatus = 'stopping'
    try {
      const artifactMetadata = {
        source: 'record_feedback',
        ...(input.artifact_metadata ?? {}),
      }
      const audio = this.audioStarted ? await this.stopAndUploadAudio(id, artifactMetadata) : null
      const replay = this.replayStarted
        ? await this.replayRecorder!.stop({
            capture_session_id: id,
            metadata: artifactMetadata,
          })
        : null
      const { artifact_metadata: _artifactMetadata, ...finalizeInput } = input
      const finalize = await this.backend.finalizeSession(id, {
        category: 'record_feedback',
        ...finalizeInput,
      })
      this.currentStatus = 'finalized'
      this.captureSessionId = null
      this.audioStarted = false
      this.replayStarted = false
      return { capture_session_id: id, audio, replay, finalize }
    } catch (error) {
      this.currentStatus = 'error'
      throw error
    }
  }

  async discard(): Promise<void> {
    const id = this.captureSessionId
    this.audioRecorder?.cancel()
    this.replayRecorder?.cancel()
    this.audioStarted = false
    this.replayStarted = false
    try {
      if (id && this.backend.discardSession) await this.backend.discardSession(id)
      this.captureSessionId = null
      this.currentStatus = 'discarded'
    } catch (error) {
      this.captureSessionId = id
      this.currentStatus = 'error'
      throw error
    }
  }

  private async stopAndUploadAudio(
    captureSessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<CaptureArtifactUploadResponse> {
    if (!this.audioRecorder) throw new Error('Audio recorder is not configured.')
    const recorded: CaptureRecordingResult = await this.audioRecorder.stop()
    return this.backend.uploadArtifact(captureSessionId, {
      kind: 'audio',
      file: recorded.blob,
      fileName: fileNameForAudio(recorded.mime_type),
      duration_ms: recorded.duration_ms,
      pii_level: 'private',
      access_policy: 'support_only',
      metadata: {
        ...metadata,
        mime_type: recorded.mime_type,
      },
    })
  }
}

function fileNameForAudio(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('mp4') || lower.includes('m4a')) return 'audio.m4a'
  if (lower.includes('ogg')) return 'audio.ogg'
  if (lower.includes('wav')) return 'audio.wav'
  return 'audio.webm'
}

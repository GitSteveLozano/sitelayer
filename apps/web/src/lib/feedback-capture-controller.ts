import { AudioCaptureRecorder, type CaptureRecordingResult } from './capture-recorder'
import { CaptureReplayRecorder, type CaptureReplayRecorderStopResult } from './capture-replay-recorder'
import type {
  CaptureArtifactUploadInput,
  CaptureArtifactUploadResponse,
  CaptureFinalizeInput,
  CaptureFinalizeResponse,
} from './api/capture-sessions'
import { ApiError, NetworkError } from './api/client'
import {
  enqueueOfflineMutation,
  removeOfflineMutation,
  type OfflineMutation,
  type OfflineMutationKind,
} from './offline/queue'

export type FeedbackCaptureStatus = 'idle' | 'recording' | 'stopping' | 'finalized' | 'queued' | 'discarded' | 'error'

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
  offlineQueue?: FeedbackCaptureOfflineQueue | null
}

export type FeedbackCaptureStartInput = Omit<FeedbackCaptureSessionInput, 'mode'> & {
  mode?: FeedbackCaptureSessionInput['mode']
}

export type FeedbackCaptureStopInput = CaptureFinalizeInput & {
  artifact_metadata?: Record<string, unknown>
  additional_artifact_uploads?: Array<(captureSessionId: string, metadata: Record<string, unknown>) => Promise<unknown>>
}

export type FeedbackCaptureStopResult = {
  capture_session_id: string
  audio: CaptureArtifactUploadResponse | null
  replay: CaptureReplayRecorderStopResult | null
  additional_artifacts: unknown[]
  finalize: CaptureFinalizeResponse
}

export type FeedbackCaptureOfflineTarget =
  | { type: 'authenticated' }
  | { type: 'portal'; portal_surface: 'estimate_portal' | 'rental_portal'; share_token: string }

export type FeedbackCaptureOfflineQueue = {
  target: FeedbackCaptureOfflineTarget
  enqueueMutation?: (
    kind: OfflineMutationKind,
    payload: Record<string, unknown>,
  ) => Promise<Pick<OfflineMutation, 'id'>>
  removeMutation?: (id: string) => Promise<void>
}

export class FeedbackCaptureQueuedError extends Error {
  readonly capture_session_id: string
  readonly queued_mutation_ids: string[]

  constructor(captureSessionId: string, queuedMutationIds: string[]) {
    super('Feedback capture saved for offline replay.')
    this.name = 'FeedbackCaptureQueuedError'
    this.capture_session_id = captureSessionId
    this.queued_mutation_ids = queuedMutationIds
  }
}

type PendingStopState = {
  input: FeedbackCaptureStopInput
  artifactMetadata: Record<string, unknown>
  finalizeInput: CaptureFinalizeInput
  audio: CaptureArtifactUploadResponse | null | undefined
  audioRecording: CaptureRecordingResult | null
  replay: CaptureReplayRecorderStopResult | null | undefined
  replayRecording: CaptureReplayRecorderStopResult | null
  additionalArtifacts: unknown[]
  additionalUploadIndex: number
  offlineQueued: boolean
}

export class FeedbackCaptureController {
  private readonly backend: FeedbackCaptureBackend
  private readonly audioRecorder: FeedbackCaptureControllerDeps['audioRecorder']
  private readonly replayRecorder: FeedbackCaptureControllerDeps['replayRecorder']
  private readonly offlineQueue: FeedbackCaptureOfflineQueue | null
  private captureSessionId: string | null = null
  private audioStarted = false
  private replayStarted = false
  private currentStatus: FeedbackCaptureStatus = 'idle'
  private pendingStop: PendingStopState | null = null
  private startQueued = false
  private queuedStartMutationId: string | null = null

  constructor(deps: FeedbackCaptureControllerDeps) {
    this.backend = deps.backend
    this.audioRecorder = deps.audioRecorder ?? new AudioCaptureRecorder()
    this.replayRecorder = deps.replayRecorder ?? null
    this.offlineQueue = deps.offlineQueue ?? null
  }

  get status(): FeedbackCaptureStatus {
    return this.currentStatus
  }

  get activeCaptureSessionId(): string | null {
    return this.captureSessionId
  }

  get canRetryStop(): boolean {
    return this.currentStatus === 'error' && Boolean(this.captureSessionId && this.pendingStop)
  }

  async start(input: FeedbackCaptureStartInput): Promise<FeedbackCaptureSessionResponse> {
    if (this.currentStatus === 'recording') throw new Error('Feedback capture is already recording.')
    const startInput: FeedbackCaptureSessionInput = {
      ...input,
      mode: input.mode ?? 'feedback',
    }
    let session: FeedbackCaptureSessionResponse
    try {
      session = await this.backend.startSession(startInput)
      this.startQueued = false
      this.queuedStartMutationId = null
    } catch (error) {
      const queuedStartMutationId = await this.queueStartForOfflineReplay(startInput, error)
      if (!queuedStartMutationId) throw error
      this.startQueued = true
      this.queuedStartMutationId = queuedStartMutationId
      session = syntheticCaptureSessionResponse(startInput)
    }
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
      if (this.startQueued) await this.removeQueuedStartMutation().catch(() => undefined)
      this.startQueued = false
      this.queuedStartMutationId = null
      this.captureSessionId = null
      throw error
    }
  }

  async stop(input: FeedbackCaptureStopInput = {}): Promise<FeedbackCaptureStopResult> {
    const id = this.captureSessionId
    if (!id || (this.currentStatus !== 'recording' && !this.canRetryStop)) {
      throw new Error('Feedback capture is not recording.')
    }
    this.currentStatus = 'stopping'
    const pending = this.pendingStop ?? createPendingStopState(input)
    this.pendingStop = pending
    if (this.startQueued) {
      await this.stopLocalRecordersForOfflineReplay(pending)
      const queuedMutationIds = await this.queuePendingStopForOfflineReplay(
        id,
        pending,
        new Error('queued start'),
        true,
      )
      if (this.queuedStartMutationId) queuedMutationIds.unshift(this.queuedStartMutationId)
      this.currentStatus = 'queued'
      this.captureSessionId = null
      this.audioStarted = false
      this.replayStarted = false
      this.pendingStop = null
      this.startQueued = false
      this.queuedStartMutationId = null
      throw new FeedbackCaptureQueuedError(id, queuedMutationIds)
    }
    try {
      const audio = await this.ensureAudioUploaded(id, pending)
      const replay = await this.ensureReplayUploaded(id, pending)
      const additionalUploads = pending.input.additional_artifact_uploads ?? []
      while (pending.additionalUploadIndex < additionalUploads.length) {
        const upload = additionalUploads[pending.additionalUploadIndex]
        if (!upload) break
        pending.additionalArtifacts.push(await upload(id, pending.artifactMetadata))
        pending.additionalUploadIndex += 1
      }
      const finalize = await this.backend.finalizeSession(id, {
        category: 'record_feedback',
        ...pending.finalizeInput,
      })
      this.currentStatus = 'finalized'
      this.captureSessionId = null
      this.audioStarted = false
      this.replayStarted = false
      this.pendingStop = null
      return { capture_session_id: id, audio, replay, additional_artifacts: pending.additionalArtifacts, finalize }
    } catch (error) {
      let queuedMutationIds: string[]
      try {
        queuedMutationIds = await this.queuePendingStopForOfflineReplay(id, pending, error)
      } catch {
        this.currentStatus = 'error'
        throw error
      }
      if (queuedMutationIds.length > 0) {
        this.currentStatus = 'queued'
        this.captureSessionId = null
        this.audioStarted = false
        this.replayStarted = false
        this.pendingStop = null
        this.startQueued = false
        this.queuedStartMutationId = null
        throw new FeedbackCaptureQueuedError(id, queuedMutationIds)
      }
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
    this.pendingStop = null
    try {
      if (this.startQueued) {
        await this.removeQueuedStartMutation()
      } else if (id && this.backend.discardSession) {
        await this.backend.discardSession(id)
      }
      this.captureSessionId = null
      this.startQueued = false
      this.queuedStartMutationId = null
      this.currentStatus = 'discarded'
    } catch (error) {
      this.captureSessionId = id
      this.currentStatus = 'error'
      throw error
    }
  }

  private async queueStartForOfflineReplay(input: FeedbackCaptureSessionInput, error: unknown): Promise<string | null> {
    if (!this.offlineQueue || !isReplayableCaptureStopError(error)) return null
    const enqueue = this.offlineQueue.enqueueMutation ?? enqueueOfflineMutation
    const mutation = await enqueue('capture_session_start', {
      target: this.offlineQueue.target,
      input,
    })
    return mutation.id
  }

  private async removeQueuedStartMutation(): Promise<void> {
    const id = this.queuedStartMutationId
    if (!id) return
    const remove = this.offlineQueue?.removeMutation ?? removeOfflineMutation
    await remove(id)
    this.queuedStartMutationId = null
  }

  private async stopLocalRecordersForOfflineReplay(pending: PendingStopState): Promise<void> {
    if (this.audioRecorder && this.audioStarted && !pending.audioRecording) {
      pending.audioRecording = await this.audioRecorder.stop()
      this.audioStarted = false
    }
    if (this.replayRecorder && this.replayStarted && !pending.replayRecording) {
      pending.replayRecording = await this.replayRecorder.stop({
        capture_session_id: null,
        metadata: pending.artifactMetadata,
      })
      this.replayStarted = false
    }
  }

  private async ensureAudioUploaded(
    captureSessionId: string,
    pending: PendingStopState,
  ): Promise<CaptureArtifactUploadResponse | null> {
    if (pending.audio !== undefined) return pending.audio
    if (!this.audioRecorder) throw new Error('Audio recorder is not configured.')
    if (!pending.audioRecording) {
      if (!this.audioStarted) {
        pending.audio = null
        return null
      }
      pending.audioRecording = await this.audioRecorder.stop()
      this.audioStarted = false
    }
    const recorded = pending.audioRecording
    pending.audio = await this.uploadAudioRecording(captureSessionId, pending.artifactMetadata, recorded)
    return pending.audio
  }

  private async ensureReplayUploaded(
    captureSessionId: string,
    pending: PendingStopState,
  ): Promise<CaptureReplayRecorderStopResult | null> {
    if (pending.replay !== undefined) return pending.replay
    if (!this.replayStarted || !this.replayRecorder) {
      pending.replay = null
      return null
    }
    if (!pending.replayRecording) {
      pending.replayRecording = await this.replayRecorder.stop({
        capture_session_id: null,
        metadata: pending.artifactMetadata,
      })
      this.replayStarted = false
    }
    const recorded = pending.replayRecording
    const upload =
      recorded.upload ??
      (await this.backend.uploadArtifact(captureSessionId, {
        kind: 'rrweb',
        file: recorded.blob,
        fileName: 'replay.json',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          ...pending.artifactMetadata,
          source: 'capture_replay_recorder',
          artifact_type: 'capture.rrweb_replay',
          schema_version: 1,
          event_count: recorded.eventCount,
        },
      }))
    pending.replay = { ...recorded, upload }
    return pending.replay
  }

  private async queuePendingStopForOfflineReplay(
    captureSessionId: string,
    pending: PendingStopState,
    error: unknown,
    force = false,
  ): Promise<string[]> {
    if (!this.offlineQueue || pending.offlineQueued || (!force && !isReplayableCaptureStopError(error))) return []
    const additionalUploads = pending.input.additional_artifact_uploads ?? []
    const enqueue = this.offlineQueue.enqueueMutation ?? enqueueOfflineMutation
    const queuedMutationIds: string[] = []

    if (pending.audio === undefined && pending.audioRecording) {
      const mutation = await enqueue('capture_artifact_upload', {
        target: this.offlineQueue.target,
        captureSessionId,
        kind: 'audio',
        file: pending.audioRecording.blob,
        fileName: fileNameForAudio(pending.audioRecording.mime_type),
        duration_ms: pending.audioRecording.duration_ms,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          ...pending.artifactMetadata,
          mime_type: pending.audioRecording.mime_type,
        },
      })
      queuedMutationIds.push(mutation.id)
    }

    if (pending.replay === undefined && pending.replayRecording) {
      const mutation = await enqueue('capture_artifact_upload', {
        target: this.offlineQueue.target,
        captureSessionId,
        kind: 'rrweb',
        file: pending.replayRecording.blob,
        fileName: 'replay.json',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          ...pending.artifactMetadata,
          source: 'capture_replay_recorder',
          artifact_type: 'capture.rrweb_replay',
          schema_version: 1,
          event_count: pending.replayRecording.eventCount,
        },
      })
      queuedMutationIds.push(mutation.id)
    }

    const reachedAdditionalUploads = pending.additionalUploadIndex >= additionalUploads.length
    if (reachedAdditionalUploads || queuedMutationIds.length > 0) {
      const mutation = await enqueue('capture_session_finalize', {
        target: this.offlineQueue.target,
        captureSessionId,
        input: {
          category: 'record_feedback',
          ...pending.finalizeInput,
          offline_replay: true,
        },
      })
      queuedMutationIds.push(mutation.id)
    }

    pending.offlineQueued = queuedMutationIds.length > 0
    return queuedMutationIds
  }

  private uploadAudioRecording(
    captureSessionId: string,
    metadata: Record<string, unknown>,
    recorded: CaptureRecordingResult,
  ): Promise<CaptureArtifactUploadResponse> {
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

function createPendingStopState(input: FeedbackCaptureStopInput): PendingStopState {
  const {
    artifact_metadata: artifactMetadataInput,
    additional_artifact_uploads: _additionalUploads,
    ...finalizeInput
  } = input
  return {
    input,
    artifactMetadata: {
      source: 'record_feedback',
      ...(artifactMetadataInput ?? {}),
    },
    finalizeInput,
    audio: undefined,
    audioRecording: null,
    replay: undefined,
    replayRecording: null,
    additionalArtifacts: [],
    additionalUploadIndex: 0,
    offlineQueued: false,
  }
}

function syntheticCaptureSessionResponse(input: FeedbackCaptureSessionInput): FeedbackCaptureSessionResponse {
  const now = new Date().toISOString()
  return {
    capture_session: {
      id: input.capture_session_id,
      mode: input.mode ?? 'feedback',
      status: 'open',
      started_at: now,
      last_seen_at: now,
    },
  }
}

function fileNameForAudio(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('mp4') || lower.includes('m4a')) return 'audio.m4a'
  if (lower.includes('ogg')) return 'audio.ogg'
  if (lower.includes('wav')) return 'audio.wav'
  return 'audio.webm'
}

function isReplayableCaptureStopError(error: unknown): boolean {
  if (error instanceof NetworkError) return true
  if (error instanceof ApiError) return error.status === 408 || error.status === 429 || error.status >= 500
  if (error instanceof TypeError) return true
  if (error && typeof error === 'object') {
    const maybeStatus = (error as { status?: unknown }).status
    if (typeof maybeStatus === 'number') return maybeStatus === 408 || maybeStatus === 429 || maybeStatus >= 500
    const name = (error as { name?: unknown }).name
    if (name === 'NetworkError') return true
  }
  return false
}

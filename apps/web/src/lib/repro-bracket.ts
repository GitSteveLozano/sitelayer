// repro-bracket.ts — a user-bracketed "start condition → steps → end
// condition" recording, so a non-technical reviewer (Steve) can flag a problem
// in a way we can actually reproduce.
//
// The operator ask: "easily specify start/end conditions so we can reproduce
// issues." A reproduction bracket is the affordance for that. The user:
//
//   1. clicks "Start reproduction" right before doing the thing that breaks,
//   2. (optionally) presses "Mark this moment" when the bug actually happens —
//      as many times as they like, each mark is timestamped relative to start,
//   3. clicks "End & report" once the bug has shown itself.
//
// On start we snapshot the *start condition* (route + registered state
// providers) and begin a DOM-replay recording. Each mark appends a timestamped
// `repro.mark` event. On end we snapshot the *end condition*, stop the replay,
// and emit one structured `repro_bracket` summary artifact that ties the whole
// window together. Everything rides the existing capture session → events →
// artifacts → finalize spine, so it needs no schema change and lands in the
// same `context_work_items` triage queue as every other report.
//
// This controller is deliberately dependency-injected (every network call is an
// overridable dep) so the bracket logic is unit-testable without a browser or a
// live API.

import {
  appendCaptureSessionEvents,
  createCaptureSession,
  discardCaptureSession,
  finalizeCaptureSession,
  uploadCaptureArtifact,
  type CaptureArtifactUploadInput,
  type CaptureArtifactUploadResponse,
  type CaptureFinalizeInput,
  type CaptureFinalizeMark,
  type CaptureFinalizeResponse,
} from './api/capture-sessions'
import { buildReproBracketConsentScope } from './capture-policy'
import { uploadRegisteredCaptureStateSnapshots, type CaptureStateProviderUploadResult } from './capture-state-providers'

export const REPRO_EVENT_CLASS = 'repro'
export const REPRO_BRACKET_ARTIFACT_TYPE = 'capture.repro_bracket'
export const REPRO_BRACKET_SCHEMA_VERSION = 1

export type ReproBracketStatus = 'idle' | 'active' | 'ending' | 'ended' | 'discarded'

/** One timestamped "the bug is here" / "note this step" mark inside a bracket. */
export type ReproMark = {
  /** Milliseconds since the bracket started. */
  offset_ms: number
  /** Short human label, e.g. "the total is wrong now". */
  label: string
  /** ISO wall-clock time the mark was taken. */
  at: string
}

/** A `Pick` of the rrweb replay recorder so tests can pass a tiny fake. */
export type ReproReplayRecorder = {
  readonly supported: boolean
  start(): boolean
  stop(options?: { capture_session_id?: string | null; metadata?: Record<string, unknown> }): Promise<{
    eventCount: number
  }>
  cancel(): void
}

export type ReproBracketDeps = {
  createSession?: typeof createCaptureSession
  appendEvents?: typeof appendCaptureSessionEvents
  uploadArtifact?: (
    captureSessionId: string,
    input: CaptureArtifactUploadInput,
  ) => Promise<CaptureArtifactUploadResponse>
  uploadStateSnapshots?: typeof uploadRegisteredCaptureStateSnapshots
  finalizeSession?: typeof finalizeCaptureSession
  discardSession?: typeof discardCaptureSession
  /** rrweb recorder (or null to record no DOM replay). */
  replayRecorder?: ReproReplayRecorder | null
  /** Monotonic clock in ms (defaults to Date.now). Injected for tests. */
  now?: () => number
  /** ISO wall-clock (defaults to new Date().toISOString()). Injected for tests. */
  isoNow?: () => string
}

export type ReproBracketStartArgs = {
  captureSessionId: string
  companySlug: string
  routePath: string
  deviceKind: string
  platform: string
  viewport: string
  appBuildSha?: string
  consentVersion: string
  collabMode?: string | null
  /** What the reviewer is about to do — the "start condition" in words. */
  startNote?: string
  /** Record an rrweb DOM replay across the bracket (defaults to true). */
  domReplay?: boolean
  metadata?: Record<string, unknown>
}

export type ReproBracketEndArgs = {
  /** What went wrong — the "end condition" in words. */
  endNote?: string
  severity?: string
  lane?: string
  title?: string
  finalize?: Partial<CaptureFinalizeInput>
}

export type ReproBracketEndResult = {
  finalize: CaptureFinalizeResponse
  marks: ReproMark[]
  durationMs: number
  replayEventCount: number
}

export class ReproBracketError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReproBracketError'
  }
}

export class ReproBracketController {
  private readonly createSession: typeof createCaptureSession
  private readonly appendEvents: typeof appendCaptureSessionEvents
  private readonly uploadArtifact: ReproBracketDeps['uploadArtifact']
  private readonly uploadStateSnapshots: typeof uploadRegisteredCaptureStateSnapshots
  private readonly finalizeSession: typeof finalizeCaptureSession
  private readonly discardSession: typeof discardCaptureSession
  private readonly replayRecorder: ReproReplayRecorder | null
  private readonly now: () => number
  private readonly isoNow: () => string

  private currentStatus: ReproBracketStatus = 'idle'
  private captureSessionId: string | null = null
  private startedAtMs = 0
  private startedAtIso: string | null = null
  private replayActive = false
  private startNote: string | null = null
  private baseMetadata: Record<string, unknown> = {}
  private collabMode: string | null = null
  private readonly marksList: ReproMark[] = []

  constructor(deps: ReproBracketDeps = {}) {
    this.createSession = deps.createSession ?? createCaptureSession
    this.appendEvents = deps.appendEvents ?? appendCaptureSessionEvents
    this.uploadArtifact = deps.uploadArtifact ?? uploadCaptureArtifact
    this.uploadStateSnapshots = deps.uploadStateSnapshots ?? uploadRegisteredCaptureStateSnapshots
    this.finalizeSession = deps.finalizeSession ?? finalizeCaptureSession
    this.discardSession = deps.discardSession ?? discardCaptureSession
    this.replayRecorder = deps.replayRecorder ?? null
    this.now = deps.now ?? (() => Date.now())
    this.isoNow = deps.isoNow ?? (() => new Date().toISOString())
  }

  get status(): ReproBracketStatus {
    return this.currentStatus
  }

  get activeCaptureSessionId(): string | null {
    return this.captureSessionId
  }

  get marks(): ReproMark[] {
    return [...this.marksList]
  }

  get markCount(): number {
    return this.marksList.length
  }

  /** Whether a DOM replay is actually being recorded for this bracket. */
  get replayRecording(): boolean {
    return this.replayActive
  }

  /** Elapsed milliseconds since the bracket started (0 when not active). */
  elapsedMs(): number {
    if (this.currentStatus !== 'active' || !this.startedAtIso) return 0
    return Math.max(0, this.now() - this.startedAtMs)
  }

  async start(args: ReproBracketStartArgs): Promise<void> {
    if (this.currentStatus === 'active' || this.currentStatus === 'ending') {
      throw new ReproBracketError('A reproduction is already in progress.')
    }
    const domReplay = args.domReplay !== false && Boolean(this.replayRecorder?.supported)
    this.captureSessionId = args.captureSessionId
    this.startNote = args.startNote?.trim() || null
    this.collabMode = args.collabMode ?? null
    this.marksList.length = 0
    this.baseMetadata = {
      surface: 'authenticated_app',
      company_slug: args.companySlug,
      capture_profile: 'reproduction',
      route_path: args.routePath,
      ...(args.appBuildSha ? { app_build_sha: args.appBuildSha } : {}),
      ...(this.collabMode ? { collab_mode: this.collabMode } : {}),
      ...(args.metadata ?? {}),
    }

    await this.createSession({
      capture_session_id: args.captureSessionId,
      mode: 'feedback',
      consent_version: args.consentVersion,
      route_path: args.routePath,
      device_kind: args.deviceKind,
      platform: args.platform,
      viewport: args.viewport,
      ...(args.appBuildSha ? { app_build_sha: args.appBuildSha } : {}),
      metadata: this.baseMetadata,
      consent_scope: buildReproBracketConsentScope({ domReplay }),
    })

    this.replayActive = domReplay ? Boolean(this.replayRecorder?.start()) : false
    this.startedAtMs = this.now()
    this.startedAtIso = this.isoNow()
    this.currentStatus = 'active'

    await this.append('repro.bracket_started', {
      started_at: this.startedAtIso,
      dom_replay: this.replayActive,
      ...(this.startNote ? { start_note_length: this.startNote.length } : {}),
    }).catch(() => undefined)

    await this.uploadStateSnapshots(args.captureSessionId, {
      reason: 'repro_start',
      metadata: { ...this.baseMetadata, trigger: 'repro_start' },
    }).catch(() => undefined)
  }

  /**
   * Mark a moment inside the active bracket ("the bug is here"). Returns the
   * recorded mark. Best-effort: a failed event append never throws — the local
   * mark still counts toward the summary artifact emitted at end.
   */
  async mark(label?: string): Promise<ReproMark> {
    if (this.currentStatus !== 'active' || !this.captureSessionId) {
      throw new ReproBracketError('No active reproduction to mark.')
    }
    const mark: ReproMark = {
      offset_ms: Math.max(0, this.now() - this.startedAtMs),
      label: label?.trim() || `Mark ${this.marksList.length + 1}`,
      at: this.isoNow(),
    }
    this.marksList.push(mark)
    await this.append('repro.mark', {
      offset_ms: mark.offset_ms,
      label: mark.label,
      index: this.marksList.length,
    }).catch(() => undefined)
    return mark
  }

  async end(args: ReproBracketEndArgs = {}): Promise<ReproBracketEndResult> {
    if (this.currentStatus !== 'active' || !this.captureSessionId) {
      throw new ReproBracketError('No active reproduction to end.')
    }
    const captureSessionId = this.captureSessionId
    this.currentStatus = 'ending'
    const endedAtIso = this.isoNow()
    const durationMs = Math.max(0, this.now() - this.startedAtMs)
    const endNote = args.endNote?.trim() || null

    let replayEventCount = 0
    if (this.replayActive && this.replayRecorder) {
      const stop = await this.replayRecorder
        .stop({
          capture_session_id: captureSessionId,
          metadata: { ...this.baseMetadata, source: 'repro_bracket', trigger: 'repro_end' },
        })
        .catch(() => ({ eventCount: 0 }))
      replayEventCount = stop.eventCount
    }

    await this.append('repro.bracket_ended', {
      ended_at: endedAtIso,
      duration_ms: durationMs,
      mark_count: this.marksList.length,
      replay_event_count: replayEventCount,
      ...(endNote ? { end_note_length: endNote.length } : {}),
    }).catch(() => undefined)

    await this.uploadStateSnapshots(captureSessionId, {
      reason: 'repro_end',
      metadata: { ...this.baseMetadata, trigger: 'repro_end' },
    }).catch(() => undefined)

    const summary = this.buildSummary({ captureSessionId, endedAtIso, durationMs, endNote, replayEventCount })
    await this.uploadArtifact!(captureSessionId, {
      kind: 'repro_bracket',
      file: new Blob([JSON.stringify(summary)], { type: 'application/json' }),
      fileName: 'repro-bracket.json',
      pii_level: 'internal',
      access_policy: 'support_only',
      metadata: {
        ...this.baseMetadata,
        source: 'repro_bracket',
        artifact_type: REPRO_BRACKET_ARTIFACT_TYPE,
        schema_version: REPRO_BRACKET_SCHEMA_VERSION,
        mark_count: this.marksList.length,
        duration_ms: durationMs,
      },
    }).catch(() => undefined)

    const summaryText = this.buildWorkItemSummary({ endNote, durationMs })
    const routePath = this.routePath()
    // Surface the N collected marks to the backend (STEP5). When there is at
    // least one mark the finalize payload carries `marks[]`, which relaxes the
    // server's 1:1 capture_session_finalize dedupe to per-slice: one work_item
    // per mark/mark-pair, each anchored from->to. With zero marks we omit the
    // field entirely so the single-work_item path is unchanged.
    const finalizeMarks: CaptureFinalizeMark[] = this.marksList.map((mark, index) => ({
      offset_ms: mark.offset_ms,
      label: mark.label,
      at: mark.at,
      index: index + 1,
    }))
    const finalize = await this.finalizeSession(captureSessionId, {
      title: args.title ?? 'Reproduction report',
      summary: summaryText,
      severity: args.severity ?? 'normal',
      lane: args.lane ?? 'triage',
      ...(routePath ? { route_path: routePath } : {}),
      category: 'reproduction',
      ...(finalizeMarks.length ? { marks: finalizeMarks } : {}),
      ...(args.finalize ?? {}),
    })

    this.currentStatus = 'ended'
    return { finalize, marks: [...this.marksList], durationMs, replayEventCount }
  }

  /** Abandon the bracket without filing a report. Best-effort cleanup. */
  async discard(): Promise<void> {
    const captureSessionId = this.captureSessionId
    if (this.replayActive) this.replayRecorder?.cancel()
    this.replayActive = false
    if (captureSessionId && (this.currentStatus === 'active' || this.currentStatus === 'ending')) {
      await this.append('repro.bracket_ended', { discarded: true }).catch(() => undefined)
      await this.discardSession(captureSessionId, {
        metadata: { ...this.baseMetadata, source: 'repro_bracket', discarded: true },
      }).catch(() => undefined)
    }
    this.currentStatus = 'discarded'
  }

  private routePath(): string | undefined {
    return typeof this.baseMetadata.route_path === 'string' ? this.baseMetadata.route_path : undefined
  }

  private async append(eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.captureSessionId) return
    const routePath = this.routePath()
    await this.appendEvents(this.captureSessionId, [
      {
        client_event_id: `${eventType}:${this.now()}:${this.marksList.length}`,
        event_type: eventType,
        event_class: REPRO_EVENT_CLASS,
        ...(routePath ? { route_path: routePath } : {}),
        occurred_at: this.isoNow(),
        payload: { ...payload, ...(this.collabMode ? { collab_mode: this.collabMode } : {}) },
      },
    ])
  }

  private buildSummary(input: {
    captureSessionId: string
    endedAtIso: string
    durationMs: number
    endNote: string | null
    replayEventCount: number
  }): Record<string, unknown> {
    return {
      schema_version: REPRO_BRACKET_SCHEMA_VERSION,
      artifact_type: REPRO_BRACKET_ARTIFACT_TYPE,
      capture_session_id: input.captureSessionId,
      route_path: this.baseMetadata.route_path ?? null,
      app_build_sha: this.baseMetadata.app_build_sha ?? null,
      collab_mode: this.collabMode,
      started_at: this.startedAtIso,
      ended_at: input.endedAtIso,
      duration_ms: input.durationMs,
      window_ms: { start: 0, end: input.durationMs, relative_to: 'repro_started' },
      start_condition: { note: this.startNote, snapshot_reason: 'repro_start' },
      end_condition: { note: input.endNote, snapshot_reason: 'repro_end' },
      marks: this.marksList.map((mark) => ({ ...mark })),
      replay: { enabled: this.replayActive, event_count: input.replayEventCount },
    }
  }

  private buildWorkItemSummary(input: { endNote: string | null; durationMs: number }): string {
    const seconds = Math.round(input.durationMs / 100) / 10
    const lines: string[] = []
    if (this.startNote) lines.push(`Start: ${this.startNote}`)
    if (input.endNote) lines.push(`Problem: ${input.endNote}`)
    if (this.marksList.length) {
      lines.push(
        `Marks (${this.marksList.length}): ` +
          this.marksList.map((mark) => `${formatOffset(mark.offset_ms)} ${mark.label}`).join('; '),
      )
    }
    lines.push(`Reproduction window: ${seconds}s${this.replayActive ? ' with screen replay' : ''}.`)
    return lines.join('\n')
  }
}

function formatOffset(offsetMs: number): string {
  const totalSeconds = Math.floor(offsetMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`
}

export type ReproBracketSnapshotUpload = CaptureStateProviderUploadResult

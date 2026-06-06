import { describe, expect, it, vi } from 'vitest'
import {
  ReproBracketController,
  ReproBracketError,
  REPRO_BRACKET_ARTIFACT_TYPE,
  REPRO_EVENT_CLASS,
  type ReproBracketDeps,
  type ReproReplayRecorder,
} from './repro-bracket'

type Recorded = {
  createSession: ReturnType<typeof vi.fn>
  appendEvents: ReturnType<typeof vi.fn>
  uploadArtifact: ReturnType<typeof vi.fn>
  uploadStateSnapshots: ReturnType<typeof vi.fn>
  finalizeSession: ReturnType<typeof vi.fn>
  discardSession: ReturnType<typeof vi.fn>
}

function fakeReplay(eventCount = 7): ReproReplayRecorder & { started: boolean; canceled: boolean } {
  return {
    supported: true,
    started: false,
    canceled: false,
    start() {
      this.started = true
      return true
    },
    async stop() {
      return { eventCount }
    },
    cancel() {
      this.canceled = true
    },
  }
}

function makeController(overrides: Record<string, unknown> = {}): {
  controller: ReproBracketController
  deps: Recorded
  clock: { ms: number }
} {
  const clock = { ms: 1_000 }
  const deps: Recorded = {
    createSession: vi.fn(async () => ({
      capture_session: { id: 's1', mode: 'feedback', status: 'open', started_at: '', last_seen_at: '' },
    })),
    appendEvents: vi.fn(async () => ({ accepted: 1 })),
    uploadArtifact: vi.fn(async () => ({
      artifact: {
        id: 'a1',
        kind: 'repro_bracket',
        storage_key: 'k',
        content_type: 'application/json',
        byte_size: 1,
        content_hash: 'h',
        redaction_version: 'v1',
      },
    })),
    uploadStateSnapshots: vi.fn(async () => []),
    finalizeSession: vi.fn(async () => ({
      work_item: {
        id: 'w1',
        title: 'Reproduction report',
        summary: '',
        status: 'new',
        lane: 'triage',
        severity: 'normal',
        route: '/desktop',
        capture_session_id: 's1',
      },
      support_packet: { id: 'p1', expires_at: null },
      event: null,
    })),
    discardSession: vi.fn(async () => ({
      capture_session: { id: 's1', mode: 'feedback', status: 'discarded', started_at: '', last_seen_at: '' },
    })),
  }
  const config = {
    createSession: deps.createSession,
    appendEvents: deps.appendEvents,
    uploadArtifact: deps.uploadArtifact,
    uploadStateSnapshots: deps.uploadStateSnapshots,
    finalizeSession: deps.finalizeSession,
    discardSession: deps.discardSession,
    now: () => clock.ms,
    isoNow: () => new Date(clock.ms).toISOString(),
    ...overrides,
  } as unknown as ReproBracketDeps
  const controller = new ReproBracketController(config)
  return { controller, deps, clock }
}

const START_ARGS = {
  captureSessionId: 's1',
  companySlug: 'e2e-fixtures',
  routePath: '/desktop',
  deviceKind: 'desktop',
  platform: 'test',
  viewport: '1440x900',
  appBuildSha: 'abc123',
  consentVersion: 'authenticated-feedback-v1',
  collabMode: 'steve',
  startNote: 'about to push the estimate',
}

describe('ReproBracketController', () => {
  it('creates a feedback session with a repro consent scope and snapshots the start condition', async () => {
    const replay = fakeReplay()
    const { controller, deps } = makeController({ replayRecorder: replay })

    await controller.start(START_ARGS)

    expect(controller.status).toBe('active')
    expect(replay.started).toBe(true)
    expect(controller.replayRecording).toBe(true)

    const sessionInput = deps.createSession.mock.calls[0]![0]
    expect(sessionInput.mode).toBe('feedback')
    expect(sessionInput.consent_scope.artifacts.repro_bracket).toBe(true)
    expect(sessionInput.consent_scope.event_classes).toContain(REPRO_EVENT_CLASS)
    expect(sessionInput.consent_scope.dom_replay).toBe(true)

    // Start condition snapshot is taken with the repro_start reason.
    expect(deps.uploadStateSnapshots).toHaveBeenCalledWith('s1', expect.objectContaining({ reason: 'repro_start' }))
    // bracket_started event carries the repro event class.
    const startedEvent = deps.appendEvents.mock.calls[0]![1][0]
    expect(startedEvent.event_type).toBe('repro.bracket_started')
    expect(startedEvent.event_class).toBe(REPRO_EVENT_CLASS)
    expect(startedEvent.payload.collab_mode).toBe('steve')
  })

  it('records timestamped marks relative to the start', async () => {
    const { controller, clock } = makeController({ replayRecorder: fakeReplay() })
    await controller.start(START_ARGS)

    clock.ms = 4_000
    const first = await controller.mark('total looks wrong')
    clock.ms = 9_500
    const second = await controller.mark()

    expect(first.offset_ms).toBe(3_000)
    expect(first.label).toBe('total looks wrong')
    expect(second.offset_ms).toBe(8_500)
    expect(second.label).toBe('Mark 2')
    expect(controller.markCount).toBe(2)
  })

  it('stops replay, emits the repro_bracket summary artifact, and finalizes', async () => {
    const replay = fakeReplay(12)
    const { controller, deps, clock } = makeController({ replayRecorder: replay })
    await controller.start(START_ARGS)
    clock.ms = 5_000
    await controller.mark('here')
    clock.ms = 20_000

    const result = await controller.end({ endNote: 'estimate total doubled' })

    expect(result.durationMs).toBe(19_000)
    expect(result.replayEventCount).toBe(12)
    expect(controller.status).toBe('ended')

    // Exactly one repro_bracket artifact, with a structured summary payload.
    const uploadCalls = deps.uploadArtifact.mock.calls as Array<[string, { kind: string; file: Blob }]>
    const reproUpload = uploadCalls.find((call) => call[1].kind === 'repro_bracket')
    expect(reproUpload).toBeTruthy()
    const summary = JSON.parse(await reproUpload![1].file.text())
    expect(summary.artifact_type).toBe(REPRO_BRACKET_ARTIFACT_TYPE)
    expect(summary.duration_ms).toBe(19_000)
    expect(summary.window_ms).toEqual({ start: 0, end: 19_000, relative_to: 'repro_started' })
    expect(summary.start_condition.note).toBe('about to push the estimate')
    expect(summary.end_condition.note).toBe('estimate total doubled')
    expect(summary.marks).toHaveLength(1)
    expect(summary.marks[0].label).toBe('here')
    expect(summary.replay).toEqual({ enabled: true, event_count: 12 })

    // End condition snapshot + finalize with the reproduction category.
    expect(deps.uploadStateSnapshots).toHaveBeenCalledWith('s1', expect.objectContaining({ reason: 'repro_end' }))
    const finalizeInput = deps.finalizeSession.mock.calls[0]![1]
    expect(finalizeInput.category).toBe('reproduction')
    expect(finalizeInput.summary).toContain('Problem: estimate total doubled')
  })

  it('runs without a DOM replay recorder (note-only reproduction)', async () => {
    const { controller, deps } = makeController({ replayRecorder: null })
    await controller.start({ ...START_ARGS, domReplay: false })
    expect(controller.replayRecording).toBe(false)
    const sessionInput = deps.createSession.mock.calls[0]![0]
    expect(sessionInput.consent_scope.dom_replay).toBe(false)
    expect(sessionInput.consent_scope.artifacts.rrweb).toBeUndefined()

    const result = await controller.end({ endNote: 'no replay here' })
    expect(result.replayEventCount).toBe(0)
  })

  it('discards an active bracket without finalizing', async () => {
    const replay = fakeReplay()
    const { controller, deps } = makeController({ replayRecorder: replay })
    await controller.start(START_ARGS)
    await controller.discard()

    expect(controller.status).toBe('discarded')
    expect(replay.canceled).toBe(true)
    expect(deps.discardSession).toHaveBeenCalledWith('s1', expect.objectContaining({ metadata: expect.any(Object) }))
    expect(deps.finalizeSession).not.toHaveBeenCalled()
  })

  it('rejects marking or ending when no bracket is active', async () => {
    const { controller } = makeController()
    await expect(controller.mark()).rejects.toBeInstanceOf(ReproBracketError)
    await expect(controller.end()).rejects.toBeInstanceOf(ReproBracketError)
  })

  it('keeps the local mark even if the event append fails', async () => {
    const appendEvents = vi
      .fn()
      .mockResolvedValueOnce({ accepted: 1 }) // bracket_started
      .mockRejectedValueOnce(new Error('offline')) // mark
    const { controller, clock } = makeController({
      replayRecorder: fakeReplay(),
      appendEvents: appendEvents as unknown as ReproBracketDeps['appendEvents'],
    })
    await controller.start(START_ARGS)
    clock.ms = 2_000
    const mark = await controller.mark('still counts')
    expect(mark.offset_ms).toBe(1_000)
    expect(controller.markCount).toBe(1)
  })
})

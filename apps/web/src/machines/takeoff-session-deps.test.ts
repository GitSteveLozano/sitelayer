import { describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'
import type { QueryClient } from '@tanstack/react-query'
import type { CaptureResponse, DraftResultResponse, PromoteResponse, TakeoffDraft } from '@/lib/api/takeoff-drafts'
import { createTakeoffSessionApiDeps, type TakeoffCaptureApi } from './takeoff-session-deps'
import { createTakeoffSessionMachine, takeoffSessionSeedActor } from './takeoff-session'

/**
 * Behavioral tests for the MACHINE-DRIVEN capture → review → promote loop
 * (wave-3 est-canvas review convergence): the real `takeoff-session` machine
 * wired through `createTakeoffSessionApiDeps`, with only the WIRE faked
 * (capture / result-poll / promote endpoints). This is the ratchet that the
 * machine speaks the wave-2 async capture contract: POST /capture → 202 →
 * poll /result until ready/failed, honest mode from `capture_provenance`,
 * promote against the capture-created draft.
 */

const PROJECT_ID = 'p-1'
const CAPTURE_DRAFT_ID = 'd-cap-1'

function makeDraft(overrides: Partial<TakeoffDraft> = {}): TakeoffDraft {
  return {
    id: CAPTURE_DRAFT_ID,
    company_id: 'c-1',
    project_id: PROJECT_ID,
    name: 'AI capture',
    type: 'measurement',
    status: 'active',
    version: 1,
    source: 'blueprint_vision',
    deleted_at: null,
    created_at: '2026-06-12T00:00:00Z',
    updated_at: '2026-06-12T00:00:00Z',
    ...overrides,
  }
}

function processingCaptureResponse(): CaptureResponse {
  return {
    draft: makeDraft({ capture_status: 'processing' }),
    result_summary: {
      status: 'processing',
      provider: 'gemini',
      quantities_count: 0,
      review_required: false,
      mode: 'live',
    },
  }
}

function readyCaptureResponse(mode: 'live' | 'dry-run' = 'dry-run'): CaptureResponse {
  return {
    draft: makeDraft({ capture_status: 'ready' }),
    result_summary: { status: 'ready', quantities_count: 2, review_required: true, mode },
  }
}

function readyResult(provenance: NonNullable<DraftResultResponse['provenance']> | null): DraftResultResponse {
  return {
    status: 'ready',
    takeoff_result: {
      schemaVersion: '1',
      takeoffId: 't-1',
      projectId: PROJECT_ID,
      source: 'blueprint_vision',
      pipelineVersion: '1.0.0',
      quantities: [
        { id: 'q1', description: 'EPS wall', unit: 'sqft', value: 2400, confidence: 0.93 },
        { id: 'q2', description: 'Basecoat', unit: 'lf', value: 320, confidence: 0.42 },
      ],
    },
    source: 'blueprint_vision',
    review_required: true,
    pipeline_version: '1.0.0',
    provenance,
  }
}

function processingResult(): DraftResultResponse {
  return {
    status: 'processing',
    takeoff_result: null,
    source: 'blueprint_vision',
    review_required: false,
    pipeline_version: null,
    provenance: null,
  }
}

function failedResult(error: string): DraftResultResponse {
  return {
    status: 'failed',
    error,
    takeoff_result: null,
    source: 'blueprint_vision',
    review_required: false,
    pipeline_version: null,
    provenance: null,
  }
}

const promoteResponse: PromoteResponse = { measurements: [], promoted_count: 1, skipped_count: 0, skipped: [] }

interface Harness {
  api: TakeoffCaptureApi
  invalidateQueries: ReturnType<typeof vi.fn>
  queryClient: QueryClient
}

/** Fake wire: capture answers once, fetchResult walks through `resultPages`
 *  in order (sticking on the last), promote records its args. */
function makeHarness(input: { capture?: CaptureResponse; resultPages: DraftResultResponse[] }): Harness {
  let pollCount = 0
  const invalidateQueries = vi.fn()
  const api: TakeoffCaptureApi = {
    capture: vi.fn(async () => input.capture ?? processingCaptureResponse()),
    fetchResult: vi.fn(async () => {
      const page = input.resultPages[Math.min(pollCount, input.resultPages.length - 1)]!
      pollCount += 1
      return page
    }),
    promote: vi.fn(async () => promoteResponse),
    sleep: vi.fn(async () => undefined),
  }
  return { api, invalidateQueries, queryClient: { invalidateQueries } as unknown as QueryClient }
}

function startWiredActor(harness: Harness, options: { maxPollMs?: number } = {}) {
  const deps = createTakeoffSessionApiDeps({
    queryClient: harness.queryClient,
    api: harness.api,
    ...(options.maxPollMs !== undefined ? { maxPollMs: options.maxPollMs } : {}),
  })
  const machine = createTakeoffSessionMachine(deps)
  const actor = createActor(machine, {
    input: { projectId: PROJECT_ID, companySlug: 'acme', blueprintId: 'b-1', pageId: 'pg-1', draftId: 'd-session' },
  })
  actor.start()
  return actor
}

describe('takeoff-session + real api deps: machine-driven capture → review → promote', () => {
  it('happy path: 202 processing → poll → ready (gemini-live) → review → promote against the capture draft', async () => {
    const harness = makeHarness({
      capture: processingCaptureResponse(),
      // Two processing polls before the worker settles it — exercises the loop.
      resultPages: [processingResult(), processingResult(), readyResult('gemini-live')],
    })
    const actor = startWiredActor(harness)
    await waitFor(actor, (s) => s.matches('idle'))

    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'live' })
    actor.send({ type: 'RUN_CAPTURE' })
    await waitFor(actor, (s) => s.matches({ capturing: 'reviewing' }))

    // The wire saw the async contract: one POST /capture (live ⇒ bare payload,
    // no dryRun pin), then polls until the status left 'processing'.
    expect(harness.api.capture).toHaveBeenCalledWith(PROJECT_ID, { kind: 'blueprint_vision', payload: {} })
    expect(harness.api.fetchResult).toHaveBeenCalledTimes(3)
    expect(vi.mocked(harness.api.fetchResult)).toHaveBeenCalledWith(CAPTURE_DRAFT_ID)

    // Honest state: result loaded, server-resolved live mode, capture draft id.
    const ctx = actor.getSnapshot().context
    expect(ctx.capture.mode).toBe('live')
    expect(ctx.capture.draftId).toBe(CAPTURE_DRAFT_ID)
    expect((ctx.capture.result as { quantities: unknown[] }).quantities).toHaveLength(2)
    expect(ctx.error).toBeNull()

    // Review + promote through the machine.
    actor.send({ type: 'REVIEW_DECISION', quantityId: 'q1', decision: 'accept' })
    actor.send({ type: 'PROMOTE', quantityIds: ['q1'] })
    await waitFor(actor, (s) => s.matches('idle'))

    // Promote hit the REAL endpoint shape against the capture-created draft —
    // NOT the session's pre-capture draft.
    expect(harness.api.promote).toHaveBeenCalledWith(PROJECT_ID, CAPTURE_DRAFT_ID, { quantity_ids: ['q1'] })
    // Capture slice reset after promote.
    expect(actor.getSnapshot().context.capture.result).toBeNull()
    expect(actor.getSnapshot().context.capture.draftId).toBeNull()
    // Panels rendering off TanStack Query get the same invalidations the
    // mutation hooks issue.
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['takeoff'] })
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['estimate'] })
  })

  it('failed capture: provider error rejects the run — no stub rows, error surfaced, back to configuring', async () => {
    const harness = makeHarness({
      capture: processingCaptureResponse(),
      resultPages: [processingResult(), failedResult('Gemini: 500 model overloaded')],
    })
    const actor = startWiredActor(harness)
    await waitFor(actor, (s) => s.matches('idle'))

    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'live' })
    actor.send({ type: 'RUN_CAPTURE' })
    await waitFor(actor, (s) => s.matches({ capturing: 'configuring' }) && s.context.error !== null)

    const ctx = actor.getSnapshot().context
    expect(ctx.error).toBe('Gemini: 500 model overloaded')
    // Provider errors NEVER produce reviewable rows.
    expect(ctx.capture.result).toBeNull()
    expect(harness.api.promote).not.toHaveBeenCalled()
  })

  it('dry-run path: pins dryRun:true, lands synchronously, chip stays DEMO (stub-dry-run)', async () => {
    const harness = makeHarness({
      capture: readyCaptureResponse('dry-run'),
      resultPages: [readyResult('stub-dry-run')],
    })
    const actor = startWiredActor(harness)
    await waitFor(actor, (s) => s.matches('idle'))

    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'dry-run' })
    actor.send({ type: 'RUN_CAPTURE' })
    await waitFor(actor, (s) => s.matches({ capturing: 'reviewing' }))

    expect(harness.api.capture).toHaveBeenCalledWith(PROJECT_ID, {
      kind: 'blueprint_vision',
      payload: { dryRun: true },
    })
    // No poll loop needed for a synchronous 201 — a single result fetch.
    expect(harness.api.fetchResult).toHaveBeenCalledTimes(1)
    expect(harness.api.sleep).not.toHaveBeenCalled()
    expect(actor.getSnapshot().context.capture.mode).toBe('dry-run')
  })

  it('honesty downgrade: a LIVE request that the server stubbed out reads dry-run, never LIVE', async () => {
    const harness = makeHarness({
      // Live env missing server-side ⇒ synchronous stub 201 with demo rows.
      capture: readyCaptureResponse('dry-run'),
      resultPages: [readyResult('stub-dry-run')],
    })
    const actor = startWiredActor(harness)
    await waitFor(actor, (s) => s.matches('idle'))

    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'live' })
    actor.send({ type: 'RUN_CAPTURE' })
    await waitFor(actor, (s) => s.matches({ capturing: 'reviewing' }))

    // The overlay chip reads the POST-run truth: stub output is DEMO.
    expect(actor.getSnapshot().context.capture.mode).toBe('dry-run')
  })

  it('poll ceiling: a never-settling worker surfaces an error instead of spinning forever', async () => {
    const harness = makeHarness({
      capture: processingCaptureResponse(),
      resultPages: [processingResult()],
    })
    const actor = startWiredActor(harness, { maxPollMs: 0 })
    await waitFor(actor, (s) => s.matches('idle'))

    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'live' })
    actor.send({ type: 'RUN_CAPTURE' })
    await waitFor(actor, (s) => s.matches({ capturing: 'configuring' }) && s.context.error !== null)

    expect(actor.getSnapshot().context.error).toMatch(/still running/i)
  })

  it('promote without a capture draft (seeded review, no run) fails loudly and stays reviewing', async () => {
    const harness = makeHarness({ resultPages: [readyResult('stub-dry-run')] })
    const deps = createTakeoffSessionApiDeps({ queryClient: harness.queryClient, api: harness.api })
    const machine = createTakeoffSessionMachine(deps)
    // Seeded straight into reviewing — capture.draftId AND session draftId null.
    const actor = takeoffSessionSeedActor(machine, {
      value: { capturing: 'reviewing' },
      context: {
        projectId: PROJECT_ID,
        companySlug: 'acme',
        capture: { kind: 'blueprint_vision', mode: 'dry-run', result: { quantities: [] } },
      },
    })
    actor.start()
    actor.send({ type: 'PROMOTE', quantityIds: ['q1'] })
    await waitFor(actor, (s) => s.matches({ capturing: 'reviewing' }) && s.context.error !== null)

    expect(actor.getSnapshot().context.error).toMatch(/no capture draft/i)
    expect(harness.api.promote).not.toHaveBeenCalled()
  })
})

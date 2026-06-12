import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * AI auto-takeoff tests.
 *
 * SETUP float: the "ADD TARGET" control is an HONEST disabled affordance, not
 * a silent no-op (custom symbol→item targets have no backend yet).
 *
 * REVIEW (async-capture split 2026-06-12): a LIVE capture is 202-accepted and
 * runs on the worker, so the review screen must
 *   - render an explicit in-progress state while the draft result polls at
 *     status='processing' (and never the demo badge over nothing);
 *   - surface the provider error with a "run again" retry (fresh POST
 *     /capture) at status='failed' — zero fabricated rows;
 *   - key the demo-vs-live badge off the server's `provenance` discriminator
 *     ('stub-dry-run' = demo, '*-live' = real read) instead of trusting the
 *     navigation-state capture mode.
 */

const mocks = vi.hoisted(() => ({
  useCaptureTakeoffDraft: vi.fn(),
  useCaptureBlueprintVisionLive: vi.fn(),
  useBlueprintVisionLiveAvailable: vi.fn(),
  useProjectBlueprints: vi.fn(),
  useTakeoffDraftResult: vi.fn(),
  usePromoteCapturedQuantities: vi.fn(),
  useTakeoffDrafts: vi.fn(),
}))

// Keep the module's pure helpers (draftResultStatus / isLiveProvenance /
// promoteRejectionsFromError) REAL — the review screen's state derivation is
// part of what's under test — and mock only the data hooks.
vi.mock('../../lib/api/takeoff-drafts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/takeoff-drafts.js')>()
  return {
    ...actual,
    fetchBlueprintFile: vi.fn(),
    useBlueprintVisionLiveAvailable: mocks.useBlueprintVisionLiveAvailable,
    useCaptureBlueprintVisionLive: mocks.useCaptureBlueprintVisionLive,
    useCaptureTakeoffDraft: mocks.useCaptureTakeoffDraft,
    useTakeoffDraftResult: mocks.useTakeoffDraftResult,
    usePromoteCapturedQuantities: mocks.usePromoteCapturedQuantities,
    useTakeoffDrafts: mocks.useTakeoffDrafts,
  }
})
vi.mock('../../lib/api/takeoff.js', () => ({ useProjectBlueprints: mocks.useProjectBlueprints }))

import { EstAiTakeoffSetupPanel, TakeoffAiTakeoffReview } from './takeoff-ai-takeoff'

const DEMO_TITLE = /DEMO DATA · NOT A REAL AI SHEET READ/i
const LIVE_TITLE = /AI READ · REVIEW REQUIRED/i

/** Minimal ready TakeoffResult slice the review table consumes. */
const READY_RESULT = {
  schemaVersion: '1.0',
  takeoffId: 't-1',
  projectId: 'p1',
  source: 'blueprint_vision',
  pipelineVersion: '1.0.0',
  quantities: [
    { id: 'q1', description: 'EPS · exterior walls', unit: 'sqft', value: 1200, confidence: 0.9 },
    { id: 'q2', description: 'Sealant joints', unit: 'lf', value: 300, confidence: 0.55 },
  ],
}

function draftResult(overrides: Record<string, unknown>) {
  return {
    data: {
      status: 'ready',
      error: null,
      takeoff_result: READY_RESULT,
      source: 'blueprint_vision',
      review_required: false,
      pipeline_version: '1.0.0',
      provenance: null,
      token_usage: null,
      ...overrides,
    },
    isLoading: false,
    isError: false,
    error: null,
  }
}

function renderReview(state: { draftId: string; mode?: 'live' | 'dry-run' }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/projects/p1/takeoff-ai/takeoff/review', state }]}>
      <Routes>
        <Route
          path="/projects/:projectId/takeoff-ai/takeoff/review"
          element={<TakeoffAiTakeoffReview companySlug="acme" />}
        />
        <Route path="*" element={<div />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.useCaptureTakeoffDraft.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null })
  mocks.useCaptureBlueprintVisionLive.mockReturnValue({ mutateAsync: vi.fn(), isPending: false, error: null })
  mocks.useBlueprintVisionLiveAvailable.mockReturnValue({ data: false })
  mocks.useProjectBlueprints.mockReturnValue({ data: { blueprints: [] } })
  mocks.useTakeoffDraftResult.mockReturnValue(draftResult({}))
  mocks.usePromoteCapturedQuantities.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null })
  mocks.useTakeoffDrafts.mockReturnValue({ data: { drafts: [] } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AI auto-takeoff SETUP — ADD TARGET affordance', () => {
  it('renders ADD TARGET as a disabled, non-clickable control with a reason', () => {
    render(
      <MemoryRouter>
        <EstAiTakeoffSetupPanel projectId="p1" onClose={() => {}} onReviewDraft={() => {}} />
      </MemoryRouter>,
    )
    const btn = screen.getByText(/ADD TARGET/i).closest('button')
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn?.getAttribute('title') ?? '').toMatch(/coming soon/i)
  })
})

describe('AI auto-takeoff REVIEW — async capture states', () => {
  it('renders an explicit in-progress state while the capture is processing (no badges)', () => {
    mocks.useTakeoffDraftResult.mockReturnValue(
      draftResult({ status: 'processing', takeoff_result: null, review_required: false, provenance: null }),
    )
    renderReview({ draftId: 'd1', mode: 'live' })
    // Both responsive layouts are in the DOM (CSS-gated), so use getAllBy*.
    expect(screen.getAllByText(/AI READ IN PROGRESS/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Reading your blueprint…/i).length).toBeGreaterThan(0)
    // No quantities exist — neither the demo nor the live badge may render.
    expect(screen.queryAllByText(DEMO_TITLE)).toHaveLength(0)
    expect(screen.queryAllByText(LIVE_TITLE)).toHaveLength(0)
  })

  it('surfaces the provider error on failed and retries via a fresh capture POST', () => {
    const captureMutate = vi.fn()
    mocks.useCaptureTakeoffDraft.mockReturnValue({ mutate: captureMutate, isPending: false, error: null })
    mocks.useTakeoffDraftResult.mockReturnValue(
      draftResult({ status: 'failed', error: 'Gemini: quota exhausted', takeoff_result: null, provenance: null }),
    )
    renderReview({ draftId: 'd1', mode: 'live' })

    expect(screen.getAllByText(/AI READ FAILED/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Gemini: quota exhausted/i).length).toBeGreaterThan(0)
    // A failed read never shows the demo badge over fabricated rows.
    expect(screen.queryAllByText(DEMO_TITLE)).toHaveLength(0)

    // Retry affordance re-POSTs /capture (fresh draft). Live env is off in
    // this test, so the shared run hook takes the dry-run JSON path.
    const retryButtons = screen.getAllByRole('button', { name: /Run AI read again/i })
    expect(retryButtons.length).toBeGreaterThan(0)
    fireEvent.click(retryButtons[0]!)
    expect(captureMutate).toHaveBeenCalledTimes(1)
    expect(captureMutate.mock.calls[0]![0]).toMatchObject({
      kind: 'blueprint_vision',
      draft_kind: 'takeoff',
      payload: { dryRun: true },
    })
  })

  it('shows the LIVE badge when provenance is a *-live read, even without nav-state mode', () => {
    mocks.useTakeoffDraftResult.mockReturnValue(draftResult({ provenance: 'gemini-live', review_required: true }))
    // No `mode` in nav state → the old fallback would have shown the demo badge.
    renderReview({ draftId: 'd1' })
    expect(screen.getAllByText(LIVE_TITLE).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(DEMO_TITLE)).toHaveLength(0)
  })

  it('shows the DEMO badge when provenance is stub-dry-run, even if nav state claims live', () => {
    mocks.useTakeoffDraftResult.mockReturnValue(draftResult({ provenance: 'stub-dry-run' }))
    renderReview({ draftId: 'd1', mode: 'live' })
    expect(screen.getAllByText(DEMO_TITLE).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(LIVE_TITLE)).toHaveLength(0)
  })

  it('keeps the ready review flow rendering detected quantities', () => {
    mocks.useTakeoffDraftResult.mockReturnValue(draftResult({}))
    renderReview({ draftId: 'd1', mode: 'dry-run' })
    expect(screen.getAllByText(/2 detected quantities\./i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/EPS · exterior walls/i).length).toBeGreaterThan(0)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resolveTakeoffSeed } from '@/machines/takeoff-session-seeds'
import type { CaptureDecision } from '@/machines/takeoff-session'
import { AiReviewOverlay, buildAiReviewModel, confidenceBucket } from './ai-review-overlay'

// The `ai-reviewing` seed is the canonical fixture: it loads
// capture.result.quantities = [{ id, service_item_code, quantity, unit,
// confidence }]. Pull the proposals straight off it so the test and the dev
// `?seed=ai-reviewing` affordance exercise the exact same data.
const SEED = resolveTakeoffSeed('ai-reviewing', {
  projectId: 'p-1',
  companySlug: 'acme',
  blueprintId: 'b-1',
  pageId: 'pg-1',
  draftId: 'd-1',
})!
const RESULT = SEED.context.capture!.result

afterEach(cleanup)

describe('confidenceBucket (reused thresholds)', () => {
  it('buckets ordinally at high≥0.85 / med≥0.6 / low', () => {
    expect(confidenceBucket(0.93)).toBe('high')
    expect(confidenceBucket(0.85)).toBe('high')
    expect(confidenceBucket(0.71)).toBe('medium')
    expect(confidenceBucket(0.6)).toBe('medium')
    expect(confidenceBucket(0.42)).toBe('low')
  })
})

describe('buildAiReviewModel', () => {
  it('normalizes the seeded ai-reviewing proposals, sorted high→low', () => {
    const model = buildAiReviewModel(RESULT, {}, true)
    expect(model.proposals.map((p) => p.id)).toEqual(['q1', 'q2', 'q3'])
    expect(model.proposals.map((p) => p.bucket)).toEqual(['high', 'medium', 'low'])
    expect(model.lowCount).toBe(1)
    expect(model.acceptedIds).toEqual([])
    // The seed carries no on-canvas geometry → list-only, no fabricated points.
    expect(model.hasGeometry).toBe(false)
    expect(model.proposals.every((p) => p.position === null)).toBe(true)
  })

  it('filters the low-confidence tier when showLow is false', () => {
    const model = buildAiReviewModel(RESULT, {}, false)
    expect(model.proposals.map((p) => p.id)).toEqual(['q1', 'q2'])
    // The hidden low row is still counted for the disclosure label.
    expect(model.lowCount).toBe(1)
  })

  it('threads recorded decisions and collects accepted ids', () => {
    const decisions: Record<string, CaptureDecision> = { q1: 'accept', q3: 'reject' }
    const model = buildAiReviewModel(RESULT, decisions, true)
    expect(model.acceptedIds).toEqual(['q1'])
    expect(model.proposals.find((p) => p.id === 'q1')?.decision).toBe('accept')
    expect(model.proposals.find((p) => p.id === 'q3')?.decision).toBe('reject')
  })

  it('tolerates a null / shapeless result without throwing', () => {
    expect(buildAiReviewModel(null, {}, true).proposals).toEqual([])
    expect(buildAiReviewModel({ quantities: undefined }, {}, true).proposals).toEqual([])
  })
})

describe('<AiReviewOverlay />', () => {
  it('renders the seeded proposals as review rows', () => {
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{}}
        showLow
        selectedId={null}
        onSelect={() => {}}
        dispatch={() => {}}
      />,
    )
    expect(screen.getByTestId('ai-review-row-q1')).toBeTruthy()
    expect(screen.getByTestId('ai-review-row-q2')).toBeTruthy()
    expect(screen.getByTestId('ai-review-row-q3')).toBeTruthy()
    // Codes from the seed render on the rows.
    expect(screen.getByText(/EPS/)).toBeTruthy()
    expect(screen.getByText(/Basecoat/)).toBeTruthy()
  })

  it('Accept dispatches REVIEW_DECISION { quantityId, decision: accept }', () => {
    const dispatch = vi.fn()
    const onSelect = vi.fn()
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{}}
        showLow
        selectedId={null}
        onSelect={onSelect}
        dispatch={dispatch}
      />,
    )
    fireEvent.click(screen.getByTestId('ai-review-accept-q1'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REVIEW_DECISION', quantityId: 'q1', decision: 'accept' })
    // Acting on a row also syncs the shared selection to it.
    expect(onSelect).toHaveBeenCalledWith('q1')
  })

  it('Reject dispatches REVIEW_DECISION with decision: reject', () => {
    const dispatch = vi.fn()
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{}}
        showLow
        selectedId={null}
        onSelect={() => {}}
        dispatch={dispatch}
      />,
    )
    fireEvent.click(screen.getByTestId('ai-review-reject-q2'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REVIEW_DECISION', quantityId: 'q2', decision: 'reject' })
  })

  it('Promote accepted dispatches PROMOTE with the accepted ids', () => {
    const dispatch = vi.fn()
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{ q1: 'accept', q2: 'accept', q3: 'reject' }}
        showLow
        selectedId={null}
        onSelect={() => {}}
        dispatch={dispatch}
      />,
    )
    fireEvent.click(screen.getByTestId('ai-review-promote'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'PROMOTE', quantityIds: ['q1', 'q2'] })
  })

  it('Promote is disabled with no accepted proposals', () => {
    const dispatch = vi.fn()
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{}}
        showLow
        selectedId={null}
        onSelect={() => {}}
        dispatch={dispatch}
      />,
    )
    const promote = screen.getByTestId('ai-review-promote') as HTMLButtonElement
    expect(promote.disabled).toBe(true)
    fireEvent.click(promote)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('the show-low toggle dispatches TOGGLE_SHOW_LOW', () => {
    const dispatch = vi.fn()
    render(
      <AiReviewOverlay
        result={RESULT}
        decisions={{}}
        showLow={false}
        selectedId={null}
        onSelect={() => {}}
        dispatch={dispatch}
      />,
    )
    // With showLow off, the low row is hidden and the toggle counts it.
    expect(screen.queryByTestId('ai-review-row-q3')).toBeNull()
    fireEvent.click(screen.getByTestId('ai-review-toggle-low'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'TOGGLE_SHOW_LOW' })
  })
})

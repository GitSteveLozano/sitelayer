import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import {
  draftResultStatus,
  isLiveProvenance,
  promoteRejectionsFromError,
  type DraftResultResponse,
} from './takeoff-drafts'

function rejectionError(body: unknown): ApiError {
  return new ApiError({
    status: 422,
    path: '/api/projects/p/takeoff-drafts/d/promote',
    method: 'POST',
    requestId: 'req-1',
    body,
  })
}

describe('promoteRejectionsFromError', () => {
  it('returns [] for non-ApiError values', () => {
    expect(promoteRejectionsFromError(null)).toEqual([])
    expect(promoteRejectionsFromError(new Error('boom'))).toEqual([])
    expect(promoteRejectionsFromError('nope')).toEqual([])
    expect(promoteRejectionsFromError({ rejected: [{ quantity_id: 'q1', service_item_code: 'x' }] })).toEqual([])
  })

  it('returns [] when the ApiError body has no rejected array', () => {
    expect(promoteRejectionsFromError(rejectionError(null))).toEqual([])
    expect(promoteRejectionsFromError(rejectionError('catalog problem'))).toEqual([])
    expect(promoteRejectionsFromError(rejectionError({ error: 'nope' }))).toEqual([])
    expect(promoteRejectionsFromError(rejectionError({ rejected: 'x' }))).toEqual([])
  })

  it('extracts well-formed rejections and drops malformed rows', () => {
    const out = promoteRejectionsFromError(
      rejectionError({
        error: 'service_item_code_overrides include codes not in curated catalog',
        rejected: [
          { quantity_id: 'q1', service_item_code: '99 99 99', reason: 'code not in curated catalog' },
          { quantity_id: 'q2', service_item_code: 'AA' }, // missing reason -> defaulted
          { quantity_id: 'q3' }, // missing code -> dropped
          { service_item_code: 'BB' }, // missing id -> dropped
          'garbage', // non-object -> dropped
          null, // -> dropped
        ],
        rejected_codes: ['99 99 99', 'AA'],
      }),
    )
    expect(out).toEqual([
      { quantity_id: 'q1', service_item_code: '99 99 99', reason: 'code not in curated catalog' },
      { quantity_id: 'q2', service_item_code: 'AA', reason: 'not in curated catalog' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Async-capture helpers (2026-06-12 split).
// ---------------------------------------------------------------------------

function resultResponse(overrides: Partial<DraftResultResponse>): DraftResultResponse {
  return {
    takeoff_result: null,
    source: 'blueprint_vision',
    review_required: false,
    pipeline_version: '1.0.0',
    ...overrides,
  }
}

describe('draftResultStatus', () => {
  it('returns null when there is no response yet', () => {
    expect(draftResultStatus(undefined)).toBeNull()
  })

  it('passes through the explicit poll states', () => {
    expect(draftResultStatus(resultResponse({ status: 'processing' }))).toBe('processing')
    expect(draftResultStatus(resultResponse({ status: 'failed', error: 'provider exploded' }))).toBe('failed')
    expect(draftResultStatus(resultResponse({ status: 'ready' }))).toBe('ready')
  })

  it("treats an older API response without `status` as 'ready' (old sync contract)", () => {
    expect(draftResultStatus(resultResponse({}))).toBe('ready')
  })
})

describe('isLiveProvenance', () => {
  it('classifies the two live provider reads as live', () => {
    expect(isLiveProvenance('gemini-live')).toBe(true)
    expect(isLiveProvenance('anthropic-live')).toBe(true)
  })

  it('classifies stub + deterministic output as not live', () => {
    expect(isLiveProvenance('stub-dry-run')).toBe(false)
    expect(isLiveProvenance('deterministic')).toBe(false)
  })

  it('returns null (caller fallback decides) when provenance is absent', () => {
    expect(isLiveProvenance(null)).toBeNull()
    expect(isLiveProvenance(undefined)).toBeNull()
  })
})

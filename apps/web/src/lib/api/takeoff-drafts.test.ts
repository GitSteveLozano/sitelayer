import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { promoteRejectionsFromError } from './takeoff-drafts'

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

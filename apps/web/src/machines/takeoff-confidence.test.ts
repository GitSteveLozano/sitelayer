import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_BUCKET_HIGH_FLOOR,
  CONFIDENCE_BUCKET_MEDIUM_FLOOR,
  confidenceBadge,
  confidenceBucket,
  confidenceBucketLabel,
  confidenceSparkState,
  REVIEW_CONFIDENCE_FLOOR,
  REVIEW_FLAG_FLOOR,
  reviewFloorLabel,
  statusForConfidence,
  TAKEOFF_REJECT_REASONS,
} from './takeoff-confidence'

// Ratchet for the SINGLE confidence-threshold source (wave-3 est-canvas review
// convergence). These numbers had drifted across copy-pasted per-surface
// implementations before; the boundaries below are now load-bearing for every
// review surface (AiReviewOverlay, AgentSuggestionsPanel, count/auto-takeoff
// review lanes).

describe('takeoff-confidence: ordinal display bucket (0.85 / 0.6)', () => {
  it('buckets exactly at the documented floors', () => {
    expect(CONFIDENCE_BUCKET_HIGH_FLOOR).toBe(0.85)
    expect(CONFIDENCE_BUCKET_MEDIUM_FLOOR).toBe(0.6)
    expect(confidenceBucket(0.85)).toBe('high')
    expect(confidenceBucket(0.8499)).toBe('medium')
    expect(confidenceBucket(0.6)).toBe('medium')
    expect(confidenceBucket(0.5999)).toBe('low')
    expect(confidenceBucket(0)).toBe('low')
    expect(confidenceBucket(1)).toBe('high')
  })

  it('maps buckets to badges / labels / Spark states consistently', () => {
    expect(confidenceBadge('high')).toBe('HIGH')
    expect(confidenceBadge('medium')).toBe('MED')
    expect(confidenceBadge('low')).toBe('LOW')
    expect(confidenceBucketLabel('high')).toBe('High confidence')
    expect(confidenceSparkState('high')).toBe('strong')
    expect(confidenceSparkState('medium')).toBe('accent')
    expect(confidenceSparkState('low')).toBe('muted')
  })

  it('keeps the four canonical rejection reasons (never free text)', () => {
    expect(TAKEOFF_REJECT_REASONS).toEqual(['wrong_code', 'wrong_quantity', 'not_in_scope', 'other'])
  })
})

describe('takeoff-confidence: API review floor (0.7 / 0.5)', () => {
  it('mirrors REVIEW_REQUIRED_CONFIDENCE_FLOOR in @sitelayer/capture-schema', () => {
    // The schema package isn't a web dependency (its zod tree must stay out of
    // the bundle), so this is a pinned mirror: if capture-schema's
    // REVIEW_REQUIRED_CONFIDENCE_FLOOR (packages/capture-schema/src/takeoff.ts)
    // ever moves off 0.7, update BOTH there and takeoff-confidence.ts.
    expect(REVIEW_CONFIDENCE_FLOOR).toBe(0.7)
    expect(REVIEW_FLAG_FLOOR).toBe(0.5)
  })

  it('statuses exactly at the documented floors', () => {
    expect(statusForConfidence(REVIEW_CONFIDENCE_FLOOR)).toBe('ok')
    expect(statusForConfidence(0.6999)).toBe('review')
    expect(statusForConfidence(REVIEW_FLAG_FLOOR)).toBe('review')
    expect(statusForConfidence(0.4999)).toBe('flag')
  })

  it('labels in floor terms', () => {
    expect(reviewFloorLabel(0.7)).toBe('HIGH')
    expect(reviewFloorLabel(0.69)).toBe('MED')
    expect(reviewFloorLabel(0.49)).toBe('LOW')
  })
})

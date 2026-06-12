/**
 * `takeoff-confidence` — the SINGLE source of truth for AI-capture review
 * confidence thresholds across every takeoff review surface (wave-3 est-canvas
 * review convergence, 2026-06-12).
 *
 * Before this module the same numbers were copy-pasted per surface and had
 * already drifted once (the old mobile twin used a 0.8 floor where the API
 * gate is 0.7). Two distinct, intentionally separate families live here:
 *
 *   1. The ORDINAL DISPLAY BUCKET (high ≥0.85 / medium ≥0.6 / low <0.6) —
 *      the calm-AI design-language tiering from `AI Layer.html`: confidence is
 *      ordinal, never a percent. Used by the on-canvas `AiReviewOverlay`, the
 *      `AgentSuggestionsPanel`, and any other badge/Spark rendering.
 *
 *   2. The API REVIEW FLOOR (0.7, mirroring
 *      `REVIEW_REQUIRED_CONFIDENCE_FLOOR` in @sitelayer/capture-schema) —
 *      the server's review_required gate. Rows at/above it are safe to keep by
 *      default; 0.5–0.7 need explicit review; <0.5 are flagged. Used by the
 *      count / auto-takeoff keep-reject review screens.
 *
 * They are different numbers ON PURPOSE: the bucket is a display tier, the
 * floor is the server's review gate. What is NOT allowed is a third private
 * copy of either — import from here.
 *
 * Zero-dependency on purpose (no xstate, no react) so route-level chunks can
 * import it without dragging the machine runtime along.
 */

// ─── Family 1: ordinal display bucket (HIGH / MED / LOW badges + Spark) ──────

export type ConfidenceBucket = 'high' | 'medium' | 'low'

/** Bucket floors — high ≥ 0.85, medium ≥ 0.6, low < 0.6. */
export const CONFIDENCE_BUCKET_HIGH_FLOOR = 0.85
export const CONFIDENCE_BUCKET_MEDIUM_FLOOR = 0.6

export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= CONFIDENCE_BUCKET_HIGH_FLOOR) return 'high'
  if (confidence >= CONFIDENCE_BUCKET_MEDIUM_FLOOR) return 'medium'
  return 'low'
}

/** Compact ordinal badge text (canvas markers, list chips). */
export function confidenceBadge(bucket: ConfidenceBucket): 'HIGH' | 'MED' | 'LOW' {
  switch (bucket) {
    case 'high':
      return 'HIGH'
    case 'medium':
      return 'MED'
    case 'low':
      return 'LOW'
  }
}

/** Long-form ordinal label (card banners, aria labels). */
export function confidenceBucketLabel(bucket: ConfidenceBucket): string {
  switch (bucket) {
    case 'high':
      return 'High confidence'
    case 'medium':
      return 'Medium confidence'
    case 'low':
      return 'Low confidence'
  }
}

/** `Spark` component state per bucket (structural union — no react import). */
export function confidenceSparkState(bucket: ConfidenceBucket): 'strong' | 'accent' | 'muted' {
  switch (bucket) {
    case 'high':
      return 'strong'
    case 'medium':
      return 'accent'
    case 'low':
      return 'muted'
  }
}

/** Four canonical rejection reasons — equal-weight chips, never free text
 *  (the AI-layer anti-pattern rule). Shared by every review surface. */
export const TAKEOFF_REJECT_REASONS = ['wrong_code', 'wrong_quantity', 'not_in_scope', 'other'] as const
export type TakeoffRejectReason = (typeof TAKEOFF_REJECT_REASONS)[number]

// ─── Family 2: API review floor (keep / review / flag lanes) ─────────────────

/** Mirrors REVIEW_REQUIRED_CONFIDENCE_FLOOR (0.7) in @sitelayer/capture-schema:
 *  the API flags any captured quantity below this as review_required. Keep in
 *  sync with the schema package. */
export const REVIEW_CONFIDENCE_FLOOR = 0.7

/** Below this a row is flagged outright as low-confidence. */
export const REVIEW_FLAG_FLOOR = 0.5

export type ReviewFloorStatus = 'ok' | 'review' | 'flag'

/** Rows at/above the API review floor are safe to keep by default; below it
 *  the estimator must review before accepting; <0.5 is flagged. */
export function statusForConfidence(confidence: number): ReviewFloorStatus {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'ok'
  if (confidence >= REVIEW_FLAG_FLOOR) return 'review'
  return 'flag'
}

/** HIGH/MED/LOW chip text in review-floor terms (count / auto-takeoff lanes —
 *  note this is the FLOOR family, not the 0.85/0.6 display bucket). */
export function reviewFloorLabel(confidence: number): 'HIGH' | 'MED' | 'LOW' {
  if (confidence >= REVIEW_CONFIDENCE_FLOOR) return 'HIGH'
  if (confidence >= REVIEW_FLAG_FLOOR) return 'MED'
  return 'LOW'
}

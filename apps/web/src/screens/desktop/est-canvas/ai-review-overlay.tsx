import { useMemo } from 'react'
import { Spark } from '@/components/m'
import type { CaptureDecision, TakeoffSessionEvent } from '@/machines/takeoff-session'
import { floatBox, floatHead } from './desktop-body-styles'

/**
 * `ai-review-overlay` — the EDITABLE on-canvas AI-review surface.
 *
 * "AI proposes, human ratifies ON the plan." When the takeoff-session machine
 * is in `capturing.reviewing` the desktop body renders this overlay: a synced
 * LIST panel of captured proposals plus, where a proposal carries on-canvas
 * geometry, a translucent marker on the SVG board. Each proposal is accepted /
 * rejected in place (dispatching `REVIEW_DECISION`), the accepted set is
 * promoted via `PROMOTE`, and the low-confidence tier hides behind a
 * `TOGGLE_SHOW_LOW` disclosure — all without leaving the canvas for the
 * standalone review routes.
 *
 * House rules (mirrored from the existing `AgentSuggestionsPanel` /
 * `AI Layer.html`):
 *   - confidence is ORDINAL (HIGH/MED/LOW badge + Spark state), NEVER a percent;
 *   - low confidence reads dashed/translucent and sits behind a disclosure;
 *   - rejection is a fixed reason set, never free text.
 *
 * The component is PROP-TAKING and side-effect-free beyond `dispatch`: it owns
 * no machine, no async actor, no fetch. Persistence of the promote stays on the
 * existing hybrid path in `desktop-body.tsx`. That keeps it unit-testable and
 * keeps the overlay strictly gated to the reviewing state by its caller.
 */

// ─── Confidence bucketing (REUSED from screens/projects/takeoff-canvas.tsx) ──
// Same ordinal thresholds the standalone review panel uses, kept in lockstep so
// a proposal reads identically on the canvas and on the route.
export type ConfidenceBucket = 'high' | 'medium' | 'low'

export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.85) return 'high'
  if (confidence >= 0.6) return 'medium'
  return 'low'
}

export function confidenceBadge(bucket: ConfidenceBucket): string {
  switch (bucket) {
    case 'high':
      return 'HIGH'
    case 'medium':
      return 'MED'
    case 'low':
      return 'LOW'
  }
}

function confidenceSparkState(bucket: ConfidenceBucket): 'strong' | 'accent' | 'muted' {
  switch (bucket) {
    case 'high':
      return 'strong'
    case 'medium':
      return 'accent'
    case 'low':
      return 'muted'
  }
}

/** Four canonical rejection reasons — REUSED from the standalone review panel
 *  (`TAKEOFF_REJECT_REASONS`). Equal-weight chips, never free text. */
export const AI_REVIEW_REJECT_REASONS = ['wrong_code', 'wrong_quantity', 'not_in_scope', 'other'] as const

// ─── The proposal shape carried in `capture.result.quantities` ───────────────
// The `ai-reviewing` seed (and the dry-run capture stub) load a deliberately
// lean record: { id, service_item_code, quantity, unit, confidence }. The full
// capture-schema TakeoffQuantity is richer, but the overlay only needs these
// five fields plus an OPTIONAL on-canvas position; anything else is ignored.
export interface CaptureProposalRaw {
  id: string
  service_item_code?: string | null
  quantity?: number | null
  unit?: string | null
  confidence?: number | null
  /** Optional board-space marker (0–100). Absent ⇒ list-only (don't fabricate). */
  position?: { x: number; y: number } | null
}

export interface CaptureResultLike {
  quantities?: CaptureProposalRaw[]
}

/** A normalized, render-ready proposal row. */
export interface AiReviewProposal {
  id: string
  code: string
  quantity: number | null
  unit: string
  confidence: number
  bucket: ConfidenceBucket
  decision: CaptureDecision | null
  /** Board-space (0–100) marker, or null when the proposal has no geometry. */
  position: { x: number; y: number } | null
}

export interface AiReviewModel {
  /** All proposals after the show-low filter, sorted high→low confidence. */
  proposals: AiReviewProposal[]
  /** Count of low-confidence proposals that exist (regardless of the filter). */
  lowCount: number
  /** Accepted-proposal ids — the PROMOTE payload. */
  acceptedIds: string[]
  /** True when at least one proposal carries an on-canvas position. */
  hasGeometry: boolean
  showLow: boolean
}

/**
 * Pure view-model builder — the unit-testable core. Normalizes the loosely
 * typed `capture.result` into ordered, bucketed proposals, threads each row's
 * recorded decision, and applies the show-low filter.
 */
export function buildAiReviewModel(
  result: unknown,
  decisions: Record<string, CaptureDecision>,
  showLow: boolean,
): AiReviewModel {
  const raw = (result as CaptureResultLike | null)?.quantities ?? []
  const all: AiReviewProposal[] = raw
    .filter((q): q is CaptureProposalRaw => Boolean(q) && typeof q.id === 'string' && q.id.length > 0)
    .map((q) => {
      const confidence = typeof q.confidence === 'number' && Number.isFinite(q.confidence) ? q.confidence : 0
      const position =
        q.position && typeof q.position.x === 'number' && typeof q.position.y === 'number'
          ? { x: q.position.x, y: q.position.y }
          : null
      return {
        id: q.id,
        code: (q.service_item_code ?? '').trim() || 'unknown code',
        quantity: typeof q.quantity === 'number' && Number.isFinite(q.quantity) ? q.quantity : null,
        unit: (q.unit ?? '').trim() || 'ea',
        confidence,
        bucket: confidenceBucket(confidence),
        decision: decisions[q.id] ?? null,
        position,
      }
    })

  const order: Record<ConfidenceBucket, number> = { high: 0, medium: 1, low: 2 }
  all.sort((a, b) => order[a.bucket] - order[b.bucket] || b.confidence - a.confidence)

  const lowCount = all.filter((p) => p.bucket === 'low').length
  const proposals = showLow ? all : all.filter((p) => p.bucket !== 'low')
  const acceptedIds = all.filter((p) => p.decision === 'accept').map((p) => p.id)
  const hasGeometry = all.some((p) => p.position !== null)

  return { proposals, lowCount, acceptedIds, hasGeometry, showLow }
}

// ─── Canvas markers (rendered INSIDE the desktop body's <svg> board) ─────────

export interface AiReviewMarkersProps {
  model: AiReviewModel
  selectedId: string | null
  onSelect: (id: string) => void
}

/**
 * SVG marker layer for proposals that carry an on-canvas position. Mounted as a
 * sibling inside the desktop body's 0–100 board <svg> so it shares the same
 * pan/zoom transform as the underlay + committed measurements. List-only
 * proposals (no geometry) render nothing here — we never fabricate a point.
 */
export function AiReviewMarkers({ model, selectedId, onSelect }: AiReviewMarkersProps) {
  return (
    <g data-testid="ai-review-markers">
      {model.proposals.map((p) => {
        if (!p.position) return null
        const isSelected = p.id === selectedId
        const isRejected = p.decision === 'reject'
        const isAccepted = p.decision === 'accept'
        const stroke = isAccepted ? 'var(--m-accent)' : isRejected ? 'var(--m-red)' : 'var(--m-ink)'
        // Canvas-fill convention (mirrors the desktop-body / mobile-components SVG
        // markers): the accent is the v2 yellow #FFD400 = rgb(255,212,0). Accepted
        // reads a stronger accent wash, the default a lighter one.
        const fill = isAccepted ? 'rgba(255,212,0,0.30)' : 'rgba(255,212,0,0.18)'
        // Low confidence reads dashed/translucent per the AI-layer rule.
        const dashed = p.bucket === 'low'
        return (
          <g
            key={p.id}
            onClick={() => onSelect(p.id)}
            style={{ cursor: 'pointer' }}
            opacity={isRejected ? 0.4 : 1}
            data-testid={`ai-review-marker-${p.id}`}
          >
            <circle
              cx={p.position.x}
              cy={p.position.y}
              r={isSelected ? 2.4 : 1.8}
              fill={fill}
              stroke={stroke}
              strokeWidth={isSelected ? 0.7 : 0.4}
              strokeDasharray={dashed ? '0.8 0.6' : undefined}
            />
            <text
              x={p.position.x}
              y={p.position.y - 2.6}
              fontSize={2.6}
              textAnchor="middle"
              fill={stroke}
              fontWeight={700}
              pointerEvents="none"
            >
              {confidenceBadge(p.bucket)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

// ─── The list panel (a floating command-center palette) ──────────────────────

export interface AiReviewOverlayProps {
  /** The machine's `capture.result` (loosely typed; the builder normalizes it). */
  result: unknown
  decisions: Record<string, CaptureDecision>
  showLow: boolean
  /**
   * The machine's `capture.mode` — provenance honesty for the on-canvas
   * review surface (async-capture split 2026-06-12): 'dry-run' proposals are
   * deterministic stub rows and must NEVER read like a real extraction, so the
   * header carries an explicit DEMO chip. Defaults to the conservative
   * 'dry-run' when the caller doesn't know.
   */
  mode?: 'live' | 'dry-run'
  /** Local synced selection shared with the canvas markers. */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Machine dispatch — REVIEW_DECISION / TOGGLE_SHOW_LOW / PROMOTE / CANCEL. */
  dispatch: (event: TakeoffSessionEvent) => void
  /** True while the PROMOTE actor is running (disables the action). */
  promoting?: boolean
}

const rowDecisionLabel: Record<CaptureDecision, string> = {
  accept: 'ACCEPTED',
  reject: 'REJECTED',
  edit: 'EDITED',
}

/**
 * The synced LIST half of the review surface. Renders as a left-edge floating
 * palette (same chrome as the desktop body's other panels). Each row exposes
 * Accept / Reject; the footer promotes the accepted set and toggles the
 * low-confidence tier.
 */
export function AiReviewOverlay({
  result,
  decisions,
  showLow,
  mode = 'dry-run',
  selectedId,
  onSelect,
  dispatch,
  promoting = false,
}: AiReviewOverlayProps) {
  const model = useMemo(() => buildAiReviewModel(result, decisions, showLow), [result, decisions, showLow])
  const acceptedCount = model.acceptedIds.length

  const decide = (id: string, decision: CaptureDecision) => {
    onSelect(id)
    dispatch({ type: 'REVIEW_DECISION', quantityId: id, decision })
  }

  return (
    <div
      style={floatBox({
        top: 92,
        left: 88,
        width: 296,
        maxHeight: 'calc(100% - 200px)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '6px 6px 0 var(--m-ink)',
      })}
      data-testid="ai-review-overlay"
    >
      <div style={{ ...floatHead, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spark state="accent" size={11} aria-hidden />
        <span style={{ flex: 1 }}>AI Review · {model.proposals.length} on plan</span>
        {/* Provenance chip — stub output must never look like a real read. */}
        <span
          data-testid="ai-review-mode-chip"
          style={{
            padding: '1px 6px',
            background: mode === 'live' ? 'var(--m-green)' : 'var(--m-amber)',
            color: 'var(--m-ink)',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.06em',
          }}
        >
          {mode === 'live' ? 'LIVE READ' : 'DEMO · STUB'}
        </span>
      </div>

      <div style={{ overflow: 'auto', flex: 1 }}>
        {model.proposals.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--m-ink-3)' }}>
            {model.lowCount > 0
              ? 'Only low-confidence proposals remain — show them below to review.'
              : 'No proposals to review.'}
          </div>
        ) : (
          model.proposals.map((p) => {
            const isSelected = p.id === selectedId
            const isLow = p.bucket === 'low'
            return (
              <div
                key={p.id}
                onClick={() => onSelect(p.id)}
                data-testid={`ai-review-row-${p.id}`}
                data-selected={isSelected ? 'true' : 'false'}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--m-line-2)',
                  background: isSelected ? 'rgba(255,212,0,0.12)' : 'transparent',
                  borderLeft: isSelected ? '3px solid var(--m-accent)' : '3px solid transparent',
                  // Low confidence reads translucent/dashed to mirror the canvas marker.
                  opacity: p.decision === 'reject' ? 0.5 : isLow ? 0.82 : 1,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Spark
                    state={confidenceSparkState(p.bucket)}
                    size={10}
                    aria-label={`${confidenceBadge(p.bucket)} confidence`}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 9,
                      fontWeight: 800,
                      letterSpacing: '0.06em',
                      color: 'var(--m-ink-3)',
                      border: isLow ? '1px dashed var(--m-line)' : '1px solid var(--m-line)',
                      padding: '0 4px',
                    }}
                  >
                    {confidenceBadge(p.bucket)}
                  </span>
                  {p.decision ? (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontFamily: 'var(--m-num)',
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: '0.06em',
                        color: p.decision === 'reject' ? 'var(--m-red)' : 'var(--m-accent-ink)',
                        background: p.decision === 'reject' ? 'transparent' : 'var(--m-accent)',
                        padding: '0 5px',
                      }}
                    >
                      {rowDecisionLabel[p.decision]}
                    </span>
                  ) : null}
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontFamily: 'var(--m-num)',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--m-ink)',
                  }}
                >
                  {p.quantity !== null ? p.quantity : '—'} {p.unit} · <span style={{ fontWeight: 600 }}>{p.code}</span>
                  {p.position ? null : (
                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--m-ink-3)' }}>
                      LIST-ONLY
                    </span>
                  )}
                </div>

                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      decide(p.id, 'accept')
                    }}
                    data-testid={`ai-review-accept-${p.id}`}
                    style={reviewActionStyle(p.decision === 'accept', 'accept')}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      decide(p.id, 'reject')
                    }}
                    data-testid={`ai-review-reject-${p.id}`}
                    style={reviewActionStyle(p.decision === 'reject', 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div
        style={{
          borderTop: '2px solid var(--m-ink)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (acceptedCount === 0 || promoting) return
            dispatch({ type: 'PROMOTE', quantityIds: model.acceptedIds })
          }}
          disabled={acceptedCount === 0 || promoting}
          data-testid="ai-review-promote"
          style={{
            padding: '10px 8px',
            border: '2px solid var(--m-ink)',
            background: acceptedCount > 0 ? 'var(--m-accent)' : 'var(--m-card)',
            color: acceptedCount > 0 ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.06em',
            cursor: acceptedCount > 0 && !promoting ? 'pointer' : 'not-allowed',
            opacity: acceptedCount > 0 && !promoting ? 1 : 0.6,
          }}
        >
          {promoting ? 'Promoting…' : `Promote accepted (${acceptedCount})`}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <button
            type="button"
            onClick={() => dispatch({ type: 'TOGGLE_SHOW_LOW' })}
            data-testid="ai-review-toggle-low"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: 'none',
              padding: 0,
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: 'var(--m-ink-2)',
              cursor: 'pointer',
            }}
          >
            <Spark state="muted" size={10} aria-hidden />
            {showLow ? 'Hide low-confidence' : `Show low-confidence (${model.lowCount})`}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'CANCEL' })}
            data-testid="ai-review-cancel"
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: 'var(--m-ink-3)',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

function reviewActionStyle(active: boolean, kind: 'accept' | 'reject'): React.CSSProperties {
  const accent = kind === 'accept' ? 'var(--m-accent)' : 'var(--m-red)'
  return {
    padding: '7px 8px',
    border: '2px solid var(--m-ink)',
    background: active ? accent : 'var(--m-card)',
    color: active ? (kind === 'accept' ? 'var(--m-accent-ink)' : 'var(--m-sand)') : 'var(--m-ink)',
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.04em',
    cursor: 'pointer',
  }
}

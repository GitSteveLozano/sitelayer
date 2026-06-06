import { useState } from 'react'
import { Pill } from '@/components/mobile'
import { MAiAgent, Spark } from '@/components/m'
import { useBidAccuracy, type AccuracyConfidence, type BidAccuracyProject } from '@/lib/api/bid-accuracy'

/**
 * Bid-accuracy keystone card.
 *
 * Reusable in two places:
 *   1. Right pane of the Estimate Builder (`estimate-builder.tsx`)
 *   2. Project detail dashboard hero strip (follow-up)
 *
 * Visual contract from `/tmp/sitelayer_design_stuff/ai-keystone.jsx` §05a:
 *   - Spark + ordinal confidence pill (low/med/high) — never numeric
 *   - Headline shows predicted margin pct + confidence in plain English
 *   - Body lists up to 3 comparable past projects (most similar delta_pct)
 *   - MAttribution line: "Based on N closed jobs · last sync DATE"
 *   - Always dismissible per the AI Layer rule (`AI Rules.html` § Dismiss)
 *
 * The card uses `MAiAgent` (the dashed-border tier-3 surface) because the
 * predicted margin is the model's draft — the human is the last hand on
 * the wheel. When the model confidence is high we still keep the dashed
 * surround for consistency with `ai-keystone.jsx`.
 *
 * Density-aware:
 *   `compact={true}` renders a single-line chip (Spark + ordinal-confidence
 *   pill + "{margin}% margin" + chevron). The chip is tappable and the
 *   estimate-builder wraps it in a `Sheet` so the full keystone is one tap
 *   away. Used for small estimates (<10 lines) where the full right rail
 *   would be visually heavy.
 */
export interface BidAccuracyCardProps {
  projectId: string
  /** Called when the user dismisses. Defaults to a no-op (signal-only). */
  onDismiss?: () => void
  /**
   * Render the single-line chip variant instead of the full keystone card.
   * The chip shows only Spark + ordinal-confidence pill + predicted-margin
   * + chevron. Callers wire the click handler to expand.
   */
  compact?: boolean
  /** Click handler for the compact chip. Ignored when `compact=false`. */
  onCompactClick?: () => void
}

export function BidAccuracyCard({ projectId, onDismiss, compact = false, onCompactClick }: BidAccuracyCardProps) {
  const accuracy = useBidAccuracy(projectId)
  // Session-level dismiss — when the caller doesn't own the dismiss
  // (e.g. inside the right rail of the Estimate Builder), we still
  // honour the AI rules' dismissibility requirement by hiding the card
  // for the rest of the session. A real "mark insight dismissed"
  // server-side call lives behind `useDismissInsight` and lands as a
  // follow-up when the model produces persisted `ai_insights` rows for
  // bid accuracy specifically.
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  if (accuracy.isPending) {
    if (compact) {
      return (
        <div className="rounded-full border border-dashed border-line px-2.5 py-1 text-[11px] text-ink-3">
          Loading bid accuracy…
        </div>
      )
    }
    return (
      <div className="rounded border border-dashed border-line p-3 text-[12px] text-ink-3">Loading bid accuracy…</div>
    )
  }
  if (accuracy.isError || !accuracy.data || !accuracy.data.summary) {
    if (compact) {
      return (
        <div className="rounded-full border border-dashed border-line px-2.5 py-1 text-[11px] text-ink-3">
          No bid-accuracy signal yet
        </div>
      )
    }
    return (
      <div className="rounded border border-dashed border-line p-3 text-[12px] text-ink-3">
        No bid-accuracy signal yet — close a few jobs and the keystone fills in.
      </div>
    )
  }

  const { comparables, summary, predicted_margin_pct, confidence, attribution } = accuracy.data
  const margin = predicted_margin_pct ?? 0
  const sign = margin >= 0 ? '+' : '−'
  const marginAbs = Math.abs(margin).toFixed(1)
  const confLabel = confidence ? confidenceLabel(confidence) : 'pending'

  if (compact) {
    // Single-line chip variant. Same accent palette via the dashed border
    // and Spark — the chip is the smallest possible AI surface that still
    // honours the AI rules (Spark marker + ordinal confidence + plain-language
    // margin). Tapping it should open the full keystone in a sheet/popover;
    // callers wire `onCompactClick` for that.
    return (
      <button
        type="button"
        onClick={onCompactClick}
        aria-label={`Bid accuracy — predicted margin ${sign}${marginAbs}%, ${confLabel} confidence. Tap for details.`}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-accent/50 bg-accent/5 px-2.5 py-1 hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        <Spark size={11} state={confidence === 'high' ? 'strong' : 'accent'} />
        <ConfidencePill confidence={confidence} label={confLabel} />
        <span className="num text-[11.5px] font-semibold text-ink">
          {sign}
          {marginAbs}% margin
        </span>
        <span aria-hidden="true" className="text-ink-3 text-[10px] leading-none">
          ▸
        </span>
      </button>
    )
  }

  return (
    <MAiAgent
      attribution={
        <>
          Based on <strong>{summary.closed_project_count} closed jobs</strong> · {attribution}
        </>
      }
      onDismiss={() => {
        if (onDismiss) onDismiss()
        else setDismissed(true)
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Spark size={12} state={confidence === 'high' ? 'strong' : 'accent'} />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Bid accuracy
          </span>
        </div>

        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          Predicted margin{' '}
          <span className="num" style={{ fontWeight: 700 }}>
            {sign}
            {marginAbs}%
          </span>{' '}
          · <ConfidencePill confidence={confidence} label={confLabel} />
        </div>

        <div style={{ fontSize: 12, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 8 }}>
          {comparables.length === 0
            ? 'No comparable past jobs in this company yet — the model leans on cohort means until the dataset grows.'
            : `Closest comparables (by historical bid-vs-actual drift):`}
        </div>

        {comparables.length > 0 ? (
          <ul className="space-y-1.5">
            {comparables.map((p) => (
              <ComparableRow key={p.project_id} project={p} />
            ))}
          </ul>
        ) : null}
      </div>
    </MAiAgent>
  )
}

function ComparableRow({ project }: { project: BidAccuracyProject }) {
  const sign = project.delta_pct >= 0 ? '+' : '−'
  const abs = Math.abs(project.delta_pct).toFixed(1)
  return (
    <li className="flex items-center justify-between gap-2 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{project.project_name}</div>
        <div className="text-[10.5px] text-ink-3 truncate num">
          ${Number(project.bid_total).toLocaleString()} bid · {project.customer_name ?? 'no customer'}
        </div>
      </div>
      <Pill tone={project.confidence === 'high' ? 'good' : project.confidence === 'med' ? 'default' : 'warn'}>
        {sign}
        {abs}%
      </Pill>
    </li>
  )
}

function ConfidencePill({ confidence, label }: { confidence: AccuracyConfidence | null; label: string }) {
  if (!confidence) {
    return <Pill tone="default">{label}</Pill>
  }
  const tone = confidence === 'high' ? 'good' : confidence === 'med' ? 'default' : 'warn'
  return <Pill tone={tone}>{label} confidence</Pill>
}

function confidenceLabel(c: AccuracyConfidence): string {
  if (c === 'high') return 'high'
  if (c === 'med') return 'med'
  return 'low'
}

export type { BidAccuracyProject }

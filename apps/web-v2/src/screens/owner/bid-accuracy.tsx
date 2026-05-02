import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution, Spark, StripeCard, WhyThis } from '@/components/ai'
import { useBidAccuracy, type AccuracyConfidence, type BidAccuracyProject } from '@/lib/api'

/**
 * Owner bid accuracy cohort view (Phase 5).
 *
 * Hero: mean delta % across closed projects + over/under/exact counts.
 * Body: per-project rows, sorted newest first, with an ordinal
 * confidence pill (low | med | high — never a numeric pct).
 *
 * AI Layer rules respected:
 *   - Spark + StripeCard for the visual cue
 *   - Attribution names the source explicitly
 *   - No prescriptive recommendations (the agent surfaces; the human
 *     decides)
 */
export function OwnerBidAccuracyScreen() {
  const accuracy = useBidAccuracy()
  const [showWhy, setShowWhy] = useState(false)

  if (accuracy.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading bid accuracy…</div>
  }

  const summary = accuracy.data?.summary
  const projects = accuracy.data?.projects ?? []
  // Convert the numeric mean delta to an ordinal headline per the
  // AI Layer rule ("ordinal confidence, never numeric"). The full
  // numeric pct is still available in WhyThis for power users.
  const closedDelta = summary?.mean_closed_delta_pct ?? 0
  const absClosed = Math.abs(closedDelta)
  const sparkState = absClosed < 5 ? 'accent' : 'muted'
  const headlineLabel = absClosed < 5 ? 'On' : absClosed < 15 ? 'Near' : closedDelta > 0 ? 'Over' : 'Under'
  const headlineDetail = absClosed < 5 ? 'within 5%' : absClosed < 15 ? '5–15% off' : 'more than 15% off'

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to="/" className="text-[12px] text-ink-3">
          ← Home
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Bid accuracy</h1>
        <p className="text-[12px] text-ink-3 mt-1">How close your bids landed against realized cost.</p>
      </div>

      <div className="px-4 pb-8 space-y-3">
        <StripeCard tone="accent">
          <div className="flex items-center gap-2 mb-1">
            <Spark state={sparkState} size={12} aria-label="" />
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              Mean delta on closed jobs
            </div>
          </div>
          <div className="font-display text-[28px] font-bold tracking-tight">{headlineLabel}</div>
          <div className="text-[12px] text-ink-3 mt-1">
            {headlineDetail} · {summary?.closed_project_count ?? 0} closed of {summary?.project_count ?? 0} total ·{' '}
            {summary?.over_count ?? 0} over · {summary?.under_count ?? 0} under
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Attribution source={summary?.attribution ?? 'Computed from projects + actuals'} />
            <button type="button" onClick={() => setShowWhy((s) => !s)} className="text-[11px] text-accent font-medium">
              {showWhy ? 'Hide why' : 'Why this?'}
            </button>
          </div>
        </StripeCard>

        {showWhy ? (
          <WhyThis title="How the delta is computed" attribution="Cohort SQL — no LLM in this path">
            For every project with a bid &gt; 0, we sum material_bills.amount and labor_entries.hours × project labor
            rate, compare against bid_total, and bucket the absolute delta percent into ordinal pills (high &lt; 5%,
            medium &lt; 15%, low ≥ 15%). Closed projects drive the headline mean; in-flight projects show their running
            delta so you spot drift before the bid lands.
          </WhyThis>
        ) : null}

        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pt-2">Per project</div>
        {projects.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No bids with realized cost yet.</div>
          </Card>
        ) : (
          projects.map((p) => <ProjectRow key={p.project_id} project={p} />)
        )}
      </div>
    </div>
  )
}

function ProjectRow({ project }: { project: BidAccuracyProject }) {
  const tone: 'good' | 'warn' | 'default' =
    project.confidence === 'high' ? 'good' : project.confidence === 'med' ? 'default' : 'warn'
  const sign = project.delta_cents > 0 ? '+' : project.delta_cents < 0 ? '−' : ''
  const absDelta = Math.abs(project.delta_cents) / 100
  return (
    <Link to={`/projects/${project.project_id}`} className="block">
      <Card tight>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold">{project.project_name}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              {project.customer_name ?? 'No customer'} · bid ${Number(project.bid_total).toLocaleString()}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              actual ${(project.actual_total_cents / 100).toLocaleString()} · {sign}${absDelta.toLocaleString()}
            </div>
          </div>
          <Pill tone={tone}>{labelFor(project.confidence)}</Pill>
        </div>
      </Card>
    </Link>
  )
}

function labelFor(c: AccuracyConfidence): string {
  if (c === 'high') return 'on'
  if (c === 'med') return 'near'
  return 'off'
}

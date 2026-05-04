import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { CleanBulkCard, TimeReviewRunCard, groupRunsByState, timeReviewStateLabel } from '@/components/time-review'
import {
  useProjects,
  useTimeReviewRuns,
  type ProjectListRow,
  type TimeReviewRunRow,
  type TimeReviewState,
} from '@/lib/api'

/**
 * `t-approve` — Time review approval queue (Sitemap §8 panel 1).
 *
 * Lists time_review_runs grouped into clean (no anomalies) and needs-
 * review (anomaly_count > 0). The clean group gets a single bulk
 * approve CTA; needs-review rows get per-row Approve / Dispute.
 *
 * The screen fetches all states in one shot so the tab strip can show
 * counts without three separate queries — staleness is the same since
 * any APPROVE/DISPUTE invalidates the whole list.
 *
 * "Disputed" is a UI rename of the workflow's `rejected` state. The
 * column on the row stays `rejected`; only the label moved.
 */
export function ApprovalQueueScreen() {
  const [tab, setTab] = useState<TimeReviewState>('pending')
  const allRuns = useTimeReviewRuns()
  const projects = useProjects()
  const projectById = useMemo(() => new Map((projects.data?.projects ?? []).map((p) => [p.id, p])), [projects.data])

  const rows = allRuns.data?.timeReviewRuns ?? []
  const byState = useMemo(() => groupRunsByState(rows), [rows])
  const visible = byState[tab]
  const cleanPending = useMemo(() => byState.pending.filter((r) => r.anomaly_count === 0), [byState.pending])
  const reviewPending = useMemo(() => byState.pending.filter((r) => r.anomaly_count > 0), [byState.pending])

  const pendingEntryTotal = byState.pending.reduce((sum, r) => sum + r.total_entries, 0)
  const pendingAnomalyTotal = byState.pending.reduce((sum, r) => sum + r.anomaly_count, 0)

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <h1 className="font-display text-[28px] font-bold tracking-tight leading-tight">Time</h1>
        <div className="text-[12px] text-ink-3 mt-1 flex items-center justify-between gap-2">
          <span>
            <span className="num font-medium">{pendingEntryTotal}</span> entr{pendingEntryTotal === 1 ? 'y' : 'ies'}{' '}
            waiting
            {pendingAnomalyTotal > 0 ? (
              <>
                {' · '}
                <span className="text-warn font-medium">
                  <span className="num">{pendingAnomalyTotal}</span> anomal{pendingAnomalyTotal === 1 ? 'y' : 'ies'}
                </span>
              </>
            ) : null}
          </span>
          <span className="flex items-center gap-3">
            <Link to="/time/burden" className="text-accent font-medium">
              Burden →
            </Link>
            <Link to="/time/vs" className="text-accent font-medium">
              Vs plan →
            </Link>
          </span>
        </div>
      </div>

      <div className="px-4 border-b border-line">
        <div className="flex gap-1">
          {(['pending', 'approved', 'rejected'] as TimeReviewState[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative flex-1 py-3 text-[13px] font-medium ${tab === t ? 'text-ink' : 'text-ink-3'}`}
            >
              {timeReviewStateLabel(t)}
              {byState[t].length > 0 ? (
                <span
                  className={`ml-1.5 inline-block px-1.5 py-px rounded-full text-[10px] font-mono tabular-nums font-semibold ${
                    tab === t ? 'bg-ink text-white' : 'bg-card-soft text-ink-3'
                  }`}
                >
                  {byState[t].length}
                </span>
              ) : null}
              {tab === t ? <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 pb-8 space-y-3">
        {allRuns.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : tab === 'pending' ? (
          <PendingTab clean={cleanPending} review={reviewPending} projectById={projectById} />
        ) : visible.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No {timeReviewStateLabel(tab).toLowerCase()} runs.</div>
            <div className="text-[11px] text-ink-3 mt-1">Runs land here once they transition.</div>
          </Card>
        ) : (
          <>
            {visible.map((row) => (
              <TimeReviewRunCard key={row.id} row={row} projectById={projectById} />
            ))}
            <Attribution source="Live from /api/time-review-runs" />
          </>
        )}
      </div>
    </div>
  )
}

function PendingTab({
  clean,
  review,
  projectById,
}: {
  clean: TimeReviewRunRow[]
  review: TimeReviewRunRow[]
  projectById: Map<string, ProjectListRow>
}) {
  if (clean.length === 0 && review.length === 0) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">No pending runs.</div>
        <div className="text-[11px] text-ink-3 mt-1">Create one from POST /api/time-review-runs to start a review.</div>
      </Card>
    )
  }
  return (
    <>
      {clean.length > 0 ? <CleanBulkCard runs={clean} /> : null}
      {review.length > 0 ? (
        <>
          <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Needs review ({review.length})
          </div>
          {review.map((row) => (
            <TimeReviewRunCard key={row.id} row={row} projectById={projectById} />
          ))}
        </>
      ) : null}
      <Attribution source="Live from /api/time-review-runs" />
    </>
  )
}

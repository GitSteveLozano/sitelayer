import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution, WhyThis } from '@/components/ai'
import { useTimeReviewRuns, type TimeReviewRunRow } from '@/lib/api'

/**
 * `t-anomalies` — owner-side cohort view of time-review runs that
 * carry one or more flagged entries.
 *
 * The detail of why an entry was flagged lives on the per-run
 * approval screen; this view just surfaces "where to look first"
 * sorted by anomaly density (count desc, age desc).
 */
export function OwnerTimeAnomaliesScreen() {
  const pending = useTimeReviewRuns({ state: 'pending' })

  const runs = (pending.data?.timeReviewRuns ?? []).filter((r) => r.anomaly_count > 0)
  const sorted = [...runs].sort((a, b) => {
    if (b.anomaly_count !== a.anomaly_count) return b.anomaly_count - a.anomaly_count
    return Date.parse(a.created_at) - Date.parse(b.created_at)
  })

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to="/time" className="text-[12px] text-ink-3">
          ← Time
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Anomalies</h1>
        <p className="text-[12px] text-ink-3 mt-1">Pending runs that flagged at least one entry.</p>
      </div>

      <div className="px-4 pb-4">
        <WhyThis
          title="What counts as an anomaly?"
          attribution="From server-side hour heuristics — see /api/time-review-runs"
        >
          The time-review reducer flags rows where the recorded hours fall outside the expected window for that worker /
          project / day combination — gaps, overlaps, hours over a soft cap, or entries posted after the geofence
          cutoff. Each anomaly is a hint, not a verdict; you decide whether to approve or reopen.
        </WhyThis>
      </div>

      <div className="px-4 pb-8 space-y-2">
        {pending.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : sorted.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No pending runs are flagging anomalies.</div>
          </Card>
        ) : (
          sorted.map((run) => <RunRow key={run.id} run={run} />)
        )}
        <div className="pt-2">
          <Attribution source="GET /api/time-review-runs?state=pending" />
        </div>
      </div>
    </div>
  )
}

function RunRow({ run }: { run: TimeReviewRunRow }) {
  const tone: 'warn' | 'default' = run.anomaly_count >= 3 ? 'warn' : 'default'
  return (
    <Link to="/time" className="block">
      <Card tight>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold">
              {run.period_start} → {run.period_end}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              {run.total_entries} entries · {Number(run.total_hours).toFixed(1)}h · v{run.state_version}
            </div>
          </div>
          <Pill tone={tone}>
            {run.anomaly_count} anomal{run.anomaly_count === 1 ? 'y' : 'ies'}
          </Pill>
        </div>
      </Card>
    </Link>
  )
}

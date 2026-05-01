import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  ApiError,
  useDispatchTimeReviewEvent,
  useTimeReviewRuns,
  type TimeReviewRunRow,
  type TimeReviewState,
} from '@/lib/api'

/**
 * `t-approve` — Time review approval queue.
 *
 * Lists time_review_runs in the chosen state. Per-row actions dispatch
 * the workflow event (APPROVE, REJECT, REOPEN) via the deterministic
 * workflow endpoint. 409 responses (state_version conflict) re-load the
 * snapshot into the cache automatically — see useDispatchTimeReviewEvent
 * in lib/api/time-review.ts.
 *
 * Phase 1D.3 ships the queue + per-row APPROVE/REJECT. Phase 1D.4 wires
 * the bulk-approve UX from the design and the per-entry edit drawer.
 */
export function ApprovalQueueScreen() {
  const [tab, setTab] = useState<TimeReviewState>('pending')
  const runs = useTimeReviewRuns({ state: tab })
  const rows = runs.data?.timeReviewRuns ?? []
  const anomalyTotal = rows.reduce((sum, r) => sum + (r.anomaly_count || 0), 0)

  const counts = useMemo(() => {
    const all = runs.data?.timeReviewRuns ?? []
    return {
      pending: tab === 'pending' ? all.length : 0,
      approved: tab === 'approved' ? all.length : 0,
      rejected: tab === 'rejected' ? all.length : 0,
    }
  }, [runs.data, tab])

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Owner / PM · Time</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Approvals</h1>
        <div className="text-[12px] text-ink-3 mt-1 flex items-center justify-between">
          <span>
            {rows.length} {tab} run{rows.length === 1 ? '' : 's'}
          </span>
          {anomalyTotal > 0 ? (
            <Link to="/time/anomalies" className="text-accent font-medium">
              {anomalyTotal} anomal{anomalyTotal === 1 ? 'y' : 'ies'} →
            </Link>
          ) : null}
        </div>
      </div>

      {/* Sub-tabs. */}
      <div className="px-4 border-b border-line">
        <div className="flex gap-1">
          {(['pending', 'approved', 'rejected'] as TimeReviewState[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative flex-1 py-3 text-[13px] font-medium ${tab === t ? 'text-ink' : 'text-ink-3'}`}
            >
              {labelFor(t)}
              {tab === t ? <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 pb-8 space-y-3">
        {runs.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No {tab} runs.</div>
            <div className="text-[11px] text-ink-3 mt-1">
              {tab === 'pending'
                ? 'Create one from POST /api/time-review-runs to start a review.'
                : 'Runs land here once they transition.'}
            </div>
          </Card>
        ) : (
          <>
            <Attribution source="Live from /api/time-review-runs" />
            {rows.map((row) => (
              <RunRow key={row.id} row={row} counts={counts} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

interface RunRowProps {
  row: TimeReviewRunRow
  counts: { pending: number; approved: number; rejected: number }
}

function RunRow({ row }: RunRowProps) {
  const [error, setError] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [showReject, setShowReject] = useState(false)
  const dispatchEvent = useDispatchTimeReviewEvent(row.id)

  const onApprove = async () => {
    setError(null)
    try {
      await dispatchEvent.mutateAsync({ event: 'APPROVE', state_version: row.state_version })
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Failed to approve')
    }
  }

  const onReject = async () => {
    setError(null)
    if (!rejectReason.trim()) {
      setError('Reason required to reject')
      return
    }
    try {
      await dispatchEvent.mutateAsync({
        event: 'REJECT',
        state_version: row.state_version,
        reason: rejectReason.trim(),
      })
      setShowReject(false)
      setRejectReason('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Failed to reject')
    }
  }

  const onReopen = async () => {
    setError(null)
    try {
      await dispatchEvent.mutateAsync({
        event: 'REOPEN',
        state_version: row.state_version,
        reason: 'Reopened from approvals queue',
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Failed to reopen')
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{formatPeriod(row.period_start, row.period_end)}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {row.project_id ? `Project ${row.project_id.slice(0, 8)}…` : 'Workspace-wide'}
          </div>
        </div>
        <Pill tone={row.anomaly_count > 0 ? 'warn' : 'good'}>
          {row.anomaly_count} anomal{row.anomaly_count === 1 ? 'y' : 'ies'}
        </Pill>
      </div>

      <div className="grid grid-cols-3 gap-2 py-2 border-y border-line">
        <Stat label="Entries" value={row.total_entries.toString()} />
        <Stat label="Hours" value={Number(row.total_hours).toFixed(1)} />
        <Stat label="State" value={row.state} />
      </div>

      {row.state === 'rejected' && row.rejection_reason ? (
        <div className="mt-2 p-2 bg-bad-soft text-[12px] text-bad rounded">{row.rejection_reason}</div>
      ) : null}

      {error ? <div className="mt-2 text-[12px] text-bad">{error}</div> : null}

      {row.state === 'pending' && !showReject ? (
        <div className="flex gap-2 mt-3">
          <MobileButton variant="primary" size="sm" onClick={onApprove} disabled={dispatchEvent.isPending}>
            Approve
          </MobileButton>
          <MobileButton
            variant="ghost"
            size="sm"
            onClick={() => setShowReject(true)}
            disabled={dispatchEvent.isPending}
          >
            Reject
          </MobileButton>
        </div>
      ) : null}

      {row.state === 'pending' && showReject ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why are you rejecting this run?"
            rows={2}
            className="w-full p-2 text-[13px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent resize-none"
          />
          <div className="flex gap-2">
            <MobileButton variant="primary" size="sm" onClick={onReject} disabled={dispatchEvent.isPending}>
              Submit rejection
            </MobileButton>
            <MobileButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowReject(false)
                setRejectReason('')
                setError(null)
              }}
            >
              Cancel
            </MobileButton>
          </div>
        </div>
      ) : null}

      {row.state === 'approved' || row.state === 'rejected' ? (
        <div className="flex gap-2 mt-3">
          <MobileButton variant="ghost" size="sm" onClick={onReopen} disabled={dispatchEvent.isPending}>
            Reopen for correction
          </MobileButton>
        </div>
      ) : null}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="num text-[14px] font-semibold mt-0.5">{value}</div>
    </div>
  )
}

function labelFor(state: TimeReviewState): string {
  if (state === 'pending') return 'To approve'
  if (state === 'approved') return 'Approved'
  return 'Rejected'
}

function formatPeriod(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

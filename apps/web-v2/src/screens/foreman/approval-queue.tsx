import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  ApiError,
  dispatchTimeReviewEvent,
  queryKeys,
  useDispatchTimeReviewEvent,
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
  const byState = useMemo(() => groupByState(rows), [rows])
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
              {labelFor(t)}
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
            <div className="text-[12px] text-ink-3">No {labelFor(tab).toLowerCase()} runs.</div>
            <div className="text-[11px] text-ink-3 mt-1">Runs land here once they transition.</div>
          </Card>
        ) : (
          <>
            {visible.map((row) => (
              <RunRow key={row.id} row={row} projectById={projectById} />
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
            <RunRow key={row.id} row={row} projectById={projectById} />
          ))}
        </>
      ) : null}
      <Attribution source="Live from /api/time-review-runs" />
    </>
  )
}

/**
 * Bulk-approve CTA. Fires APPROVE for each clean run in parallel; on
 * any failure falls back to a per-row error so the user sees which
 * runs landed and which need a retry. State_version comes from the
 * row at click-time — if a 409 fires we just re-render with the
 * fresh list.
 */
function CleanBulkCard({ runs }: { runs: TimeReviewRunRow[] }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onApproveAll = async () => {
    setBusy(true)
    setError(null)
    try {
      const results = await Promise.allSettled(
        runs.map((r) => dispatchTimeReviewEvent(r.id, { event: 'APPROVE', state_version: r.state_version })),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        setError(
          failed === results.length
            ? `Could not approve any of the ${failed} runs. Try again.`
            : `${results.length - failed} approved · ${failed} failed — refreshing.`,
        )
      }
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.timeReviewRuns.all() })
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <CheckIcon />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">
              {runs.length} {runs.length === 1 ? 'run is' : 'runs are'} clean
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">Approve {runs.length === 1 ? 'it' : 'them'} in one tap.</div>
          </div>
        </div>
        <MobileButton variant="primary" size="sm" onClick={onApproveAll} disabled={busy}>
          {busy ? '…' : `Approve ${runs.length}`}
        </MobileButton>
      </div>
      {error ? <div className="mt-2 text-[12px] text-bad">{error}</div> : null}
    </Card>
  )
}

function CheckIcon() {
  return (
    <span
      aria-hidden="true"
      className="w-6 h-6 rounded-full bg-good-soft text-good shrink-0 inline-flex items-center justify-center text-[14px] font-bold"
    >
      ✓
    </span>
  )
}

function RunRow({ row, projectById }: { row: TimeReviewRunRow; projectById: Map<string, ProjectListRow> }) {
  const [error, setError] = useState<string | null>(null)
  const [disputeReason, setDisputeReason] = useState('')
  const [showDispute, setShowDispute] = useState(false)
  const dispatchEvent = useDispatchTimeReviewEvent(row.id)

  const project = row.project_id ? projectById.get(row.project_id) : null
  const projectLabel = project?.name ?? (row.project_id ? `Project ${row.project_id.slice(0, 8)}…` : 'Workspace-wide')

  const onApprove = async () => {
    setError(null)
    try {
      await dispatchEvent.mutateAsync({ event: 'APPROVE', state_version: row.state_version })
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Failed to approve')
    }
  }

  const onDispute = async () => {
    setError(null)
    if (!disputeReason.trim()) {
      setError('Reason required to dispute')
      return
    }
    try {
      await dispatchEvent.mutateAsync({
        event: 'REJECT',
        state_version: row.state_version,
        reason: disputeReason.trim(),
      })
      setShowDispute(false)
      setDisputeReason('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Failed to dispute')
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

  const totalHoursText = `${Number(row.total_hours).toFixed(1)}h`

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate">{projectLabel}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {formatPeriod(row.period_start, row.period_end)} · {row.total_entries} entr
            {row.total_entries === 1 ? 'y' : 'ies'}
          </div>
          {row.anomaly_count > 0 ? (
            <div className="mt-2">
              <Pill tone="warn">
                {row.anomaly_count} anomal{row.anomaly_count === 1 ? 'y' : 'ies'} flagged
              </Pill>
            </div>
          ) : null}
        </div>
        <div className="font-mono tabular-nums text-[20px] font-bold tracking-tight shrink-0">{totalHoursText}</div>
      </div>

      {row.state === 'rejected' && row.rejection_reason ? (
        <div className="mt-2 p-2 bg-bad-soft text-[12px] text-bad rounded">{row.rejection_reason}</div>
      ) : null}

      {error ? <div className="mt-2 text-[12px] text-bad">{error}</div> : null}

      {row.state === 'pending' && !showDispute ? (
        <div className="flex gap-2 mt-3">
          <MobileButton variant="primary" size="sm" onClick={onApprove} disabled={dispatchEvent.isPending}>
            {row.anomaly_count > 0 ? 'Approve as-is' : 'Approve'}
          </MobileButton>
          <MobileButton
            variant="ghost"
            size="sm"
            onClick={() => setShowDispute(true)}
            disabled={dispatchEvent.isPending}
          >
            Dispute
          </MobileButton>
        </div>
      ) : null}

      {row.state === 'pending' && showDispute ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Why are you disputing this run?"
            rows={2}
            className="w-full p-2 text-[13px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent resize-none"
          />
          <div className="flex gap-2">
            <MobileButton variant="primary" size="sm" onClick={onDispute} disabled={dispatchEvent.isPending}>
              Submit dispute
            </MobileButton>
            <MobileButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowDispute(false)
                setDisputeReason('')
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

function groupByState(rows: TimeReviewRunRow[]): Record<TimeReviewState, TimeReviewRunRow[]> {
  const groups: Record<TimeReviewState, TimeReviewRunRow[]> = { pending: [], approved: [], rejected: [] }
  for (const r of rows) groups[r.state].push(r)
  return groups
}

function labelFor(state: TimeReviewState): string {
  if (state === 'pending') return 'To approve'
  if (state === 'approved') return 'Approved'
  return 'Disputed'
}

function formatPeriod(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`
}

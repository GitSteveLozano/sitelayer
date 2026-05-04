// Shared time-review components used by the cross-project queue
// (apps/web-v2/src/screens/foreman/approval-queue.tsx) and the
// per-project Crew sub-tab on prj-detail. Same approval engine, two
// surfaces — keeping the bulk-approve and per-run card logic in one
// place avoids a slow drift between them.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, MobileButton, Pill } from '@/components/mobile'
import {
  ApiError,
  dispatchTimeReviewEvent,
  queryKeys,
  useDispatchTimeReviewEvent,
  type ProjectListRow,
  type TimeReviewRunRow,
  type TimeReviewState,
} from '@/lib/api'

/**
 * Bulk-approve CTA for clean (anomaly_count === 0) runs. Fires
 * APPROVE for each in parallel via Promise.allSettled; partial
 * failures surface in-card and the list refreshes either way so the
 * screen never holds stale state_versions after a 409.
 */
export function CleanBulkCard({ runs, label }: { runs: TimeReviewRunRow[]; label?: string }) {
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

  const headline = label ?? (runs.length === 1 ? '1 run is clean' : `${runs.length} runs are clean`)
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <CheckIcon />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{headline}</div>
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

/**
 * Per-run card for a TimeReviewRunRow. Renders project name, period,
 * anomaly pill, and total hours; surfaces Approve / Dispute on
 * pending rows and Reopen for approved/rejected. The card is
 * project-aware via the `projectById` lookup; pass an empty Map for
 * a workspace-wide list — the row falls back to "Workspace-wide" /
 * "Project xxxx…" labels.
 *
 * Pass `hideProject=true` from the per-project Crew tab to drop the
 * redundant project name (the screen header already has it).
 */
export function TimeReviewRunCard({
  row,
  projectById,
  hideProject = false,
}: {
  row: TimeReviewRunRow
  projectById: Map<string, ProjectListRow>
  hideProject?: boolean
}) {
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
          {!hideProject ? <div className="text-[13px] font-semibold truncate">{projectLabel}</div> : null}
          <div className={`text-[11px] text-ink-3 ${hideProject ? '' : 'mt-0.5'}`}>
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

export function groupRunsByState(rows: TimeReviewRunRow[]): Record<TimeReviewState, TimeReviewRunRow[]> {
  const groups: Record<TimeReviewState, TimeReviewRunRow[]> = { pending: [], approved: [], rejected: [] }
  for (const r of rows) groups[r.state].push(r)
  return groups
}

export function timeReviewStateLabel(state: TimeReviewState): string {
  if (state === 'pending') return 'To approve'
  if (state === 'approved') return 'Approved'
  return 'Disputed'
}

function formatPeriod(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`
}

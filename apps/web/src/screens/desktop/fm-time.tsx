/**
 * Foreman desktop time-approval screen — "FM · TIME · FIRST-LINE APPROVAL"
 * (Desktop v2). The dense desktop composition of the mobile time-review
 * surface (../mobile/time-review.tsx): a TOTAL HOURS hero KPI strip plus a
 * crew DataTable with a per-row Approve action.
 *
 * Reuses the SAME data layer as mobile — bootstrap labor/workers/projects,
 * the time-review-run snapshot for per-entry anomalies
 * (useTimeReviewRuns/useTimeReviewRun), and usePatchLaborEntry for the
 * Approve action. No new state machine; TanStack only, per CLAUDE.md.
 */
import { useMemo, useState } from 'react'
import type { BootstrapResponse, TimeAnomaly } from '@/lib/api'
import { usePatchLaborEntry } from '@/lib/api/labor-entries'
import { useTimeReviewRun, useTimeReviewRuns } from '@/lib/api/time-review'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAvatar, MButton, MPill, avatarToneFor, initialsFor } from '@/components/m'
import { formatDecimalHours, todayIso } from '../mobile/format.js'

type CrewTimeRow = {
  id: string
  worker: string
  workerId: string
  project: string
  hours: number
  anomalies: TimeAnomaly[]
  approved: boolean
}

export function FmTime({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // Per-row PATCH /api/labor-entries/:id (same hook + invalidations as the
  // mobile foreman flow). Tracks which row is mid-flight for the spinner.
  const patchLabor = usePatchLaborEntry()
  const pendingRowId = patchLabor.isPending ? (patchLabor.variables?.id ?? null) : null

  const today = todayIso()
  const todayLabor = useMemo(() => labor.filter((l) => l.occurred_on === today && !l.deleted_at), [labor, today])

  // Latch onto the most recent pending time-review run (preferring one with
  // anomalies) and pull its snapshot — exactly the mobile derivation — so we
  // can join per-entry anomaly reasons back onto each labor row.
  const pendingRuns = useTimeReviewRuns({ state: 'pending' })
  const latestRunId = useMemo(() => {
    const runs = pendingRuns.data?.timeReviewRuns ?? []
    if (runs.length === 0) return null
    const flagged = runs.find((r) => r.anomaly_count > 0)
    return (flagged ?? runs[0])?.id ?? null
  }, [pendingRuns.data])
  const runSnapshot = useTimeReviewRun(latestRunId)

  const flaggedById = useMemo(() => {
    const map = new Map<string, TimeAnomaly[]>()
    for (const ea of runSnapshot.data?.context.anomalies ?? []) {
      if (ea.anomalies.length > 0) map.set(ea.entry_id, ea.anomalies)
    }
    return map
  }, [runSnapshot.data])

  const rows = useMemo<CrewTimeRow[]>(
    () =>
      todayLabor.map((l) => {
        const w = workers.find((x) => x.id === l.worker_id)
        const p = projects.find((x) => x.id === l.project_id)
        return {
          id: l.id,
          worker: w?.name ?? 'Unassigned',
          workerId: l.worker_id ?? l.id,
          project: p?.name ?? 'Unknown project',
          hours: Number(l.hours ?? 0),
          anomalies: flaggedById.get(l.id) ?? [],
          approved: isApproved(l.status),
        }
      }),
    [todayLabor, workers, projects, flaggedById],
  )

  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0)
  const crewCount = new Set(todayLabor.map((l) => l.worker_id).filter(Boolean)).size
  const flaggedCount = rows.filter((r) => r.anomalies.length > 0).length
  const pendingCount = rows.filter((r) => !r.approved).length

  // Approve one row through the same PATCH the mobile inline editor uses.
  // The time-review approve event is run-level; per-entry sign-off goes
  // through labor-entries status='approved'.
  const [rowError, setRowError] = useState<string | null>(null)
  const handleApprove = async (id: string) => {
    setRowError(null)
    try {
      await patchLabor.mutateAsync({ id, patch: { status: 'approved' } })
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not approve entry')
    }
  }

  const columns: Array<DColumn<CrewTimeRow>> = [
    {
      key: 'worker',
      header: 'Worker',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <MAvatar initials={initialsFor(r.worker)} tone={avatarToneFor(r.workerId)} size="sm" />
          <span className="d-table-cell-strong">{r.worker}</span>
        </span>
      ),
    },
    { key: 'project', header: 'Project', render: (r) => r.project },
    { key: 'hours', header: 'Hours', numeric: true, render: (r) => formatDecimalHours(r.hours, 1) },
    {
      key: 'anomaly',
      header: 'Anomaly',
      render: (r) =>
        r.anomalies.length > 0 ? (
          <MPill tone="red" dot>
            {r.anomalies[0]?.code ?? 'flag'}
            {r.anomalies.length > 1 ? ` +${r.anomalies.length - 1}` : ''}
          </MPill>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        ),
    },
    {
      key: 'approve',
      header: '',
      render: (r) =>
        r.approved ? (
          <MPill tone="green">approved</MPill>
        ) : (
          <MButton
            size="sm"
            variant="primary"
            onClick={() => void handleApprove(r.id)}
            disabled={pendingRowId === r.id}
          >
            {pendingRowId === r.id ? 'Saving…' : 'Approve'}
          </MButton>
        ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Time</DEyebrow>
          <DH1>Approve hours</DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label="Total hours"
            value={formatDecimalHours(totalHours, 1).replace('h', '')}
            unit="h"
            meta={totalHours > 0 ? 'Today on the clock' : 'No clock-ins'}
            metaTone={totalHours > 0 ? 'good' : undefined}
          />
          <DKpi label="Crew" value={String(crewCount)} meta={`${crewCount} on the clock`} />
          <DKpi
            label="Flagged"
            value={String(flaggedCount)}
            tone={flaggedCount > 0 ? 'accent' : undefined}
            meta="Need a look"
            metaTone={flaggedCount > 0 ? 'bad' : undefined}
          />
          <DKpi
            label="Pending"
            value={String(pendingCount)}
            meta="Awaiting approval"
            metaTone={pendingCount > 0 ? undefined : 'good'}
          />
        </DKpiStrip>

        {rowError ? (
          <div className="d-card" data-tone="accent" style={{ color: 'var(--m-accent-ink)' }}>
            {rowError}
          </div>
        ) : null}

        <DataTable<CrewTimeRow>
          title="Crew time · today"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No hours yet today. Crew clock-ins land here as they happen."
        />
      </div>
    </div>
  )
}

function isApproved(status: string | null | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s === 'approved' || s === 'closed' || s === 'paid'
}

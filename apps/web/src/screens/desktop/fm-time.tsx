/**
 * Foreman desktop time-approval screen — "FM · TIME · FIRST-LINE APPROVAL"
 * (Desktop v2). The dense desktop composition of the mobile time-review
 * surface (../mobile/time-review.tsx): a TOTAL HOURS hero KPI strip plus a
 * crew DataTable, with a sticky footer that drives the run-level decision.
 *
 * Headless-first: the batch decision (sign off / push back) is dispatched
 * through the registered `time_review_run` workflow via `useTimeReview`
 * (APPROVE / REJECT / REOPEN) — the footer renders only the snapshot's
 * `next_events`, so the UI can't invent a transition the reducer doesn't
 * allow. Anomalies still ride the run snapshot. No per-row status PATCH.
 */
import { useMemo } from 'react'
import type { BootstrapResponse, TimeAnomaly } from '@/lib/api'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useControlPlaneProbePublish } from '@/lib/control-plane-probe-pub'
import { useTimeReview } from '@/machines/time-review'
import { anomalyChipLabel, useCreateTimeReviewRun, useTimeReviewRuns } from '@/lib/api/time-review'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAvatar, MButton, MPill, avatarToneFor, initialsFor } from '@/components/m'
import { endOfWeek, formatDecimalHours, shortDate, startOfWeek } from '../mobile/format.js'

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
  const companySlug = getActiveCompanySlug()
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // The review week (Monday-anchored) — the design header is week-scoped.
  const weekStart = useMemo(() => startOfWeek(), [])
  const weekEnd = useMemo(() => endOfWeek(), [])

  // Latch onto the most recent pending run (preferring one with anomalies)
  // and mount the headless workflow machine on it.
  const pendingRuns = useTimeReviewRuns({ state: 'pending' })
  const latestRunId = useMemo(() => {
    const runs = pendingRuns.data?.timeReviewRuns ?? []
    if (runs.length === 0) return null
    const flagged = runs.find((r) => r.anomaly_count > 0)
    return (flagged ?? runs[0])?.id ?? null
  }, [pendingRuns.data])
  const runId = latestRunId ?? ''

  const tr = useTimeReview(runId, companySlug)
  useControlPlaneProbePublish('timeReviewState', tr.snapshot?.state ?? null)

  const createRun = useCreateTimeReviewRun()
  const handleStartReview = () => {
    if (createRun.isPending) return
    createRun.mutate({ period_start: weekStart, period_end: weekEnd })
  }

  const ctx = tr.snapshot?.context
  const coveredIds = useMemo(() => new Set(ctx?.covered_entry_ids ?? []), [ctx?.covered_entry_ids])
  const periodStart = ctx?.period_start ?? weekStart
  const periodEnd = ctx?.period_end ?? weekEnd
  const hasRun = Boolean(tr.snapshot)

  const weekLabor = useMemo(() => {
    if (coveredIds.size > 0) return labor.filter((l) => coveredIds.has(l.id) && !l.deleted_at)
    return labor.filter((l) => !l.deleted_at && l.occurred_on >= periodStart && l.occurred_on <= periodEnd)
  }, [labor, coveredIds, periodStart, periodEnd])

  const flaggedById = useMemo(() => {
    const map = new Map<string, TimeAnomaly[]>()
    for (const ea of ctx?.anomalies ?? []) {
      if (ea.anomalies.length > 0) map.set(ea.entry_id, ea.anomalies)
    }
    return map
  }, [ctx?.anomalies])

  const rows = useMemo<CrewTimeRow[]>(
    () =>
      weekLabor.map((l) => {
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
    [weekLabor, workers, projects, flaggedById],
  )

  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0)
  const crewCount = new Set(weekLabor.map((l) => l.worker_id).filter(Boolean)).size
  const flaggedCount = rows.filter((r) => r.anomalies.length > 0).length
  const pendingCount = rows.filter((r) => !r.approved).length
  const weekRangeLabel = `${shortDate(periodStart)} → ${shortDate(periodEnd)}`

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
          // Full anomaly flag stack — one chip per anomaly (design msg_68),
          // not a single chip + "+N" collapse. Wrap so the cell stays tidy.
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {r.anomalies.map((a, i) => (
              <MPill key={`${r.id}-${a.code}-${i}`} tone="red" dot>
                {anomalyChipLabel(a.code)}
              </MPill>
            ))}
          </span>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <DEyebrow>Foreman · Time · Week {weekRangeLabel}</DEyebrow>
            <DH1>Approve hours</DH1>
          </div>
          {!hasRun ? (
            <MButton variant="primary" onClick={handleStartReview} disabled={createRun.isPending}>
              {createRun.isPending ? 'Starting…' : "Start this week's review"}
            </MButton>
          ) : null}
        </div>

        <DKpiStrip>
          <DKpi
            label="Total hours"
            value={formatDecimalHours(totalHours, 1).replace('h', '')}
            unit="h"
            meta={totalHours > 0 ? 'This review week' : 'No clock-ins'}
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

        {tr.outOfSync ? (
          <div className="d-card" data-tone="accent" style={{ color: 'var(--m-accent-ink)' }}>
            Run state moved on the server. Reloaded — pick the next action again.
          </div>
        ) : null}
        {tr.error && !tr.outOfSync ? (
          <div className="d-card" data-tone="accent" style={{ color: 'var(--m-accent-ink)' }}>
            {tr.error}{' '}
            <button type="button" onClick={tr.dismissError} style={{ textDecoration: 'underline' }}>
              dismiss
            </button>
          </div>
        ) : null}

        <DataTable<CrewTimeRow>
          title={`Crew time · week of ${shortDate(periodStart)}`}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No hours this week. Crew clock-ins land here as they happen."
        />

        {/* Sticky run-level decision footer driven by the snapshot's
            next_events. The APPROVE label communicates the downstream
            hand-off ("SEND TO MIKE" / send-to-PM) the design references; the
            dispatched event is still the plain workflow APPROVE. */}
        {hasRun && tr.snapshot!.next_events.length > 0 ? (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {tr.snapshot!.next_events.map((ev) => {
              const isApprove = ev.type === 'APPROVE'
              const label = isApprove ? `Approve ${pendingCount} clean · Send to PM` : ev.label
              return (
                <MButton
                  key={ev.type}
                  variant={isApprove ? 'primary' : 'ghost'}
                  disabled={tr.isSubmitting}
                  onClick={() => {
                    if (ev.type === 'APPROVE') {
                      tr.dispatch({ event: 'APPROVE' })
                    } else {
                      const reason =
                        typeof window !== 'undefined'
                          ? (window.prompt(`${ev.label} — add a reason`) ?? '')
                          : 'flagged for correction'
                      if (reason.trim().length === 0) return
                      tr.dispatch({ event: ev.type as 'REJECT' | 'REOPEN', reason })
                    }
                  }}
                >
                  {tr.isSubmitting ? 'Working…' : label}
                </MButton>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function isApproved(status: string | null | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s === 'approved' || s === 'closed' || s === 'paid'
}

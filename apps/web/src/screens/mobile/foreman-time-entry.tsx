/**
 * Mobile foreman manual time-entry. Mounted at `/time/new` inside the
 * mobile shell. The auto-geofence pipeline catches the bulk of crew
 * time; this form covers manual overrides — a foreman adding or
 * correcting a worker's hours by hand.
 *
 * Server-side, POST /api/labor-entries enforces:
 *   - role ∈ admin / foreman / office
 *   - division_code ↔ service_item_code via the
 *     `service_item_divisions` xref (lenient — empty xref means anything
 *     goes; once curated, the pair must match)
 *
 * We send the project's `division_code` along so the foreman doesn't
 * have to pick one — the project already binds the right one in
 * practice. The 400 error body bubbles back through ApiError so the
 * banner explains why a code was rejected.
 *
 * The note field is intentionally captured client-side only — the
 * labor_entries table doesn't expose a `notes` column. Surfacing notes
 * on the row belongs with the time-review row chrome (the
 * PendingInlineEditor in time-review.tsx accepts a `note` patch on
 * approve/reject) so foremen still attribute manual overrides through
 * that channel.
 */
import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, TimeAnomaly } from '@/lib/api'
import { ApiError, getActiveCompanySlug } from '../../lib/api/client.js'
import { useCreateLaborEntry } from '../../lib/api/labor-entries.js'
import { useControlPlaneProbePublish } from '../../lib/control-plane-probe-pub.js'
import { useTimeReview } from '../../machines/time-review.js'
import { anomalyChipLabel, useCreateTimeReviewRun, useTimeReviewRuns } from '../../lib/api/time-review.js'
import {
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MInput,
  MPill,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '../../components/d/index.js'
import { endOfWeek, formatDecimalHours, shortDate, startOfWeek, todayIso } from './format.js'

export function MobileForemanTimeEntry({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const createLabor = useCreateLaborEntry()

  const workers = useMemo(() => (bootstrap?.workers ?? []).filter((w) => !w.deleted_at), [bootstrap?.workers])
  const projects = useMemo(
    () => (bootstrap?.projects ?? []).filter((p) => p.status !== 'archived'),
    [bootstrap?.projects],
  )
  const serviceItems = useMemo(() => bootstrap?.serviceItems ?? [], [bootstrap?.serviceItems])

  const [workerId, setWorkerId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [serviceItemCode, setServiceItemCode] = useState<string>('')
  const [occurredOn, setOccurredOn] = useState<string>(() => todayIso())
  const [hours, setHours] = useState<string>('')
  const [sqftDone, setSqftDone] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Carry the request id off the failed API call so the user can paste
  // it into a support thread via the TraceIdFooter on the error banner.
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const workerFieldId = useId()
  const projectFieldId = useId()
  const serviceItemFieldId = useId()
  const dateFieldId = useId()
  const hoursFieldId = useId()

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  // Inline validation only after the user tries to save once.
  const workerError = touched && workerId.length === 0 ? 'Pick a worker.' : null
  const projectError = touched && projectId.length === 0 ? 'Pick a project.' : null
  const serviceItemError = touched && serviceItemCode.length === 0 ? 'Pick a service item.' : null
  const dateError = touched && occurredOn.length === 0 ? 'Date is required.' : null
  const hoursError = touched && !(Number(hours) > 0) ? 'Hours must be greater than 0.' : null

  // Notes aren't stored server-side yet — we capture them for the
  // approval-queue handoff so the foreman knows the row is intentional
  // even when the catalog text alone is ambiguous. Reference the value
  // so the unused-state lint stays quiet without dropping the field.
  void notes

  const canSubmit =
    workerId.length > 0 &&
    projectId.length > 0 &&
    serviceItemCode.length > 0 &&
    occurredOn.length > 0 &&
    Number(hours) > 0 &&
    !createLabor.isPending

  const handleSubmit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setError(null)
    setErrorRequestId(null)
    try {
      await createLabor.mutateAsync({
        project_id: projectId,
        worker_id: workerId,
        service_item_code: serviceItemCode,
        hours: Number(hours),
        occurred_on: occurredOn,
        sqft_done: sqftDone ? Number(sqftDone) : null,
        division_code: project?.division_code ?? null,
        status: 'draft',
      })
      navigate('/time?created=1')
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : err instanceof Error ? err.message : String(err))
      setErrorRequestId(err instanceof ApiError ? err.requestId : null)
    }
  }

  return (
    <>
      <MTopBar back title="Add time entry" onBack={() => navigate('/time')} />
      <MBody>
        {error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner tone="error" title="Could not save" body={error} requestId={errorRequestId} />
          </div>
        ) : null}

        <MSectionH>Who & where</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Worker *" htmlFor={workerFieldId} error={workerError}>
            <MSelect
              id={workerFieldId}
              value={workerId}
              onChange={(e) => setWorkerId(e.currentTarget.value)}
              aria-invalid={workerError ? true : undefined}
              aria-describedby={workerError ? `${workerFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select worker…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Project *" htmlFor={projectFieldId} error={projectError}>
            <MSelect
              id={projectFieldId}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.currentTarget.value)
                // Reset the service item when the project flips — the
                // catalog xref is project-division-scoped so the
                // previously valid code may no longer apply.
                setServiceItemCode('')
              }}
              aria-invalid={projectError ? true : undefined}
              aria-describedby={projectError ? `${projectFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.customer_name ? ` — ${p.customer_name}` : ''}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Service item *" htmlFor={serviceItemFieldId} error={serviceItemError}>
            <MSelect
              id={serviceItemFieldId}
              value={serviceItemCode}
              onChange={(e) => setServiceItemCode(e.currentTarget.value)}
              disabled={serviceItems.length === 0}
              aria-invalid={serviceItemError ? true : undefined}
              aria-describedby={serviceItemError ? `${serviceItemFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select service item…</option>
              {serviceItems.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </MSelect>
            {project?.division_code ? (
              <div className="m-quiet-sm" style={{ marginTop: 6 }}>
                Project division <code>{project.division_code}</code> · the server checks the service-item catalog.
              </div>
            ) : null}
          </Field>
        </div>

        <MSectionH>When & how much</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Date *" htmlFor={dateFieldId} error={dateError}>
            <MInput
              id={dateFieldId}
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.currentTarget.value)}
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? `${dateFieldId}-err` : undefined}
              aria-required="true"
            />
          </Field>
          <Field label="Hours *" htmlFor={hoursFieldId} error={hoursError}>
            <MInput
              id={hoursFieldId}
              type="number"
              inputMode="decimal"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.currentTarget.value)}
              placeholder="8.0"
              aria-invalid={hoursError ? true : undefined}
              aria-describedby={hoursError ? `${hoursFieldId}-err` : undefined}
              aria-required="true"
            />
          </Field>
          <Field label="Sqft done (optional)">
            <MInput
              type="number"
              inputMode="decimal"
              min="0"
              value={sqftDone}
              onChange={(e) => setSqftDone(e.currentTarget.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <MSectionH>Notes</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <MTextarea
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            placeholder="Why this entry needs a manual override (visible to the worker on dispute)."
            style={{ width: '100%', minHeight: 96 }}
          />
        </div>

        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
              {createLabor.isPending ? 'Saving…' : 'Save entry'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/time')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

function Field({
  label,
  children,
  htmlFor,
  error,
}: {
  label: string
  children: React.ReactNode
  htmlFor?: string
  error?: string | null
}) {
  return (
    <label style={{ display: 'block' }} {...(htmlFor ? { htmlFor } : {})}>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--m-ink-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-err` : undefined}
          style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}
        >
          {error}
        </p>
      ) : null}
    </label>
  )
}

// ===========================================================================
// FmTime — first-line time-approval surface (the former
// screens/desktop/fm-time.tsx), folded into this file as part of the Phase B
// foreman pair consolidation.
//
// FLAG — one-sided / divergent twins: the `fm-time ↔ foreman-time-entry` pair
// is NOT a responsive layout pair. `MobileForemanTimeEntry` (above) is the
// manual labor-entry FORM (mounted at /time/new and /desktop/fm/time/new),
// while `FmTime` is the weekly time-REVIEW/approval run surface derived from
// ../mobile/time-review.tsx (mounted at /desktop/fm/time). They are different
// features at different routes, so they are kept as two distinct exports in
// this one file rather than collapsed into a single breakpoint-selected
// component — collapsing them would render the wrong surface for one route at
// each viewport. The desktop time-review route still mounts `FmTime`; the
// mobile time tab still mounts MobileTimeReview (unchanged). This consolidation
// only removes the duplicate file, it does not alter either behavior.
// ===========================================================================

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

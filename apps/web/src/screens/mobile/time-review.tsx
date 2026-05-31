/**
 * Mobile time review entry — the foreman's 4:00 PM end-of-day approval
 * surface (design msg_67 / msg_68, "TIME · N PENDING", week-scoped).
 *
 * Headless-first: the run-level decision (sign off / push back) is driven
 * through the registered `time_review_run` workflow via the `useTimeReview`
 * XState machine — APPROVE / REJECT / REOPEN are dispatched as run events,
 * which revives the deterministic lock_labor_entries → labor_payroll chain.
 * Per-entry clock-in/out/break corrections legitimately stay on
 * PATCH /api/labor-entries/:id (the inline editor) — a deliberate carve-out
 * so the workflow doesn't fragment that write path (see the reducer doc in
 * packages/workflows/src/time-review.ts). When no run exists yet the screen
 * offers a "Start this week's review" CTA that creates one for the current
 * review week.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { BootstrapResponse, LaborRow, TimeAnomaly } from '@/lib/api'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useControlPlaneProbePublish } from '@/lib/control-plane-probe-pub'
import { useTimeReview } from '@/machines/time-review'
import { usePatchLaborEntry } from '../../lib/api/labor-entries.js'
import { anomalyChipLabel, useCreateTimeReviewRun, useTimeReviewRuns } from '../../lib/api/time-review.js'
import {
  MAiStripe,
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MChip,
  MChipRow,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { endOfWeek, formatDecimalHours, formatMoney, shortDate, startOfWeek, timeOfDay } from './format.js'

export function MobileTimeReview({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const justCreated = searchParams.get('created') === '1'
  const companySlug = getActiveCompanySlug()
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Segmented entry-list filter (design msg_67/msg_68): ALL · n, FLAGGED · n,
  // PER PROJECT (groups the pending rows under a per-project section header).
  const [listFilter, setListFilter] = useState<'all' | 'flagged' | 'per-project'>('all')
  // Optimistic in-memory edits per labor row. The real /api/labor-entries
  // PATCH route receives these on the inline editor's Save; we surface them
  // here so the editor works against the bootstrap state without forcing a
  // refetch while the foreman is reviewing offline.
  const [edits, setEdits] = useState<Record<string, { in?: string; out?: string; break?: string; note?: string }>>({})

  // Per-row PATCH /api/labor-entries/:id stays on TanStack — it's the
  // legitimate clock-time correction write path (not the run decision).
  const patchLabor = usePatchLaborEntry()
  const pendingRowId = patchLabor.isPending ? (patchLabor.variables?.id ?? null) : null

  // The review week (Monday-anchored) — the design header is "WEEK · …".
  const weekStart = useMemo(() => startOfWeek(), [])
  const weekEnd = useMemo(() => endOfWeek(), [])

  // Latch onto the most recent pending run for the current company (one
  // exists once "Start this week's review" has been tapped, or it was
  // created out-of-band). Selecting it mounts the headless workflow machine.
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const pendingRuns = useTimeReviewRuns({ state: 'pending' })
  const latestRunId = useMemo(() => {
    const runs = pendingRuns.data?.timeReviewRuns ?? []
    if (runs.length === 0) return null
    // List route already orders period_start desc, created_at desc.
    const flagged = runs.find((r) => r.anomaly_count > 0)
    return (flagged ?? runs[0])?.id ?? null
  }, [pendingRuns.data])
  const runId = activeRunId ?? latestRunId ?? ''

  // Headless workflow machine — owns the request lifecycle, optimistic
  // concurrency (state_version), and the 409 → refresh / outOfSync handling.
  const tr = useTimeReview(runId, companySlug)
  // Publish the run state into the control-plane probe (capture modal folds
  // page_state.time_review_state), mirroring billing-run-detail.tsx.
  useControlPlaneProbePublish('timeReviewState', tr.snapshot?.state ?? null)

  const createRun = useCreateTimeReviewRun()
  const handleStartReview = () => {
    if (createRun.isPending) return
    createRun.mutate(
      { period_start: weekStart, period_end: weekEnd },
      { onSuccess: (snapshot) => setActiveRunId(snapshot.context.id) },
    )
  }

  // Display window: the run's covered period if we have a snapshot, else
  // the computed review week. The labor list is keyed off covered_entry_ids
  // (the headless source of truth for which entries the run covers); before
  // a run exists we fall back to the week-window date filter.
  const ctx = tr.snapshot?.context
  const coveredIds = useMemo(() => new Set(ctx?.covered_entry_ids ?? []), [ctx?.covered_entry_ids])
  const periodStart = ctx?.period_start ?? weekStart
  const periodEnd = ctx?.period_end ?? weekEnd

  const weekLabor = useMemo(() => {
    if (coveredIds.size > 0) return labor.filter((l) => coveredIds.has(l.id) && !l.deleted_at)
    return labor.filter((l) => !l.deleted_at && l.occurred_on >= periodStart && l.occurred_on <= periodEnd)
  }, [labor, coveredIds, periodStart, periodEnd])

  const pending = useMemo(() => weekLabor.filter((l) => isPending(l.status)), [weekLabor])
  const approved = useMemo(() => weekLabor.filter((l) => isApproved(l.status)), [weekLabor])

  const totalHours = weekLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const laborCost = weekLabor.reduce((sum, l) => {
    const project = projects.find((p) => p.id === l.project_id)
    const rate = Number(project?.labor_rate ?? 0)
    return sum + Number(l.hours ?? 0) * rate
  }, 0)

  // Deterministic, multi-signal anomaly detection runs server-side
  // (apps/api/src/lib/time-anomalies.ts) and rides the run snapshot as a
  // per-entry `anomalies: [{ code, message }]` projection. Map each flagged
  // entry_id back to the bootstrap labor row + worker name.
  const [aiDismissed, setAiDismissed] = useState(false)

  type FlaggedEntry = { entryId: string; name: string; hours: number; anomalies: TimeAnomaly[] }
  const flaggedEntries = useMemo<FlaggedEntry[]>(() => {
    const entryAnomalies = ctx?.anomalies ?? []
    return entryAnomalies
      .filter((ea) => ea.anomalies.length > 0)
      .map((ea) => {
        const row = labor.find((l) => l.id === ea.entry_id)
        const w = row ? workers.find((x) => x.id === row.worker_id) : undefined
        return {
          entryId: ea.entry_id,
          name: w?.name ?? 'A crew member',
          hours: Number(row?.hours ?? 0),
          anomalies: ea.anomalies,
        }
      })
  }, [ctx?.anomalies, labor, workers])

  // Per-entry flag set so each crew week row can carry its anomaly chips
  // without re-deriving. Same data source as the AI stripe.
  const flaggedById = useMemo(() => {
    const map = new Map<string, TimeAnomaly[]>()
    for (const fe of flaggedEntries) map.set(fe.entryId, fe.anomalies)
    return map
  }, [flaggedEntries])

  // Pending rows scoped to the active filter chip. FLAGGED keeps only rows
  // carrying anomalies; ALL / PER PROJECT show the full pending set (PER
  // PROJECT just changes how the list is grouped, below).
  const filteredPending = useMemo(() => {
    if (listFilter === 'flagged') return pending.filter((l) => (flaggedById.get(l.id)?.length ?? 0) > 0)
    return pending
  }, [pending, listFilter, flaggedById])

  // PER PROJECT view: group the filtered pending rows under a project header.
  const pendingByProject = useMemo(() => {
    const groups = new Map<string, { name: string; rows: typeof pending }>()
    for (const l of filteredPending) {
      const name = projects.find((p) => p.id === l.project_id)?.name ?? 'Unknown project'
      const cur = groups.get(l.project_id) ?? { name, rows: [] }
      cur.rows.push(l)
      groups.set(l.project_id, cur)
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [filteredPending, projects])

  // Any pending row carrying more than one anomaly drives the msg_68
  // "multi-flag stack" banner above the list.
  const hasMultiFlagRow = useMemo(
    () => pending.some((l) => (flaggedById.get(l.id)?.length ?? 0) > 1),
    [pending, flaggedById],
  )

  const weekRangeLabel = `${shortDate(periodStart)} → ${shortDate(periodEnd)}`
  const hasRun = Boolean(tr.snapshot)

  return (
    <>
      <MTopBar
        title="Time"
        sub={`Week · ${weekRangeLabel}`}
        actionLabel="Add entry"
        actionIcon={<MI.Plus size={20} />}
        onAction={() => navigate('/time/new')}
      />
      <MBody>
        {justCreated ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="ok"
              title="Time entry saved"
              body="It will land in the next approval roll-up."
              action={
                <MButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams)
                    next.delete('created')
                    setSearchParams(next, { replace: true })
                  }}
                >
                  Dismiss
                </MButton>
              }
            />
          </div>
        ) : null}
        {/* TOTAL HOURS big-number hero — v2 brutalist: mono micro-label,
            tabular bignum with a unit suffix, burden + flag-count subline,
            closed off with a heavy section bar. */}
        <div
          style={{
            padding: '18px 16px',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div className="m-kpi-eyebrow">Total hours</div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 64,
              lineHeight: 0.95,
              letterSpacing: '-0.03em',
              marginTop: 8,
              color: 'var(--m-ink)',
            }}
          >
            {formatDecimalHours(totalHours, 1)}
            <span style={{ fontSize: 22, color: 'var(--m-ink-3)' }}> H</span>
          </div>
          <div className="m-kpi-eyebrow" style={{ marginTop: 8, color: 'var(--m-ink-2)' }}>
            Burden {formatMoney(laborCost)} · {flaggedEntries.length} flag{flaggedEntries.length === 1 ? '' : 's'} ·{' '}
            {pending.length} pending
          </div>
        </div>
        {weekLabor.length === 0 ? (
          <MEmptyState
            title="No hours this week"
            body="Crew clock-ins land here as they happen. End-of-day approvals roll up at 4:00 PM."
            {...(!hasRun
              ? {
                  primaryLabel: createRun.isPending ? 'Starting…' : "Start this week's review",
                  onPrimary: handleStartReview,
                }
              : {})}
          />
        ) : (
          <>
            {tr.outOfSync ? (
              <div style={{ padding: '8px 16px 0' }}>
                <MBanner
                  tone="warn"
                  title="Run state moved on the server"
                  body="Reloaded — pick the next action again."
                />
              </div>
            ) : null}
            {tr.error && !tr.outOfSync ? (
              <div style={{ padding: '8px 16px 0' }}>
                <MBanner
                  tone="error"
                  title="Couldn't update the review"
                  body={tr.error}
                  action={
                    <MButton size="sm" variant="ghost" onClick={tr.dismissError}>
                      Dismiss
                    </MButton>
                  }
                />
              </div>
            ) : null}
            <MKpiRow cols={2}>
              <MKpi label="Approved" value={String(approved.length)} meta="ready for payroll" metaTone="green" />
              <MKpi
                label="Pending"
                value={String(pending.length)}
                meta="awaiting review"
                metaTone={pending.length > 0 ? 'amber' : undefined}
              />
            </MKpiRow>
            {/* Segmented filter chips (design msg_67/msg_68): ALL / FLAGGED /
                PER PROJECT scope the pending entry list below. */}
            <MChipRow>
              <MChip active={listFilter === 'all'} onClick={() => setListFilter('all')} count={pending.length}>
                All
              </MChip>
              <MChip
                active={listFilter === 'flagged'}
                onClick={() => setListFilter('flagged')}
                count={pending.filter((l) => (flaggedById.get(l.id)?.length ?? 0) > 0).length}
              >
                Flagged
              </MChip>
              <MChip active={listFilter === 'per-project'} outline onClick={() => setListFilter('per-project')}>
                Per project
              </MChip>
            </MChipRow>
            {/* Multi-flag stack banner (design msg_68) — surfaced when any row
                carries more than one anomaly, prompting per-flag resolution. */}
            {hasMultiFlagRow ? (
              <div style={{ padding: '4px 16px 0' }}>
                <MBanner
                  tone="warn"
                  title="Multi-flag stack"
                  body="Tap a row with stacked flags to resolve each one."
                />
              </div>
            ) : null}
            {flaggedEntries.length > 0 && !aiDismissed ? (
              <div style={{ padding: '4px 16px 0' }}>
                <MAiStripe
                  tone="warn"
                  eyebrow="NEEDS YOUR EYES"
                  title={
                    flaggedEntries.length === 1
                      ? `1 entry needs a look before you approve.`
                      : `${flaggedEntries.length} entries need a look before you approve.`
                  }
                  attribution={<>Based on this period&apos;s clock + labor activity.</>}
                  onDismiss={() => setAiDismissed(true)}
                  action={
                    flaggedEntries[0] && labor.some((l) => l.id === flaggedEntries[0]!.entryId) ? (
                      <MButton
                        size="sm"
                        variant="quiet"
                        onClick={() => {
                          setExpandedId(flaggedEntries[0]!.entryId)
                          setAiDismissed(true)
                        }}
                      >
                        Review first entry
                      </MButton>
                    ) : undefined
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {flaggedEntries.slice(0, 5).map((fe) => (
                      <div key={fe.entryId}>
                        <div style={{ fontWeight: 600 }}>
                          {fe.name}
                          {fe.hours > 0 ? ` · ${formatDecimalHours(fe.hours, 1)}` : ''}
                        </div>
                        <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                          {fe.anomalies.map((a, i) => (
                            <li key={`${fe.entryId}-${a.code}-${i}`}>{a.message}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {flaggedEntries.length > 5 ? (
                      <div className="m-quiet-sm">+{flaggedEntries.length - 5} more flagged.</div>
                    ) : null}
                  </div>
                </MAiStripe>
              </div>
            ) : null}
            {(() => {
              // Shared pending-row renderer so the flat (ALL / FLAGGED) and
              // grouped (PER PROJECT) views stay in lockstep.
              const renderRow = (l: (typeof pending)[number]) => {
                const w = workers.find((x) => x.id === l.worker_id)
                const p = projects.find((x) => x.id === l.project_id)
                const isExpanded = expandedId === l.id
                const rowFlags = flaggedById.get(l.id) ?? []
                return (
                  <div key={l.id}>
                    <MListRow
                      leading={
                        w ? (
                          <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />
                        ) : (
                          <MI.Users size={18} />
                        )
                      }
                      headline={w?.name ?? 'Unassigned'}
                      supporting={
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span>{`${p?.name ?? 'Unknown project'} · ${l.service_item_code ?? ''}`}</span>
                          {/* Full anomaly flag stack — one square mono chip
                              per anomaly (design msg_68), not a single
                              chip + "+N" collapse. */}
                          {rowFlags.map((a, i) => (
                            <span
                              key={`${l.id}-${a.code}-${i}`}
                              style={{
                                padding: '2px 6px',
                                borderRadius: 0,
                                background: 'var(--m-red)',
                                color: 'var(--m-card)',
                                fontFamily: 'var(--m-num)',
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                              }}
                            >
                              {anomalyChipLabel(a.code)}
                            </span>
                          ))}
                        </span>
                      }
                      trailing={<span className="num">{formatDecimalHours(Number(l.hours ?? 0), 1)}</span>}
                      chev
                      onTap={() => setExpandedId(isExpanded ? null : l.id)}
                    />
                    {isExpanded ? (
                      <PendingInlineEditor
                        labor={l}
                        edit={edits[l.id] ?? {}}
                        isSubmitting={pendingRowId === l.id}
                        error={patchLabor.error && pendingRowId === null ? patchLabor.error.message : null}
                        multiFlag={rowFlags.length > 1}
                        onEdit={(patch) => setEdits((cur) => ({ ...cur, [l.id]: { ...(cur[l.id] ?? {}), ...patch } }))}
                        onSave={async () => {
                          // Inline clock-time correction — the deliberate
                          // carve-out that stays on PATCH /api/labor-entries.
                          // The run-level sign-off is the footer APPROVE.
                          const e = edits[l.id]
                          const patch: { hours?: number } = {}
                          const adjustedHours = adjustedHoursFromEdit(l, e)
                          if (adjustedHours !== null) patch.hours = adjustedHours
                          if (Object.keys(patch).length === 0) {
                            setExpandedId(null)
                            return
                          }
                          try {
                            await patchLabor.mutateAsync({ id: l.id, patch })
                            setExpandedId(null)
                            setEdits((cur) => {
                              const next = { ...cur }
                              delete next[l.id]
                              return next
                            })
                          } catch {
                            // patchLabor.error renders inline; keep the
                            // editor open so the foreman can retry.
                          }
                        }}
                      />
                    ) : null}
                  </div>
                )
              }

              if (filteredPending.length === 0) {
                // Pending rows exist but the active filter hid them all
                // (e.g. FLAGGED with no flagged rows) — keep the section quiet.
                if (pending.length === 0) return null
                return (
                  <>
                    <MSectionH>Crew week · pending</MSectionH>
                    <div className="m-quiet-sm" style={{ padding: '0 16px 8px' }}>
                      No {listFilter === 'flagged' ? 'flagged ' : ''}entries in this view.
                    </div>
                  </>
                )
              }

              if (listFilter === 'per-project') {
                return (
                  <>
                    {pendingByProject.map((g) => (
                      <div key={g.name}>
                        <MSectionH>{g.name}</MSectionH>
                        <MListInset>{g.rows.map(renderRow)}</MListInset>
                      </div>
                    ))}
                  </>
                )
              }

              return (
                <>
                  <MSectionH>
                    {listFilter === 'flagged' ? 'Crew week · flagged' : 'Crew week · pending'}
                  </MSectionH>
                  <MListInset>{filteredPending.map(renderRow)}</MListInset>
                </>
              )
            })()}
            {approved.length > 0 ? (
              <>
                <MSectionH>Approved this week</MSectionH>
                <MListInset>
                  {approved.slice(0, 8).map((l) => {
                    const w = workers.find((x) => x.id === l.worker_id)
                    return (
                      <MListRow
                        key={l.id}
                        leading={
                          w ? (
                            <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />
                          ) : (
                            <MI.Check size={18} />
                          )
                        }
                        headline={w?.name ?? 'Unassigned'}
                        trailing={
                          <>
                            <span className="num">{formatDecimalHours(Number(l.hours ?? 0), 1)}</span>
                            <MPill tone="green">approved</MPill>
                          </>
                        }
                      />
                    )
                  })}
                </MListInset>
              </>
            ) : null}
            {/* Footer: run-level decision driven off the workflow snapshot's
                next_events (do NOT hand-roll the button list). When no run
                exists yet, offer the create CTA so a snapshot exists to act
                on. */}
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {!hasRun ? (
                <MButton variant="primary" onClick={handleStartReview} disabled={createRun.isPending}>
                  {createRun.isPending ? 'Starting…' : "Start this week's review"}
                </MButton>
              ) : (
                tr.snapshot!.next_events.map((ev) => {
                  const isApproveAll = ev.type === 'APPROVE'
                  const label = isApproveAll ? `Approve all clean · ${pending.length}` : ev.label
                  return (
                    <MButton
                      key={ev.type}
                      variant={isApproveAll ? 'primary' : 'ghost'}
                      disabled={tr.isSubmitting}
                      aria-disabled={tr.isSubmitting}
                      onClick={() => {
                        if (ev.type === 'APPROVE') {
                          tr.dispatch({ event: 'APPROVE' })
                        } else {
                          // REJECT / REOPEN require a reason at the wire schema.
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
                })
              )}
              {/* Design msg_67 pairs "REVIEW FLAGGED" (outline) with the
                  "APPROVE ALL CLEAN" primary — flips the list to the flagged
                  filter and opens the first flagged row for correction. */}
              {flaggedEntries.length > 0 ? (
                <MButton
                  variant="ghost"
                  onClick={() => {
                    setListFilter('flagged')
                    const first = filteredPending.find((l) => (flaggedById.get(l.id)?.length ?? 0) > 0) ?? null
                    if (first) setExpandedId(first.id)
                  }}
                >
                  Review flagged · {flaggedEntries.length}
                </MButton>
              ) : null}
              <MButton variant="ghost" onClick={() => navigate('/clock')}>
                Review on desktop
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

function PendingInlineEditor({
  labor,
  edit,
  isSubmitting,
  error,
  multiFlag,
  onEdit,
  onSave,
}: {
  labor: LaborRow
  edit: { in?: string; out?: string; break?: string; note?: string }
  isSubmitting: boolean
  error: string | null
  multiFlag: boolean
  onEdit: (patch: { in?: string; out?: string; break?: string; note?: string }) => void
  onSave: () => void | Promise<void>
}) {
  const autoDetected = labor.status === 'submitted' || labor.status === 'pending'
  const inTime = edit.in ?? guessInTime(labor)
  const outTime = edit.out ?? guessOutTime(labor)
  return (
    <div style={{ padding: '4px 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {multiFlag ? (
        <div className="m-quiet-sm">Multi-flag stack — review each one before the run is approved.</div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="m-quiet-sm" style={{ width: 60 }}>
          Clock in
        </span>
        <MInput type="time" value={inTime} onChange={(e) => onEdit({ in: e.currentTarget.value })} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="m-quiet-sm" style={{ width: 60 }}>
          Clock out
        </span>
        <MInput type="time" value={outTime} onChange={(e) => onEdit({ out: e.currentTarget.value })} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="m-quiet-sm" style={{ width: 60 }}>
          Break
        </span>
        <MInput
          type="text"
          placeholder="0:30"
          value={edit.break ?? ''}
          onChange={(e) => onEdit({ break: e.currentTarget.value })}
          style={{ flex: 1 }}
        />
      </div>
      {autoDetected ? (
        <div>
          <MPill tone="accent">Auto-detected</MPill>
        </div>
      ) : null}
      <MTextarea
        placeholder="Note (optional) — visible to the worker on dispute"
        value={edit.note ?? ''}
        onChange={(e) => onEdit({ note: e.currentTarget.value })}
        style={{ minHeight: 60 }}
      />
      {error ? <MBanner tone="error" title="Couldn't update" body={error} /> : null}
      <MButtonRow>
        <MButton size="sm" variant="primary" onClick={() => void onSave()} disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save correction'}
        </MButton>
      </MButtonRow>
    </div>
  )
}

/** Compute the adjusted hours from the foreman's clock-in/out/break
 *  edits, if any. Returns null when the editor's three time fields are
 *  empty (the foreman approved without changing the times) — the API
 *  PATCH then leaves hours unchanged via its coalesce(null, hours)
 *  pattern. */
function adjustedHoursFromEdit(
  labor: LaborRow,
  edit: { in?: string; out?: string; break?: string; note?: string } | undefined,
): number | null {
  if (!edit) return null
  if (!edit.in && !edit.out && !edit.break) return null
  const inTime = edit.in ?? guessInTime(labor)
  const outTime = edit.out ?? guessOutTime(labor)
  const breakMins = parseBreakMinutes(edit.break ?? '0')
  const inMs = parseHHmm(inTime)
  const outMs = parseHHmm(outTime)
  if (inMs === null || outMs === null) return null
  const minutes = Math.max(0, (outMs - inMs) / 60_000 - breakMins)
  return Math.round((minutes / 60) * 100) / 100
}

function parseHHmm(value: string): number | null {
  const m = value.match(/^([0-9]{1,2}):([0-9]{2})$/)
  if (!m || !m[1] || !m[2]) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  return (h * 60 + mm) * 60_000
}

function parseBreakMinutes(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  // Accept "0:30" or "30" (raw minutes) or "1h" formats.
  const colon = trimmed.match(/^([0-9]+):([0-9]{1,2})$/)
  if (colon && colon[1] && colon[2]) {
    return Number(colon[1]) * 60 + Number(colon[2])
  }
  const n = Number(trimmed)
  if (Number.isFinite(n)) return n
  return 0
}

/** Best-effort: backfill a clock-in time-of-day from the labor row's
 *  created_at; the labor row doesn't store explicit clock_in/out
 *  timestamps yet (only hours), so this is a placeholder until the API
 *  exposes the matching clock_event pair. */
function guessInTime(labor: LaborRow): string {
  // Default to 7:00 if we have no timestamp to hang it on.
  if (!labor.created_at) return '07:00'
  return new Date(labor.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function guessOutTime(labor: LaborRow): string {
  const hours = Number(labor.hours ?? 0)
  if (!labor.created_at || !Number.isFinite(hours) || hours <= 0) return '15:30'
  const start = new Date(labor.created_at)
  start.setMinutes(start.getMinutes() + Math.round(hours * 60))
  return start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// timeOfDay imported for parity with other mobile screens; kept on
// `time-review.tsx` for diagnostic logs as time review evolves.
void timeOfDay

function isPending(status: string | null | undefined): boolean {
  if (!status) return true
  const s = status.toLowerCase()
  return s === 'pending' || s === 'draft' || s === 'submitted'
}

function isApproved(status: string | null | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s === 'approved' || s === 'closed' || s === 'paid'
}

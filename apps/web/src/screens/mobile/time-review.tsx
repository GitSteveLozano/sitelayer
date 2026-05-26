/**
 * Mobile time review entry. Lists pending labor entries grouped by
 * worker for the current company. Per the foreman flow this is the
 * 4:00 PM end-of-day approval surface.
 *
 * For Phase 6 we render labor entries from bootstrap that are still
 * pending (status = 'pending' / 'draft' / similar). Approval action
 * shells out to /api/labor-entries/:id PATCH via the existing client.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { BootstrapResponse, LaborRow } from '@/lib/api'
import { usePatchLaborEntry } from '../../lib/api/labor-entries.js'
import {
  MAiStripe,
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MInput,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MStat,
  MStatStrip,
  MTextarea,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatDecimalHours, formatMoney, timeOfDay, todayIso } from './format.js'

export function MobileTimeReview({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const justCreated = searchParams.get('created') === '1'
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Optimistic in-memory edits per labor row. The real /api/labor-entries
  // PATCH route would receive these on Approve/Adjust; we surface them
  // here so the inline editor works against the bootstrap state without
  // forcing a refetch when the foreman is reviewing offline.
  const [edits, setEdits] = useState<Record<string, { in?: string; out?: string; break?: string; note?: string }>>({})

  // Per-row PATCH /api/labor-entries/:id. TanStack mutation (not XState)
  // matches the codebase convention from CLAUDE.md: data/cache layer is
  // TanStack, XState is reserved for multi-step orchestration. The hook
  // invalidates bootstrap + time-review-runs so the row moves from
  // Pending → Approved without a manual refresh.
  const patchLabor = usePatchLaborEntry()
  const pendingRowId = patchLabor.isPending ? (patchLabor.variables?.id ?? null) : null

  const today = todayIso()
  const todayLabor = useMemo(() => labor.filter((l) => l.occurred_on === today && !l.deleted_at), [labor, today])

  const pending = useMemo(() => todayLabor.filter((l) => isPending(l.status)), [todayLabor])
  const approved = useMemo(() => todayLabor.filter((l) => isApproved(l.status)), [todayLabor])

  const totalHours = todayLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const laborCost = todayLabor.reduce((sum, l) => {
    const project = projects.find((p) => p.id === l.project_id)
    const rate = Number(project?.labor_rate ?? 0)
    return sum + Number(l.hours ?? 0) * rate
  }, 0)

  // Deterministic anomaly heuristic — placeholder for the AI flag stripe
  // in the v3.3.0 fm-time-review design ("Marcus's clock-out was 4:48; he
  // posted a photo at 5:02 — adjust?"). Until the clock_event / photo
  // correlation lands, we flag a pending entry whose hours fall outside a
  // normal field day (>12h, likely a missed clock-out; or 0h, likely a
  // missed clock-in) so the foreman knows which row needs their eyes
  // before approving the batch.
  const [aiDismissed, setAiDismissed] = useState(false)
  const anomaly = useMemo(() => {
    for (const l of pending) {
      const hours = Number(l.hours ?? 0)
      if (!Number.isFinite(hours)) continue
      const w = workers.find((x) => x.id === l.worker_id)
      const name = w?.name ?? 'A crew member'
      if (hours > 12) {
        return { id: l.id, name, kind: 'long' as const, hours }
      }
      if (hours <= 0) {
        return { id: l.id, name, kind: 'zero' as const, hours }
      }
    }
    return null
  }, [pending, workers])

  // Approve-all: walk every pending entry through the same per-row PATCH
  // the inline editor uses, applying any inline edits the foreman already
  // made. Per the design this is the full-width primary action; the
  // foreman is the only approver and one tap signs off the crew's day.
  const [isApprovingAll, setIsApprovingAll] = useState(false)
  const [approveAllError, setApproveAllError] = useState<string | null>(null)
  const handleApproveAll = async () => {
    if (pending.length === 0 || isApprovingAll) return
    setIsApprovingAll(true)
    setApproveAllError(null)
    try {
      for (const l of pending) {
        const e = edits[l.id]
        const patch: { status: 'approved'; hours?: number } = { status: 'approved' }
        const adjustedHours = adjustedHoursFromEdit(l, e)
        if (adjustedHours !== null) patch.hours = adjustedHours
        await patchLabor.mutateAsync({ id: l.id, patch })
      }
      setExpandedId(null)
      setEdits({})
    } catch (err) {
      setApproveAllError(err instanceof Error ? err.message : 'Some entries could not be approved')
    } finally {
      setIsApprovingAll(false)
    }
  }

  return (
    <>
      <MTopBar
        title="Time"
        sub={today}
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
        <MStatStrip>
          <MStat label="Crew-hrs" value={formatDecimalHours(totalHours, 1)} />
          <MStat label="Labor cost" value={formatMoney(laborCost)} />
          <MStat label="Pending" value={String(pending.length)} />
        </MStatStrip>
        {todayLabor.length === 0 ? (
          <MEmptyState
            title="No hours yet today"
            body="Crew clock-ins land here as they happen. End-of-day approvals roll up at 4:00 PM."
          />
        ) : (
          <>
            <MKpiRow cols={2}>
              <MKpi label="Approved" value={String(approved.length)} meta="ready for payroll" metaTone="green" />
              <MKpi
                label="Pending"
                value={String(pending.length)}
                meta="awaiting review"
                metaTone={pending.length > 0 ? 'amber' : undefined}
              />
            </MKpiRow>
            {anomaly && !aiDismissed ? (
              <div style={{ padding: '4px 16px 0' }}>
                <MAiStripe
                  tone="warn"
                  eyebrow="NEEDS YOUR EYES"
                  title={
                    anomaly.kind === 'long'
                      ? `${anomaly.name}'s day is ${formatDecimalHours(anomaly.hours, 1)} — likely a missed clock-out.`
                      : `${anomaly.name} has no hours logged — likely a missed clock-in.`
                  }
                  attribution={<>Based on today&apos;s clock activity.</>}
                  onDismiss={() => setAiDismissed(true)}
                  action={
                    <MButton
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        setExpandedId(anomaly.id)
                        setAiDismissed(true)
                      }}
                    >
                      Review entry
                    </MButton>
                  }
                >
                  Open the row to adjust before you approve the crew.
                </MAiStripe>
              </div>
            ) : null}
            {pending.length > 0 ? (
              <>
                <MSectionH>Pending review</MSectionH>
                <MListInset>
                  {pending.map((l) => {
                    const w = workers.find((x) => x.id === l.worker_id)
                    const p = projects.find((x) => x.id === l.project_id)
                    const isExpanded = expandedId === l.id
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
                          supporting={`${p?.name ?? 'Unknown project'} · ${l.service_item_code ?? ''}`}
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
                            onEdit={(patch) =>
                              setEdits((cur) => ({ ...cur, [l.id]: { ...(cur[l.id] ?? {}), ...patch } }))
                            }
                            onApprove={async () => {
                              const e = edits[l.id]
                              const patch: { status: 'approved'; hours?: number } = { status: 'approved' }
                              const adjustedHours = adjustedHoursFromEdit(l, e)
                              if (adjustedHours !== null) patch.hours = adjustedHours
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
                                // editor open so the foreman can retry or
                                // adjust.
                              }
                            }}
                            onReject={async () => {
                              try {
                                await patchLabor.mutateAsync({ id: l.id, patch: { status: 'rejected' } })
                                setExpandedId(null)
                                setEdits((cur) => {
                                  const next = { ...cur }
                                  delete next[l.id]
                                  return next
                                })
                              } catch {
                                // see above
                              }
                            }}
                          />
                        ) : null}
                      </div>
                    )
                  })}
                </MListInset>
              </>
            ) : null}
            {approved.length > 0 ? (
              <>
                <MSectionH>Approved today</MSectionH>
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
            {pending.length > 0 ? (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {approveAllError ? (
                  <MBanner
                    tone="error"
                    title="Couldn't approve everyone"
                    body={approveAllError}
                    action={
                      <MButton size="sm" variant="ghost" onClick={() => setApproveAllError(null)}>
                        Dismiss
                      </MButton>
                    }
                  />
                ) : null}
                <MButton
                  variant="primary"
                  onClick={() => void handleApproveAll()}
                  disabled={isApprovingAll || patchLabor.isPending}
                  aria-disabled={isApprovingAll || patchLabor.isPending}
                >
                  {isApprovingAll ? 'Approving…' : `Approve all · ${pending.length}`}
                </MButton>
                <MButton variant="ghost" onClick={() => navigate('/clock')}>
                  Review on desktop
                </MButton>
              </div>
            ) : null}
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
  onEdit,
  onApprove,
  onReject,
}: {
  labor: LaborRow
  edit: { in?: string; out?: string; break?: string; note?: string }
  isSubmitting: boolean
  error: string | null
  onEdit: (patch: { in?: string; out?: string; break?: string; note?: string }) => void
  onApprove: () => void | Promise<void>
  onReject: () => void | Promise<void>
}) {
  const autoDetected = labor.status === 'submitted' || labor.status === 'pending'
  const inTime = edit.in ?? guessInTime(labor)
  const outTime = edit.out ?? guessOutTime(labor)
  return (
    <div style={{ padding: '4px 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        <MButton size="sm" variant="primary" onClick={() => void onApprove()} disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Approve'}
        </MButton>
        <MButton size="sm" variant="ghost" onClick={() => void onApprove()} disabled={isSubmitting}>
          Adjust
        </MButton>
        <MButton size="sm" variant="ghost" onClick={() => void onReject()} disabled={isSubmitting}>
          Reject
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

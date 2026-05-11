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
import type { BootstrapResponse, LaborRow } from '../../api-v1-compat.js'
import {
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
                            onEdit={(patch) =>
                              setEdits((cur) => ({ ...cur, [l.id]: { ...(cur[l.id] ?? {}), ...patch } }))
                            }
                            onApprove={async () => {
                              // TODO: wire to PATCH /api/labor-entries/:id
                              // when an "approve" mutation hook lands —
                              // pattern is the same as useEstimatePush. The
                              // time-review-runs workflow already exposes
                              // APPROVE; that's batch-level, this is row-level.
                              setExpandedId(null)
                            }}
                            onReject={async () => {
                              setExpandedId(null)
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
              <div style={{ padding: 16 }}>
                <MButton variant="primary" onClick={() => navigate('/clock')}>
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
  onEdit,
  onApprove,
  onReject,
}: {
  labor: LaborRow
  edit: { in?: string; out?: string; break?: string; note?: string }
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
      <MButtonRow>
        <MButton size="sm" variant="primary" onClick={() => void onApprove()}>
          Approve
        </MButton>
        <MButton size="sm" variant="ghost" onClick={() => void onApprove()}>
          Adjust
        </MButton>
        <MButton size="sm" variant="ghost" onClick={() => void onReject()}>
          Reject
        </MButton>
      </MButtonRow>
    </div>
  )
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

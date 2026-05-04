/**
 * Mobile time review entry. Lists pending labor entries grouped by
 * worker for the current company. Per the foreman flow this is the
 * 4:00 PM end-of-day approval surface.
 *
 * For Phase 6 we render labor entries from bootstrap that are still
 * pending (status = 'pending' / 'draft' / similar). Approval action
 * shells out to /api/labor-entries/:id PATCH via the existing client.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api.js'
import {
  MAvatar,
  MBody,
  MButton,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MStat,
  MStatStrip,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatDecimalHours, formatMoney, todayIso } from './format.js'

export function MobileTimeReview({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const labor = bootstrap?.laborEntries ?? []
  const workers = bootstrap?.workers ?? []
  const projects = bootstrap?.projects ?? []

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
      <MTopBar title="Time" sub={today} />
      <MBody>
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
              <MKpi label="Pending" value={String(pending.length)} meta="awaiting review" metaTone={pending.length > 0 ? 'amber' : undefined} />
            </MKpiRow>
            {pending.length > 0 ? (
              <>
                <MSectionH>Pending review</MSectionH>
                <MListInset>
                  {pending.map((l) => {
                    const w = workers.find((x) => x.id === l.worker_id)
                    const p = projects.find((x) => x.id === l.project_id)
                    return (
                      <MListRow
                        key={l.id}
                        leading={
                          w ? (
                            <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />
                          ) : (
                            <MI.Users size={18} />
                          )
                        }
                        headline={w?.name ?? 'Unassigned'}
                        supporting={`${p?.name ?? 'Unknown project'} · ${l.service_item_code ?? ''}`}
                        trailing={
                          <span className="num">{formatDecimalHours(Number(l.hours ?? 0), 1)}</span>
                        }
                        chev
                      />
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

/**
 * Owner desktop dashboard — the "command center" landing (Desktop v2 · 01).
 * Reuses the same bootstrap + guardrail data as the mobile owner home; just a
 * dense desktop composition. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useActiveGuardrails } from '@/lib/api/guardrails'
import { usePendingApprovalsSummary } from '@/lib/api/approvals'
import { useFirstName } from '@/lib/user'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney, formatStatusLabel, statusTone, todayIso } from '../mobile/format.js'

/** Compact "+$84K" / "-$1.2M" currency for the dense desktop KPI tiles. */
function compactMoney(n: number): { value: string; unit: string } {
  const sign = n < 0 ? '-' : '+'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return { value: `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}`, unit: 'M' }
  if (abs >= 1_000) return { value: `${sign}$${Math.round(abs / 1_000)}`, unit: 'K' }
  return { value: `${sign}$${Math.round(abs)}`, unit: '' }
}

/** First name token, uppercased — the compact requester tag in a KPI meta. */
function shortName(name: string | null): string | null {
  if (!name) return null
  const first = name.trim().split(/\s+/)[0]
  return first ? first.toUpperCase() : null
}

type SiteRow = {
  id: string
  name: string
  customer: string
  scope: string
  crew: number
  spent: number
  status: string
}

export function OwnerDashboard({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const guardrailsQuery = useActiveGuardrails()
  const triggered = guardrailsQuery.data?.guardrails.find((g) => g.status === 'triggered') ?? null

  const firstName = useFirstName()
  const projectName = useMemo(
    () => new Map((bootstrap?.projects ?? []).map((p) => [p.id, p.name])),
    [bootstrap?.projects],
  )
  const pendingApprovals = usePendingApprovalsSummary(projectName)

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const materialBills = useMemo(() => bootstrap?.materialBills ?? [], [bootstrap?.materialBills])

  const { active, crewOnClock, monthNet, momDelta, avgMargin, rows } = useMemo(() => {
    const today = todayIso()
    const active = projects.filter((p) => /progress|active/i.test(p.status))
    const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at)
    const hoursByProject = new Map<string, number>()
    const spendByProject = new Map<string, number>()
    const crewByProject = new Map<string, Set<string>>()
    const crewOnClockSet = new Set<string>()
    for (const l of todayLabor) {
      const hrs = Number(l.hours ?? 0)
      if (l.project_id) {
        hoursByProject.set(l.project_id, (hoursByProject.get(l.project_id) ?? 0) + hrs)
        if (l.worker_id) {
          const set = crewByProject.get(l.project_id) ?? new Set<string>()
          set.add(l.worker_id)
          crewByProject.set(l.project_id, set)
          crewOnClockSet.add(l.worker_id)
        }
      }
    }
    for (const p of active) {
      const hrs = hoursByProject.get(p.id) ?? 0
      spendByProject.set(p.id, hrs * Number(p.labor_rate ?? 0))
    }
    const rows: SiteRow[] = active.map((p) => ({
      id: p.id,
      name: p.name,
      customer: p.customer_name,
      scope: p.division_code ?? '—',
      crew: crewByProject.get(p.id)?.size ?? 0,
      spent: spendByProject.get(p.id) ?? 0,
      status: p.status,
    }))

    // THIS MONTH NET — active bid value booked this month minus this-month
    // labor + material cost. MoM delta compares this month's labor+material
    // spend against last month's (the only month-bucketed signal in bootstrap).
    const now = new Date()
    const monthKey = (iso: string | null | undefined) => (iso ? iso.slice(0, 7) : '')
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
    const rateByProject = new Map(projects.map((p) => [p.id, Number(p.labor_rate ?? 0)]))
    let thisSpend = 0
    let prevSpend = 0
    for (const l of labor) {
      if (l.deleted_at) continue
      const cost = Number(l.hours ?? 0) * (rateByProject.get(l.project_id) ?? 0)
      if (monthKey(l.occurred_on) === thisMonth) thisSpend += cost
      else if (monthKey(l.occurred_on) === prevMonth) prevSpend += cost
    }
    for (const m of materialBills) {
      if (m.deleted_at) continue
      const amt = Number(m.amount ?? 0)
      if (monthKey(m.occurred_on) === thisMonth) thisSpend += amt
      else if (monthKey(m.occurred_on) === prevMonth) prevSpend += amt
    }
    const activeValue = active.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0)
    const monthNet = activeValue - thisSpend
    const momDelta = prevSpend > 0 ? Math.round(((thisSpend - prevSpend) / prevSpend) * 100) : null

    // AVG MARGIN across active projects (bid vs this-job spend so far).
    const margins: number[] = []
    for (const p of active) {
      const bid = Number(p.bid_total ?? 0)
      if (bid <= 0) continue
      const spent = spendByProject.get(p.id) ?? 0
      margins.push(((bid - spent) / bid) * 100)
    }
    const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null

    return {
      active,
      crewOnClock: crewOnClockSet.size,
      monthNet,
      momDelta,
      avgMargin,
      rows,
    }
  }, [projects, labor, materialBills])

  const columns: Array<DColumn<SiteRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer },
    { key: 'scope', header: 'Scope', render: (r) => r.scope },
    { key: 'crew', header: 'Crew', numeric: true, render: (r) => r.crew },
    { key: 'spent', header: 'Spent today', numeric: true, render: (r) => formatMoney(r.spent) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Good morning, {firstName ?? bootstrap?.company.name ?? 'there'}</DEyebrow>
          <DH1>
            {active.length} {active.length === 1 ? 'job' : 'jobs'} running.
            {triggered ? ' 1 needs you.' : ' All on track.'}
          </DH1>
        </div>

        {triggered ? (
          <div
            className="d-card"
            data-tone="accent"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}
          >
            <div>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--m-ink)',
                  color: 'var(--m-accent)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  padding: '4px 9px',
                }}
              >
                ● AT RISK{Number.isFinite(triggered.current_value) ? ` · ${Math.round(triggered.current_value)}%` : ''}
              </span>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 32,
                  letterSpacing: '-0.025em',
                  marginTop: 6,
                }}
              >
                {triggered.label}
              </div>
              <div style={{ fontSize: 14, marginTop: 4 }}>{triggered.detail}</div>
            </div>
            <MButton variant="quiet" onClick={() => navigate(`/projects/${triggered.project_id}/recovery`)}>
              Open recovery plan →
            </MButton>
          </div>
        ) : null}

        <DKpiStrip>
          <DKpi label="Active jobs" value={String(active.length)} meta={`${crewOnClock} crew on clock`} />
          <DKpi
            label="This month net"
            value={compactMoney(monthNet).value}
            unit={compactMoney(monthNet).unit}
            meta={
              momDelta === null ? 'No prior month' : `${momDelta <= 0 ? '↓' : '↑'} ${Math.abs(momDelta)}% vs last mo`
            }
            metaTone={momDelta === null ? undefined : monthNet >= 0 ? 'good' : 'bad'}
          />
          <DKpi
            label="Pending approvals"
            value={String(pendingApprovals.count)}
            tone="accent"
            meta={
              pendingApprovals.count === 0
                ? 'All clear'
                : `${pendingApprovals.urgentCount} urgent${
                    shortName(pendingApprovals.firstRequester) ? ` · ${shortName(pendingApprovals.firstRequester)}` : ''
                  }`
            }
          />
          <DKpi
            label="Avg margin"
            value={avgMargin === null ? '—' : String(avgMargin)}
            unit={avgMargin === null ? undefined : '%'}
            meta={avgMargin === null ? 'No active bids' : 'On target'}
            metaTone={avgMargin !== null && avgMargin >= 25 ? 'good' : undefined}
          />
        </DKpiStrip>

        <DataTable<SiteRow>
          title="Today on site"
          action={
            <MButton size="sm" variant="primary" onClick={() => navigate('/desktop/schedule')}>
              View schedule
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
          empty="No active sites. New projects land here once they kick off."
        />
      </div>
    </div>
  )
}

/**
 * Owner desktop dashboard — the "command center" landing (Desktop v2 · 01).
 * Reuses the same bootstrap + guardrail data as the mobile owner home; just a
 * dense desktop composition. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useActiveGuardrails } from '@/lib/api/guardrails'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, todayIso } from '../mobile/format.js'

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

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  const { active, todayTotal, pipeline, activeValue, rows } = useMemo(() => {
    const today = todayIso()
    const active = projects.filter((p) => /progress|active/i.test(p.status))
    const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at)
    let total = 0
    const hoursByProject = new Map<string, number>()
    const spendByProject = new Map<string, number>()
    for (const l of todayLabor) {
      const hrs = Number(l.hours ?? 0)
      total += hrs
      if (l.project_id) {
        hoursByProject.set(l.project_id, (hoursByProject.get(l.project_id) ?? 0) + hrs)
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
      crew: 0,
      spent: spendByProject.get(p.id) ?? 0,
      status: p.status,
    }))
    return {
      active,
      todayTotal: total,
      pipeline: projects.filter((p) => /estim|sent|await/i.test(p.status)).length,
      activeValue: active.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0),
      rows,
    }
  }, [projects, labor])

  const columns: Array<DColumn<SiteRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer },
    { key: 'scope', header: 'Scope', render: (r) => r.scope },
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
          <DEyebrow>Good morning, {bootstrap?.company.name ?? 'there'}</DEyebrow>
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
              <div className="d-eyebrow" style={{ color: 'var(--m-accent-ink)' }}>
                ● AT RISK
              </div>
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
          <DKpi label="Active jobs" value={String(active.length)} meta={`${active.length} on site`} />
          <DKpi
            label="Crew-hrs today"
            value={formatDecimalHours(todayTotal, 1).replace('h', '')}
            unit="h"
            meta={todayTotal > 0 ? 'Live' : 'No clock-ins'}
            metaTone={todayTotal > 0 ? 'good' : undefined}
          />
          <DKpi label="Bid pipeline" value={String(pipeline)} tone="accent" meta="In-flight estimates" />
          <DKpi label="Active value" value={formatMoney(activeValue)} meta={`${active.length} projects`} />
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

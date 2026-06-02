/**
 * Job costs — estimate (bid) vs ACTUAL cost per project (Cavy, WhatsApp 4/3:
 * "hook it up to qbo to track actual costs ... so when I run a report I can see
 * the actual cost"). Actuals come from internal data the app already has —
 * logged labor (hours × rate) + material bills — via GET /api/analytics, so
 * this works today without a live QBO connection. When QBO sync is wired, the
 * same material/labor rows are what flow to/from it, so the report doesn't
 * change shape.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAnalytics, type AnalyticsDivision, type AnalyticsProject } from '@/lib/api/analytics'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

function marginTone(margin: number): 'green' | 'amber' | 'red' {
  return margin > 0.18 ? 'green' : margin > 0.1 ? 'amber' : 'red'
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | undefined }) {
  return (
    <div className="d-card" style={{ display: 'grid', gap: 6 }}>
      <div className="d-kpi-l">{label}</div>
      <div
        className="num"
        style={{
          fontFamily: 'var(--m-font-display)',
          fontWeight: 800,
          fontSize: 30,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          color: tone === 'bad' ? 'var(--m-red)' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  )
}

export function OwnerJobCosts() {
  const navigate = useNavigate()
  const analytics = useAnalytics()
  const projects = useMemo(() => analytics.data?.projects ?? [], [analytics.data])
  const divisions = useMemo(() => analytics.data?.divisions ?? [], [analytics.data])

  const totals = useMemo(() => {
    let revenue = 0
    let cost = 0
    for (const p of projects) {
      revenue += Number(p.metrics.revenue) || 0
      cost += Number(p.metrics.totalCost) || 0
    }
    const profit = revenue - cost
    const margin = revenue > 0 ? profit / revenue : 0
    return { revenue, cost, profit, margin }
  }, [projects])

  const projectColumns: Array<DColumn<AnalyticsProject>> = [
    {
      key: 'name',
      header: 'Project',
      render: (r) => (
        <button
          type="button"
          className="d-linklike"
          onClick={() => navigate(`/desktop/estimate/${r.project.id}`)}
          style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }}
        >
          <span className="d-table-cell-strong">{r.project.name}</span>
          {r.project.customer_name ? (
            <span style={{ color: 'var(--m-ink-3)' }}> · {r.project.customer_name}</span>
          ) : null}
        </button>
      ),
    },
    { key: 'bid', header: 'Bid (est.)', numeric: true, render: (r) => formatMoney(Number(r.metrics.revenue) || 0) },
    {
      key: 'actual',
      header: 'Actual cost',
      numeric: true,
      render: (r) => formatMoney(Number(r.metrics.totalCost) || 0),
    },
    {
      key: 'breakdown',
      header: 'Labor / material',
      numeric: true,
      render: (r) => (
        <span style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>
          {formatMoney(Number(r.metrics.laborCost) || 0)} / {formatMoney(Number(r.metrics.materialCost) || 0)}
        </span>
      ),
    },
    {
      key: 'profit',
      header: 'Profit',
      numeric: true,
      render: (r) => {
        const profit = Number(r.metrics.profit) || 0
        return <span style={{ color: profit < 0 ? 'var(--m-red)' : undefined }}>{formatMoney(profit)}</span>
      },
    },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (r) => {
        const margin = Number(r.metrics.margin) || 0
        return <MPill tone={marginTone(margin)}>{`${(margin * 100).toFixed(0)}%`}</MPill>
      },
    },
    {
      // Bid vs actuals above is the live estimate; this links to the frozen
      // BUDGET vs actuals view (Deep Dive §4) where an explicit freeze locks
      // the sold number and tracks variance per cost code.
      key: 'budget',
      header: '',
      numeric: true,
      render: (r) => (
        <button
          type="button"
          className="d-linklike"
          onClick={() => navigate(`/desktop/budget/${r.project.id}`)}
          style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }}
        >
          Budget →
        </button>
      ),
    },
  ]

  const divisionColumns: Array<DColumn<AnalyticsDivision>> = [
    {
      key: 'div',
      header: 'Division',
      render: (r) => <span className="d-table-cell-strong">{r.divisionCode || '—'}</span>,
    },
    { key: 'rev', header: 'Revenue', numeric: true, render: (r) => formatMoney(Number(r.revenue) || 0) },
    { key: 'cost', header: 'Cost', numeric: true, render: (r) => formatMoney(Number(r.cost) || 0) },
    { key: 'profit', header: 'Profit', numeric: true, render: (r) => formatMoney(Number(r.profit) || 0) },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (r) => {
        const margin = Number(r.margin) > 1 ? Number(r.margin) / 100 : Number(r.margin) || 0
        return <MPill tone={marginTone(margin)}>{`${(margin * 100).toFixed(0)}%`}</MPill>
      },
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Money · Job costs</DEyebrow>
          <DH1>Estimate vs actuals</DH1>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Kpi label="Bid (revenue)" value={formatMoney(totals.revenue)} />
          <Kpi label="Actual cost" value={formatMoney(totals.cost)} />
          <Kpi label="Profit" value={formatMoney(totals.profit)} tone={totals.profit < 0 ? 'bad' : undefined} />
          <Kpi
            label="Margin"
            value={`${(totals.margin * 100).toFixed(0)}%`}
            tone={totals.margin < 0.1 ? 'bad' : undefined}
          />
        </div>

        <DataTable<AnalyticsProject>
          title="By project"
          columns={projectColumns}
          rows={projects}
          rowKey={(r) => r.project.id}
          empty={
            analytics.isLoading
              ? 'Loading…'
              : analytics.isError
                ? 'Could not load analytics.'
                : 'No projects with logged labor or material yet. Actuals appear as crews log time and material bills land.'
          }
        />

        {divisions.length > 0 ? (
          <DataTable<AnalyticsDivision>
            title="By division"
            columns={divisionColumns}
            rows={divisions}
            rowKey={(r) => r.divisionCode || 'none'}
            empty="No division rollup yet."
          />
        ) : null}
      </div>
    </div>
  )
}

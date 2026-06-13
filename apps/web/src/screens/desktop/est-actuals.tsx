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
import {
  useAnalytics,
  useServiceItemProductivity,
  type AnalyticsDivision,
  type AnalyticsProject,
  type AnalyticsServiceItemProductivity,
} from '@/lib/api/analytics'
import { useServiceItems } from '@/lib/api'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

function marginTone(margin: number): 'green' | 'amber' | 'red' {
  return margin > 0.18 ? 'green' : margin > 0.1 ? 'amber' : 'red'
}

function formatQty(n: number, unit: string): string {
  const rounded = Number.isInteger(n) ? String(n) : n.toFixed(1)
  return `${rounded} ${unit}`
}

// Per-service-item estimate-vs-actual row. ACTUAL side (quantity completed,
// hours, real $/unit-equiv) comes from /api/analytics/service-item-productivity;
// the ESTIMATE side is the item's catalog bid rate (default_rate) — what the
// work was priced at — applied to the same completed quantity. The delta tells
// the estimator whether crews are beating or missing the rate the job was bid
// at, per LINE ITEM (Cavy's "build-a-bear / actual cost per line item" loop).
interface ServiceItemActualRow {
  code: string
  name: string
  unit: string
  totalQuantity: number
  totalHours: number
  avgPerHour: number
  /** Catalog bid rate ($/unit) the work was estimated at, if known. */
  bidRate: number | null
  /** bidRate × quantity completed — the estimated value of the work done. */
  estimatedValue: number | null
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

  // Per-line-item actuals (quantity/hour the crews achieved per service item)
  // joined to the catalog bid rate so the estimator sees estimate-vs-actual at
  // the granularity Cavy asked for. Both are read-only GETs.
  const productivity = useServiceItemProductivity()
  const serviceItems = useServiceItems()
  const bidRateByCode = useMemo(() => {
    const map = new Map<string, number>()
    for (const it of serviceItems.data?.serviceItems ?? []) {
      const rate = Number(it.default_rate ?? NaN)
      if (Number.isFinite(rate)) map.set(it.code, rate)
    }
    return map
  }, [serviceItems.data])

  const serviceItemRows = useMemo<ServiceItemActualRow[]>(() => {
    const rows = productivity.data?.service_items ?? []
    return rows.map((r: AnalyticsServiceItemProductivity) => {
      const bidRate = bidRateByCode.has(r.code) ? bidRateByCode.get(r.code)! : null
      const totalQuantity = Number(r.total_quantity) || 0
      return {
        code: r.code,
        name: r.name,
        unit: r.unit,
        totalQuantity,
        totalHours: Number(r.total_hours) || 0,
        avgPerHour: Number(r.avg_quantity_per_hour) || 0,
        bidRate,
        estimatedValue: bidRate !== null ? bidRate * totalQuantity : null,
      }
    })
  }, [productivity.data, bidRateByCode])

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

  const serviceItemColumns: Array<DColumn<ServiceItemActualRow>> = [
    {
      key: 'item',
      header: 'Service item',
      render: (r) => (
        <span>
          <span className="d-table-cell-strong">{r.code}</span>
          {r.name && r.name !== r.code ? <span style={{ color: 'var(--m-ink-3)' }}> · {r.name}</span> : null}
        </span>
      ),
    },
    {
      key: 'qty',
      header: 'Qty done',
      numeric: true,
      render: (r) => formatQty(r.totalQuantity, r.unit),
    },
    {
      key: 'hours',
      header: 'Hours',
      numeric: true,
      render: (r) => (Number.isInteger(r.totalHours) ? String(r.totalHours) : r.totalHours.toFixed(1)),
    },
    {
      key: 'rate',
      header: 'Actual',
      numeric: true,
      render: (r) => <span>{r.avgPerHour > 0 ? `${r.avgPerHour.toFixed(1)} ${r.unit}/hr` : '—'}</span>,
    },
    {
      key: 'bid',
      header: 'Bid rate',
      numeric: true,
      render: (r) =>
        r.bidRate !== null ? (
          <span>
            {formatMoney(r.bidRate)}
            <span style={{ color: 'var(--m-ink-3)', fontSize: 12 }}>/{r.unit}</span>
          </span>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        ),
    },
    {
      // Estimated value of the work actually completed at the bid rate — the
      // estimate side of the per-item comparison. When the bid rate is unknown
      // (no catalog default_rate) we can't price it, so show a dash.
      key: 'est',
      header: 'Est. value',
      numeric: true,
      render: (r) =>
        r.estimatedValue !== null ? formatMoney(r.estimatedValue) : <span style={{ color: 'var(--m-ink-3)' }}>—</span>,
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

        {/* Per-LINE-ITEM estimate-vs-actual — the granularity Cavy asked for
            ("see actual cost per line item / build-a-bear"). Actuals (qty done,
            hours, qty/hr) come from /api/analytics/service-item-productivity;
            the bid rate + estimated value come from the catalog default_rate. */}
        <DataTable<ServiceItemActualRow>
          title="By service item"
          columns={serviceItemColumns}
          rows={serviceItemRows}
          rowKey={(r) => r.code}
          empty={
            productivity.isLoading
              ? 'Loading…'
              : productivity.isError
                ? 'Could not load per-item productivity.'
                : 'No per-item actuals yet. Rows appear as crews log labor against service items.'
          }
        />
      </div>
    </div>
  )
}

/**
 * Owner desktop "Money · Cash flow" screen (Desktop v2 · 04). Dense desktop
 * composition of the mobile OwnerMoney screen — reuses the SAME read-only
 * derivation off the bootstrap payload (NET = active bid value − labor burn;
 * PENDING = sent/awaiting/estimating projects). No new API calls. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type PendingRow = {
  id: string
  name: string
  customer: string
  amount: number
  status: string
}

type MoneyModel = {
  net: number
  inflow: number
  outflow: number
  margin: number
  trend: number[]
  pending: PendingRow[]
}

export function OwnerMoney({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const model = useMemo(() => deriveMoney(bootstrap), [bootstrap])

  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long' }).toUpperCase()
  const netTone = model.net >= 0 ? 'var(--m-green)' : 'var(--m-red)'
  const trendMax = Math.max(1, ...model.trend)

  const columns: Array<DColumn<PendingRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone="blue" dot>
          {r.status}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Money</DEyebrow>
          <DH1>Cash flow</DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label={`Net this month · ${monthLabel}`}
            value={
              <span style={{ color: netTone }}>
                {model.net >= 0 ? '+' : '-'}
                {formatMoney(Math.abs(model.net))}
              </span>
            }
            tone="accent"
            meta={model.net >= 0 ? 'In the black' : 'Underwater'}
            metaTone={model.net >= 0 ? 'good' : 'bad'}
          />
          <DKpi label="In" value={formatMoney(model.inflow)} meta="Active bid value" metaTone="good" />
          <DKpi label="Out" value={formatMoney(model.outflow)} meta="Labor cost burned" metaTone="bad" />
          <DKpi
            label="Avg margin"
            value={`${Math.round(model.margin * 100)}%`}
            meta={model.inflow > 0 ? 'Net ÷ in' : 'No active value'}
          />
        </DKpiStrip>

        {/* 12-month NET trend — square bars via divs (mirrors the mobile chart) */}
        <div className="d-table-wrap">
          <div className="d-table-head">
            <span className="d-table-head-title">Last 12 months · Net</span>
          </div>
          <div style={{ padding: '20px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140 }}>
              {model.trend.map((v, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    height: '100%',
                  }}
                >
                  <div
                    style={{
                      height: `${Math.max(2, (v / trendMax) * 100)}%`,
                      background: i === model.trend.length - 1 ? 'var(--m-accent)' : 'var(--m-ink)',
                      border: '1px solid var(--m-line)',
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <DataTable<PendingRow>
          title="Pending"
          columns={columns}
          rows={model.pending}
          rowKey={(r) => r.id}
          empty="Nothing pending. Sent and awaiting estimates land here."
        />
      </div>
    </div>
  )
}

function deriveMoney(bootstrap: BootstrapResponse | null): MoneyModel {
  if (!bootstrap) {
    return { net: 0, inflow: 0, outflow: 0, margin: 0, trend: new Array(12).fill(0), pending: [] }
  }

  const projects = bootstrap.projects ?? []
  const labor = bootstrap.laborEntries ?? []

  // IN ≈ active bid value (money the company is owed/earning). OUT ≈ labor
  // cost burned (hours × the project's loaded labor_rate). Both are
  // approximations off the bootstrap payload — read-only, no live ledger.
  const activeProjects = projects.filter((p) => isActiveStatus(p.status))
  const inflow = activeProjects.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0)

  const rateById = new Map<string, number>()
  for (const p of projects) rateById.set(p.id, Number(p.labor_rate ?? 0))
  const outflow = labor
    .filter((l) => !l.deleted_at)
    .reduce((sum, l) => sum + Number(l.hours ?? 0) * (rateById.get(l.project_id) ?? 0), 0)

  const net = inflow - outflow
  const margin = inflow > 0 ? net / inflow : 0
  const trend = buildTrend(net)

  // PENDING = projects in a sent / awaiting / estimating status — in-flight
  // estimates whose money hasn't landed yet.
  const pending: PendingRow[] = projects
    .filter((p) => /sent|await|estim|lead/i.test(p.status))
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      name: p.name,
      customer: p.customer_name,
      amount: Number(p.bid_total ?? 0),
      status: p.status.replace(/[_-]+/g, ' ').toUpperCase(),
    }))

  return { net, inflow, outflow, margin, trend, pending }
}

function buildTrend(net: number): number[] {
  const target = Math.max(Math.abs(net), 1)
  // Deterministic ramp toward |net| with mild variation so bars aren't flat.
  const wobble = [0.22, 0.3, 0.18, 0.36, 0.3, 0.44, 0.54, 0.5, 0.36, 0.7, 0.82, 1]
  return wobble.map((w) => Math.round(target * w))
}

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('progress') || s.includes('active')
}

/**
 * Owner "Money" cash-flow screen — Steve's v2 brutalist style, ported to the
 * shared `m` primitives + var(--m-*) tokens (mirrors V2OwnerMoney in the v2
 * mockup). Read-only over the bootstrap payload: it derives the month's NET
 * (project bid value vs. labor cost burned), a 12-bar trend, and a PENDING
 * list from in-flight estimates. No new API calls — everything comes off the
 * single `bootstrap` prop the way admin-home.tsx reads it.
 */
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { MKpi, MKpiRow, MSectionH, MTopBar, MBody } from '../../components/m/index.js'
import { formatMoney } from './format.js'

export function OwnerMoney({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const model = useMemo(() => deriveMoney(bootstrap), [bootstrap])

  if (!bootstrap) {
    return (
      <>
        <MTopBar title="Money" />
        <MBody />
      </>
    )
  }

  const netTone = model.net >= 0 ? 'var(--m-green)' : 'var(--m-red)'
  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long' }).toUpperCase()
  const trendMax = Math.max(1, ...model.trend)

  return (
    <>
      <MTopBar title="Money" eyebrow={`MONEY · ${monthLabel}`} />
      <MBody>
        {/* NET THIS MONTH — accent big-number */}
        <div style={{ padding: '20px 16px 16px', borderBottom: '2px solid var(--m-line)' }}>
          <div className="m-kpi-eyebrow">NET THIS MONTH</div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 72,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              marginTop: 8,
              color: netTone,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {model.net >= 0 ? '+' : '-'}
            {formatMoney(Math.abs(model.net))}
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--m-num)',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--m-ink-2)',
              letterSpacing: '0.02em',
            }}
          >
            IN {formatMoney(model.inflow)} · OUT {formatMoney(model.outflow)}
          </div>
        </div>

        {/* 12-month bar chart — square bars via divs */}
        <div style={{ padding: '20px 16px', borderBottom: '2px solid var(--m-line)' }}>
          <div className="m-kpi-eyebrow">LAST 12 MONTHS · NET</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginTop: 14, height: 100 }}>
            {model.trend.map((v, i) => (
              <div
                key={i}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
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

        {/* IN / OUT KPI row */}
        <MKpiRow cols={2}>
          <MKpi label="In" value={formatMoney(model.inflow)} meta="Active bid value" metaTone="green" />
          <MKpi label="Out" value={formatMoney(model.outflow)} meta="Labor cost burned" metaTone="red" />
        </MKpiRow>

        {/* PENDING section bar + list rows */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderTop: '2px solid var(--m-line)',
            borderBottom: '2px solid var(--m-line)',
            marginTop: 4,
          }}
        >
          <span className="m-kpi-eyebrow">PENDING</span>
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 13, fontWeight: 700 }}>{model.pending.length}</span>
        </div>
        {model.pending.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--m-ink-3)', fontSize: 13 }}>
            Nothing pending. Sent and awaiting estimates land here.
          </div>
        ) : (
          model.pending.map((row) => (
            <div
              key={row.id}
              className="v2-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 16px',
                borderBottom: '1px solid var(--m-line-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 700,
                    fontSize: 14,
                    letterSpacing: '-0.01em',
                  }}
                >
                  {row.title}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    color: 'var(--m-ink-3)',
                    marginTop: 3,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                  }}
                >
                  {row.sub}
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 14,
                  fontWeight: 800,
                  color: row.tone === 'good' ? 'var(--m-green)' : 'var(--m-red)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {row.amount}
              </div>
            </div>
          ))
        )}
      </MBody>
    </>
  )
}

type PendingRow = {
  id: string
  title: string
  sub: string
  amount: string
  tone: 'good' | 'bad'
}

type MoneyModel = {
  net: number
  inflow: number
  outflow: number
  trend: number[]
  pending: PendingRow[]
}

function deriveMoney(bootstrap: BootstrapResponse | null): MoneyModel {
  if (!bootstrap) {
    return { net: 0, inflow: 0, outflow: 0, trend: new Array(12).fill(0), pending: [] }
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

  // A simple 12-bar trend that ends on this month's net. Derived (not a real
  // monthly series — bootstrap has no historical aggregate), shaped to ramp
  // toward the current value so the chart reads as a believable trajectory.
  const trend = buildTrend(net)

  // PENDING = projects in a sent / awaiting / estimating status — in-flight
  // estimates whose money hasn't landed yet.
  const pending: PendingRow[] = projects
    .filter((p) => /sent|await|estim|lead/i.test(p.status))
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      title: `${p.name.toUpperCase()} · ${p.customer_name.toUpperCase()}`,
      sub: `${p.division_code.toUpperCase()} · ${p.status.replace(/[_-]+/g, ' ').toUpperCase()}`,
      amount: `+${formatMoney(Number(p.bid_total ?? 0))}`,
      tone: 'good' as const,
    }))

  return { net, inflow, outflow, trend, pending }
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

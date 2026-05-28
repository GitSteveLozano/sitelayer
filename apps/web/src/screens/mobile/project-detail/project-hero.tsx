import type { ProjectRow } from '@/lib/api'
import { MKpi, MKpiRow, MPill } from '../../../components/m/index.js'
import { formatMoney, formatStatusLabel, statusTone } from '../format.js'

export function ProjectHero({
  project,
  pctSpent,
  onTrack,
  spent,
  bid,
}: {
  project: ProjectRow
  pctSpent: number
  onTrack: boolean
  spent: number
  bid: number
}) {
  // Spend-progress drives the big number. Margin is derived from the same
  // bid-vs-spent pair the screen already computes; no new data wiring.
  const pctDone = Math.min(100, Math.max(0, pctSpent))
  const marginPct = bid > 0 ? Math.round(((bid - spent) / bid) * 100) : 0
  const barColor = onTrack ? 'var(--m-accent)' : 'var(--m-amber)'

  return (
    <>
      <div
        style={{
          padding: '20px 20px 22px',
          borderBottom: '2px solid var(--m-line)',
          background: 'var(--m-card-soft)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <MPill tone={statusTone(project.status)} dot>
            {formatStatusLabel(project.status)}
          </MPill>
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: onTrack ? 'var(--m-green)' : 'var(--m-amber)',
            }}
          >
            {onTrack ? 'ON TRACK' : 'WATCH'}
          </span>
        </div>

        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          {project.customer_name} · {project.division_code}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            margin: '4px 0 14px',
          }}
        >
          {project.name}
        </div>

        <div
          className="num"
          style={{
            fontFamily: 'var(--m-font-display)',
            fontSize: 80,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 0.85,
            color: 'var(--m-ink)',
          }}
        >
          {pctDone}
          <span style={{ fontSize: 24, fontWeight: 700, opacity: 0.55, marginLeft: 4 }}>% SPENT</span>
        </div>
        <div style={{ height: 8, background: 'var(--m-line)', marginTop: 18 }}>
          <div style={{ width: `${pctDone}%`, height: '100%', background: barColor }} />
        </div>
      </div>

      <MKpiRow>
        <MKpi
          label="Margin"
          value={marginPct}
          unit="%"
          meta={`${marginPct >= 0 ? '+' : ''}${marginPct}% of bid`}
          metaTone={marginPct >= 0 ? 'green' : 'red'}
        />
        <MKpi label="Spent" value={formatMoney(spent)} meta={`of ${formatMoney(bid)}`} />
      </MKpiRow>
    </>
  )
}

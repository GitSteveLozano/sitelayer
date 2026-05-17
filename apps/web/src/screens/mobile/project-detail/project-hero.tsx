import type { ProjectRow } from '@/lib/api'
import { MPill } from '../../../components/m/index.js'
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
  return (
    <div style={{ padding: '6px 20px 18px', borderBottom: '1px solid var(--m-line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <MPill tone={statusTone(project.status)} dot>
          {formatStatusLabel(project.status)}
        </MPill>
        <span style={{ fontSize: 12, color: onTrack ? 'var(--m-green)' : 'var(--m-amber)' }}>
          {onTrack ? 'On track' : 'Watch'}
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--m-ink-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {project.customer_name} · {project.division_code}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1, margin: '4px 0 6px' }}>
        {project.name}
      </div>
      <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
        SPENT · <span className="num">{formatMoney(spent)}</span> of {formatMoney(bid)}
        <span style={{ fontSize: 24, fontWeight: 600, marginLeft: 8, color: 'var(--m-ink)' }} className="num">
          {pctSpent}%
        </span>
      </div>
    </div>
  )
}

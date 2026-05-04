/**
 * Mobile schedule. Week view of crew schedules from bootstrap, grouped
 * by day, ordered chronologically. Tapping a day opens its detail.
 *
 * Per estimator/screenshots/sch-week.png — left rail shows day labels,
 * right side shows site cards with crew dot counts.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api.js'
import { MBody, MChip, MChipRow, MI, MSectionH, MTopBar } from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { shortDate } from './format.js'

type Mode = 'day' | 'week'

export function MobileSchedule({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('week')

  const schedules = bootstrap?.schedules ?? []
  const projects = bootstrap?.projects ?? []

  const byDay = useMemo(() => {
    const map = new Map<string, { date: string; entries: typeof schedules }>()
    for (const s of schedules) {
      if (s.deleted_at) continue
      const day = s.scheduled_for.slice(0, 10)
      const cur = map.get(day) ?? { date: day, entries: [] }
      cur.entries.push(s)
      map.set(day, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [schedules])

  const totalCrew = byDay.reduce(
    (sum, d) => sum + d.entries.reduce((c, e) => c + (Array.isArray(e.crew) ? e.crew.length : 0), 0),
    0,
  )
  const utilizationPct = byDay.length > 0 ? Math.round((totalCrew / Math.max(1, byDay.length * 8)) * 100) : 0

  if (byDay.length === 0) {
    return (
      <>
        <MTopBar title="Schedule" actionIcon={<MI.Plus size={20} />} actionLabel="New" />
        <MEmptyState
          title="Nothing scheduled"
          body="Build a week ahead by assigning crews to projects. Tap a project to add it to the schedule."
          primaryLabel="See projects"
          onPrimary={() => navigate('/m/projects')}
        />
      </>
    )
  }

  return (
    <>
      <MTopBar title="Schedule" actionIcon={<MI.Plus size={20} />} actionLabel="New" />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {byDay.length} {byDay.length === 1 ? 'day' : 'days'}
            <span style={{ color: 'var(--m-ink-3)', fontWeight: 500, marginLeft: 8, fontSize: 14 }}>·</span>
            <span style={{ color: 'var(--m-ink-3)', fontWeight: 500, marginLeft: 6, fontSize: 14 }}>
              {totalCrew} crew assignments
            </span>
          </div>
          <div className="m-quiet-sm" style={{ marginTop: 4 }}>
            ~{utilizationPct}% utilization
          </div>
        </div>
        <MChipRow>
          <MChip active={mode === 'day'} onClick={() => setMode('day')}>
            Day
          </MChip>
          <MChip active={mode === 'week'} onClick={() => setMode('week')}>
            Week
          </MChip>
        </MChipRow>
        <MSectionH>This week</MSectionH>
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {byDay.slice(0, mode === 'day' ? 1 : 7).map((d) => (
            <DayCard
              key={d.date}
              date={d.date}
              entries={d.entries.map((e) => ({
                id: e.id,
                project: projects.find((p) => p.id === e.project_id)?.name ?? 'Unknown project',
                crewCount: Array.isArray(e.crew) ? e.crew.length : 0,
                status: e.status,
              }))}
            />
          ))}
        </div>
      </MBody>
    </>
  )
}

type DayEntry = {
  id: string
  project: string
  crewCount: number
  status: string
}

function DayCard({ date, entries }: { date: string; entries: readonly DayEntry[] }) {
  return (
    <div
      style={{
        background: 'var(--m-card)',
        border: '1px solid var(--m-line)',
        borderRadius: 12,
        padding: '12px 14px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--m-ink-3)',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {shortDate(date)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {entries.map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                background: 'var(--m-card-soft)',
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 13,
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {e.project}
            </div>
            <CrewDots count={e.crewCount} />
            <span className="m-quiet-sm" style={{ minWidth: 40, textAlign: 'right' }}>
              {e.crewCount} crew
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CrewDots({ count }: { count: number }) {
  const dots = Math.min(count, 6)
  return (
    <div style={{ display: 'inline-flex', gap: 2 }}>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--m-accent)',
          }}
        />
      ))}
      {count > 6 ? <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--m-ink-3)' }}>+{count - 6}</span> : null}
    </div>
  )
}

/**
 * Owner desktop schedule — the "week grid" (Desktop v2 · SCHEDULE).
 * A hard 2px-ruled grid: rows = active projects, columns = Mon–Fri,
 * cells = assignment chips (project code + crew count). Derives a simple
 * plausible assignment from the bootstrap schedules ledger when present,
 * otherwise renders empty cells. Reuses the same bootstrap payload as the
 * owner dashboard. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DEyebrow, DH1 } from '@/components/d'
import { MChip, MChipRow, MPill, MAvatar } from '@/components/m'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const

type ScheduleRow = BootstrapResponse['schedules'][number]

/** Mon=0 … Sun=6 column index for an ISO date string, or null if not Mon–Fri. */
function weekdayIndex(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const dow = d.getDay() // 0=Sun … 6=Sat
  const idx = (dow + 6) % 7 // Mon=0 … Sun=6
  return idx < 5 ? idx : null
}

export function OwnerSchedule({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [view, setView] = useState<'day' | 'week'>('week')

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  const active = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])

  // assignments[projectId][dayIndex] = crew count for that cell.
  const assignments = useMemo(() => {
    const map = new Map<string, Map<number, number>>()
    const liveSchedules = schedules.filter((s: ScheduleRow) => !s.deleted_at)
    for (const s of liveSchedules) {
      if (!s.project_id) continue
      const col = weekdayIndex(s.scheduled_for)
      if (col === null) continue
      const byDay = map.get(s.project_id) ?? new Map<number, number>()
      const crewCount = Array.isArray(s.crew) ? s.crew.length : 0
      byDay.set(col, (byDay.get(col) ?? 0) + Math.max(crewCount, 1))
      map.set(s.project_id, byDay)
    }
    return map
  }, [schedules])

  const columns = view === 'day' ? 1 : DAYS.length
  const visibleDays = view === 'day' ? DAYS.slice(0, 1) : DAYS

  const line = '2px solid var(--m-line)'

  if (!bootstrap) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Schedule</DEyebrow>
            <DH1>This week</DH1>
          </div>
          <div className="d-card">Loading the week…</div>
        </div>
      </div>
    )
  }

  const totalAssigned = active.reduce((sum, p) => {
    const byDay = assignments.get(p.id)
    if (!byDay) return sum
    return sum + [...byDay.values()].reduce((a, b) => a + b, 0)
  }, 0)

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Schedule</DEyebrow>
          <DH1>
            This week — {active.length} {active.length === 1 ? 'job' : 'jobs'}
            {totalAssigned > 0 ? `, ${totalAssigned} crew assigned.` : ', nothing booked yet.'}
          </DH1>
        </div>

        <MChipRow>
          <MChip active={view === 'day'} onClick={() => setView('day')}>
            Day
          </MChip>
          <MChip active={view === 'week'} onClick={() => setView('week')}>
            Week
          </MChip>
        </MChipRow>

        {active.length === 0 ? (
          <div className="d-card">No active jobs this week. Crews land here once a project kicks off.</div>
        ) : (
          <div
            role="grid"
            aria-label="Crew week grid"
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(180px, 1fr) repeat(${columns}, minmax(120px, 1fr))`,
              border: line,
              background: 'var(--m-card)',
              fontFamily: 'var(--m-font)',
              overflow: 'hidden',
            }}
          >
            {/* Header row */}
            <div
              role="columnheader"
              style={{
                borderRight: line,
                borderBottom: line,
                padding: '12px 14px',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                background: 'var(--m-sand)',
              }}
            >
              Project
            </div>
            {visibleDays.map((day, i) => (
              <div
                key={day}
                role="columnheader"
                style={{
                  borderRight: i === visibleDays.length - 1 ? 'none' : line,
                  borderBottom: line,
                  padding: '12px 14px',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-2)',
                  background: 'var(--m-sand)',
                  textAlign: 'center',
                }}
              >
                {day}
              </div>
            ))}

            {/* Body rows */}
            {active.map((project, rowIdx) => {
              const byDay = assignments.get(project.id)
              const isLastRow = rowIdx === active.length - 1
              const code = project.division_code || project.name.slice(0, 3).toUpperCase()
              return (
                <div key={project.id} style={{ display: 'contents' }}>
                  <div
                    role="rowheader"
                    style={{
                      borderRight: line,
                      borderBottom: isLastRow ? 'none' : line,
                      padding: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      background: 'var(--m-card)',
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--m-ink)' }}>{project.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{project.customer_name}</div>
                    <MPill tone="blue">{code}</MPill>
                  </div>
                  {visibleDays.map((day, colIdx) => {
                    const crewCount = byDay?.get(colIdx) ?? 0
                    return (
                      <div
                        key={day}
                        role="gridcell"
                        style={{
                          borderRight: colIdx === visibleDays.length - 1 ? 'none' : line,
                          borderBottom: isLastRow ? 'none' : line,
                          padding: 10,
                          minHeight: 72,
                          display: 'flex',
                          alignItems: 'flex-start',
                          background: crewCount > 0 ? 'var(--m-card)' : 'var(--m-sand-2)',
                        }}
                      >
                        {crewCount > 0 ? (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              border: '2px solid var(--m-line-2)',
                              background: 'var(--m-card)',
                              padding: '6px 8px',
                              width: '100%',
                            }}
                          >
                            <div
                              style={{
                                fontFamily: 'var(--m-num)',
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                color: 'var(--m-ink)',
                              }}
                            >
                              {code}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <MAvatar initials={String(crewCount)} tone="2" size="sm" />
                              <span style={{ fontSize: 11, color: 'var(--m-ink-3)' }}>
                                {crewCount} {crewCount === 1 ? 'crew' : 'crew'}
                              </span>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Foreman desktop schedule — the "2-week lookahead" grid (Desktop v2 ·
 * FM · SCHEDULE · 2-WEEK LOOKAHEAD). A hard 2px-ruled grid: rows = active
 * projects/crews, columns = the next 10 working days split into two week
 * bands (this week + next week). Cells = assignment chips (project code +
 * crew count). Mirrors screens/desktop/owner-schedule.tsx but widens the
 * horizon from one week to two. Derives assignments from the same
 * bootstrap.schedules ledger; renders empty cells when nothing is booked.
 */
import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DEyebrow, DH1 } from '@/components/d'
import { MChip, MPill, MAvatar } from '@/components/m'

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const
const DAYS_PER_WEEK = DAY_LABELS.length
const WEEKS = 2
const TOTAL_DAYS = DAYS_PER_WEEK * WEEKS // 10 working days

type ScheduleRow = BootstrapResponse['schedules'][number]

/** Monday of the week containing `from` (local time), at midnight. */
function startOfWeekMonday(from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const dow = d.getDay() // 0=Sun … 6=Sat
  const back = (dow + 6) % 7 // days since Monday
  d.setDate(d.getDate() - back)
  return d
}

/**
 * Column index 0…9 across the two-week working-day window starting on the
 * Monday of the current week, or null if the date is a weekend or outside
 * the 14-day span.
 */
function lookaheadColumn(iso: string, weekStart: Date): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dayMs = 24 * 60 * 60 * 1000
  const offset = Math.round((day.getTime() - weekStart.getTime()) / dayMs)
  if (offset < 0 || offset > 13) return null
  const weekIdx = Math.floor(offset / 7) // 0 or 1
  const dowIdx = offset % 7 // 0=Mon … 6=Sun
  if (dowIdx >= DAYS_PER_WEEK) return null // weekend
  return weekIdx * DAYS_PER_WEEK + dowIdx
}

export function FmSchedule({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const weekStart = useMemo(() => startOfWeekMonday(new Date()), [])

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  const active = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])

  // assignments[projectId][columnIndex 0…9] = crew count for that cell.
  const assignments = useMemo(() => {
    const map = new Map<string, Map<number, number>>()
    const liveSchedules = schedules.filter((s: ScheduleRow) => !s.deleted_at)
    for (const s of liveSchedules) {
      if (!s.project_id) continue
      const col = lookaheadColumn(s.scheduled_for, weekStart)
      if (col === null) continue
      const byCol = map.get(s.project_id) ?? new Map<number, number>()
      const crewCount = Array.isArray(s.crew) ? s.crew.length : 0
      byCol.set(col, (byCol.get(col) ?? 0) + Math.max(crewCount, 1))
      map.set(s.project_id, byCol)
    }
    return map
  }, [schedules, weekStart])

  const line = '2px solid var(--m-line)'

  if (!bootstrap) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Foreman · Schedule</DEyebrow>
            <DH1>Next 2 weeks</DH1>
          </div>
          <div className="d-card">Loading the lookahead…</div>
        </div>
      </div>
    )
  }

  const totalAssigned = active.reduce((sum, p) => {
    const byCol = assignments.get(p.id)
    if (!byCol) return sum
    return sum + [...byCol.values()].reduce((a, b) => a + b, 0)
  }, 0)

  // Week-band labels for the two header sub-rows.
  const nextWeekStart = new Date(weekStart)
  nextWeekStart.setDate(nextWeekStart.getDate() + 7)
  const bandLabels = ['This week', 'Next week'] as const
  const bandDates = [weekStart, nextWeekStart]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Schedule</DEyebrow>
          <DH1>
            Next 2 weeks — {active.length} {active.length === 1 ? 'job' : 'jobs'}
            {totalAssigned > 0 ? `, ${totalAssigned} crew booked.` : ', nothing booked yet.'}
          </DH1>
        </div>

        {active.length === 0 ? (
          <div className="d-card">No active jobs in the lookahead. Crews land here once a project kicks off.</div>
        ) : (
          <div
            role="grid"
            aria-label="Crew 2-week lookahead grid"
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(180px, 1.4fr) repeat(${TOTAL_DAYS}, minmax(72px, 1fr))`,
              border: line,
              background: 'var(--m-card)',
              fontFamily: 'var(--m-font)',
              overflow: 'hidden',
            }}
          >
            {/* Week-band row: a project spacer + two spans of 5 days each */}
            <div
              role="columnheader"
              style={{
                borderRight: line,
                borderBottom: line,
                padding: '10px 14px',
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
            {bandLabels.map((label, bandIdx) => {
              const isLastBand = bandIdx === bandLabels.length - 1
              const mon = bandDates[bandIdx]
              const sub = mon
                ? mon.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : ''
              return (
                <div
                  key={label}
                  role="columnheader"
                  style={{
                    gridColumn: `span ${DAYS_PER_WEEK}`,
                    borderRight: isLastBand ? 'none' : line,
                    borderBottom: line,
                    padding: '10px 14px',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--m-ink-2)',
                    background: 'var(--m-sand)',
                    textAlign: 'center',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span>{label}</span>
                  {sub ? <span style={{ color: 'var(--m-ink-3)' }}>· {sub}</span> : null}
                </div>
              )
            })}

            {/* Day-label row: project spacer + 10 mono uppercase day headers */}
            <div
              role="columnheader"
              aria-hidden
              style={{
                borderRight: line,
                borderBottom: line,
                background: 'var(--m-sand-2)',
              }}
            />
            {Array.from({ length: TOTAL_DAYS }, (_, col) => {
              const isLastCol = col === TOTAL_DAYS - 1
              const isWeekBoundary = col === DAYS_PER_WEEK // first column of next week
              return (
                <div
                  key={col}
                  role="columnheader"
                  style={{
                    borderRight: isLastCol ? 'none' : line,
                    borderLeft: isWeekBoundary ? line : undefined,
                    borderBottom: line,
                    padding: '8px 4px',
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--m-ink-3)',
                    background: 'var(--m-sand-2)',
                    textAlign: 'center',
                  }}
                >
                  {DAY_LABELS[col % DAYS_PER_WEEK]}
                </div>
              )
            })}

            {/* Body rows: one per active project/crew */}
            {active.map((project, rowIdx) => {
              const byCol = assignments.get(project.id)
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
                  {Array.from({ length: TOTAL_DAYS }, (_, col) => {
                    const crewCount = byCol?.get(col) ?? 0
                    const isLastCol = col === TOTAL_DAYS - 1
                    const isWeekBoundary = col === DAYS_PER_WEEK
                    return (
                      <div
                        key={col}
                        role="gridcell"
                        style={{
                          borderRight: isLastCol ? 'none' : line,
                          borderLeft: isWeekBoundary ? line : undefined,
                          borderBottom: isLastRow ? 'none' : line,
                          padding: 6,
                          minHeight: 64,
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
                              gap: 5,
                              border: '2px solid var(--m-line-2)',
                              background: 'var(--m-card)',
                              padding: '5px 6px',
                              width: '100%',
                            }}
                          >
                            <div
                              style={{
                                fontFamily: 'var(--m-num)',
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                color: 'var(--m-ink)',
                              }}
                            >
                              {code}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <MAvatar initials={String(crewCount)} tone="2" size="sm" />
                              <span style={{ fontSize: 10, color: 'var(--m-ink-3)' }}>crew</span>
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

        <MChip>Read-only · driven by the schedule ledger</MChip>
      </div>
    </div>
  )
}

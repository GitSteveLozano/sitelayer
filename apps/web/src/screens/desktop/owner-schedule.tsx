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
import { MButton, MChip, MChipRow, MPill, MAvatar } from '@/components/m'
import { NewAssignmentModal } from './project-drawers'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const

type ScheduleRow = BootstrapResponse['schedules'][number]

type ScheduleView = 'day' | 'week' | '4wk'

/** A positioned bar on the 4-week (20 working-day) timeline. */
interface TimelineBlock {
  start: number // 0..19 — working-day offset from the Monday of week 1
  span: number // working-day width
  label: string
}
interface TimelineProject {
  id: string
  name: string
  color: string
  blocks: TimelineBlock[]
}

// 4 weeks × 5 working days. The timeline grid is laid out by week, so each
// week is a fifth-of-a-fifth — positions are computed in working-day units.
const TIMELINE_DAYS = 20

// Distinct row accents (square, 2px-bordered) matching the v2 palette.
const ROW_COLORS = ['var(--m-accent)', 'var(--m-red)', 'var(--m-green)', 'var(--m-ink)'] as const

// Presentational demo rows — used ONLY when the bootstrap ledger has no
// live schedules to render. Clearly flagged in the UI as a sample.
const DEMO_TIMELINE: TimelineProject[] = [
  {
    id: 'demo-hillcrest',
    name: 'Hillcrest',
    color: 'var(--m-accent)',
    blocks: [
      { start: 0, span: 8, label: 'EPS · 3' },
      { start: 9, span: 5, label: 'BASE · 3' },
    ],
  },
  {
    id: 'demo-aspen',
    name: 'Aspen Ridge',
    color: 'var(--m-red)',
    blocks: [
      { start: 3, span: 7, label: 'BASE · 4' },
      { start: 14, span: 4, label: 'FINISH · 4' },
    ],
  },
  {
    id: 'demo-greenwillow',
    name: 'Greenwillow',
    color: 'var(--m-green)',
    blocks: [{ start: 6, span: 12, label: 'STONE · 11' }],
  },
]

/** Monday of the ISO-week containing `d` (local time). */
function mondayOf(d: Date): Date {
  const m = new Date(d)
  const dow = (m.getDay() + 6) % 7 // Mon=0 … Sun=6
  m.setDate(m.getDate() - dow)
  m.setHours(0, 0, 0, 0)
  return m
}

/**
 * Working-day offset (Mon–Fri only) from `anchorMonday` for an ISO date, or
 * null when the date falls outside the 4-week window or on a weekend.
 */
function workingDayOffset(iso: string, anchorMonday: Date): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  d.setHours(0, 0, 0, 0)
  const ms = d.getTime() - anchorMonday.getTime()
  const calDay = Math.floor(ms / 86_400_000)
  if (calDay < 0) return null
  const week = Math.floor(calDay / 7)
  const dow = calDay % 7
  if (week > 3 || dow > 4) return null // beyond 4 weeks, or a weekend
  return week * 5 + dow
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const

/** "MAY 5" style week header label for the Monday `weeks` weeks after anchor. */
function weekLabel(anchorMonday: Date, week: number): string {
  const d = new Date(anchorMonday)
  d.setDate(d.getDate() + week * 7)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** Mon=0 … Sun=6 column index for an ISO date string, or null if not Mon–Fri. */
function weekdayIndex(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const dow = d.getDay() // 0=Sun … 6=Sat
  const idx = (dow + 6) % 7 // Mon=0 … Sun=6
  return idx < 5 ? idx : null
}

/**
 * 4-week drag timeline (Desktop v2 · DScheduleTimeline). Per-project rows with
 * colored assignment blocks positioned across a 20-working-day (4×5) grid, a
 * week-header (MAY 5 / 12 / 19 / 26), and a rain-forecast flag line.
 *
 * Drag-to-move / resize is VISUAL only — blocks show `cursor:grab` and a
 * resize-handle affordance on the right edge; no real drag is wired.
 */
function FourWeekTimeline({
  anchorMonday,
  timeline,
  isDemo,
  line,
}: {
  anchorMonday: Date
  timeline: TimelineProject[]
  isDemo: boolean
  line: string
}) {
  // Wednesday of week 1 — a presentational rain-forecast flag, matching the
  // mockup's "WED MAY 7" callout.
  const rainDay = new Date(anchorMonday)
  rainDay.setDate(rainDay.getDate() + 2)
  const rainLabel = `${MONTHS[rainDay.getMonth()]} ${rainDay.getDate()}`

  const headerCell: React.CSSProperties = {
    padding: '12px 16px',
    background: 'var(--m-sand)',
    fontFamily: 'var(--m-num)',
    fontWeight: 800,
    fontSize: 12,
    letterSpacing: '0.04em',
    color: 'var(--m-ink-2)',
  }

  return (
    <div className="d-stack" style={{ gap: 12 }}>
      <div className="d-eyebrow">Drag to move · drag edge to resize</div>

      {isDemo ? (
        <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 13, padding: '12px 14px' }}>
          No crew bookings land in the next four weeks — showing a sample timeline. Book crews to populate it with live
          assignments.
        </div>
      ) : null}

      <div
        style={{
          border: line,
          background: 'var(--m-card)',
          overflow: 'hidden',
          fontFamily: 'var(--m-font)',
        }}
      >
        {/* Week header */}
        <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', borderBottom: line }}>
          <div style={{ ...headerCell, borderRight: line }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            {[0, 1, 2, 3].map((w) => (
              <div key={w} style={{ ...headerCell, borderRight: w < 3 ? line : 'none' }}>
                {weekLabel(anchorMonday, w)}
              </div>
            ))}
          </div>
        </div>

        {/* Project rows */}
        {timeline.map((proj, ri) => {
          const isLast = ri === timeline.length - 1
          return (
            <div
              key={proj.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px minmax(0, 1fr)',
                borderBottom: isLast ? 'none' : '1px solid var(--m-line-2)',
              }}
            >
              <div
                style={{
                  padding: '20px 16px',
                  borderRight: line,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--m-card)',
                }}
              >
                <span aria-hidden style={{ width: 10, height: 10, background: proj.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--m-ink)' }}>{proj.name}</span>
              </div>
              <div
                style={{
                  position: 'relative',
                  height: 72,
                  // 5 day-gridlines per the visible 4-week span.
                  background:
                    'repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), var(--m-line-2) calc(25% - 1px), var(--m-line-2) 25%)',
                }}
              >
                {proj.blocks.map((b, bi) => {
                  const onAccent = proj.color === 'var(--m-accent)'
                  return (
                    <div
                      key={bi}
                      title={`${b.label} — drag to move (visual)`}
                      style={{
                        position: 'absolute',
                        top: 14,
                        left: `${(b.start / TIMELINE_DAYS) * 100}%`,
                        width: `${(b.span / TIMELINE_DAYS) * 100}%`,
                        height: 44,
                        background: proj.color,
                        color: onAccent ? 'var(--m-accent-ink)' : '#fff',
                        border: '2px solid var(--m-ink)',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 12px',
                        fontFamily: 'var(--m-num)',
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        cursor: 'grab',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {b.label}
                      {/* resize-handle affordance (visual only) */}
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: 8,
                          background: 'rgba(0,0,0,0.2)',
                          cursor: 'ew-resize',
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Rain-forecast flag line */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 4 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--m-ink-3)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--m-ink-3)' }} />
          {`WED ${rainLabel} · RAIN FORECAST — first project auto-flagged`}
        </span>
      </div>
    </div>
  )
}

export function OwnerSchedule({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [view, setView] = useState<ScheduleView>('week')
  const [assignmentOpen, setAssignmentOpen] = useState(false)

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  const active = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])

  // Monday of the current week anchors the 4-week timeline window.
  const anchorMonday = useMemo(() => mondayOf(new Date()), [])

  // Derive real per-project assignment blocks across the 20 working-day grid
  // from the live schedules ledger. Consecutive scheduled days for a project
  // collapse into one contiguous block; the block label is its peak crew size.
  const liveTimeline = useMemo<TimelineProject[]>(() => {
    const byProject = new Map<string, Map<number, number>>()
    for (const s of schedules) {
      if (s.deleted_at || !s.project_id) continue
      const off = workingDayOffset(s.scheduled_for, anchorMonday)
      if (off === null) continue
      const days = byProject.get(s.project_id) ?? new Map<number, number>()
      const crewCount = Array.isArray(s.crew) ? s.crew.length : 0
      days.set(off, (days.get(off) ?? 0) + Math.max(crewCount, 1))
      byProject.set(s.project_id, days)
    }

    const out: TimelineProject[] = []
    let colorIdx = 0
    for (const p of active) {
      const days = byProject.get(p.id)
      if (!days || days.size === 0) continue
      const color = ROW_COLORS[colorIdx % ROW_COLORS.length]!
      colorIdx += 1
      const code = p.division_code || p.name.slice(0, 3).toUpperCase()

      // Collapse contiguous offsets into blocks.
      const offsets = [...days.keys()].sort((a, b) => a - b)
      const blocks: TimelineBlock[] = []
      let runStart = offsets[0]!
      let prev = offsets[0]!
      let peak = days.get(prev) ?? 0
      const flush = (end: number) => {
        blocks.push({ start: runStart, span: end - runStart + 1, label: `${code} · ${peak}` })
      }
      for (let i = 1; i < offsets.length; i += 1) {
        const cur = offsets[i]!
        if (cur === prev + 1) {
          peak = Math.max(peak, days.get(cur) ?? 0)
        } else {
          flush(prev)
          runStart = cur
          peak = days.get(cur) ?? 0
        }
        prev = cur
      }
      flush(prev)
      out.push({ id: p.id, name: p.name, color, blocks })
    }
    return out
  }, [schedules, active, anchorMonday])

  // Fall back to the clearly-flagged demo rows when no live blocks land in
  // the 4-week window.
  const usingDemoTimeline = liveTimeline.length === 0
  const timeline = usingDemoTimeline ? DEMO_TIMELINE : liveTimeline

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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <DEyebrow>Owner · Schedule</DEyebrow>
            <DH1>
              This week — {active.length} {active.length === 1 ? 'job' : 'jobs'}
              {totalAssigned > 0 ? `, ${totalAssigned} crew assigned.` : ', nothing booked yet.'}
            </DH1>
          </div>
          <MButton size="sm" variant="primary" onClick={() => setAssignmentOpen(true)}>
            New assignment
          </MButton>
        </div>

        <MChipRow>
          <MChip active={view === 'day'} onClick={() => setView('day')}>
            Day
          </MChip>
          <MChip active={view === 'week'} onClick={() => setView('week')}>
            Week
          </MChip>
          <MChip active={view === '4wk'} onClick={() => setView('4wk')}>
            4-WK
          </MChip>
        </MChipRow>

        {view === '4wk' ? (
          <FourWeekTimeline anchorMonday={anchorMonday} timeline={timeline} isDemo={usingDemoTimeline} line={line} />
        ) : active.length === 0 ? (
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

      {/* NEW ASSIGNMENT modal (Desktop v2 · DNewAssignmentModal) — the
          imported presentational port; its footer SAVE button is a no-op
          stub today (no onSubmit prop on the shared modal). */}
      <NewAssignmentModal open={assignmentOpen} onClose={() => setAssignmentOpen(false)} />
    </div>
  )
}

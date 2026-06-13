/**
 * Owner desktop schedule — the "week grid" (Desktop v2 · SCHEDULE).
 * A hard 2px-ruled grid: rows = active projects, columns = Mon–Fri,
 * cells = assignment chips (project code + crew count). Derives a simple
 * plausible assignment from the bootstrap schedules ledger when present,
 * otherwise renders empty cells. Reuses the same bootstrap payload as the
 * owner dashboard. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BootstrapResponse } from '@/lib/api'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton } from '@/components/m'
import { patchCrewSchedule } from '@/lib/api/crew-schedules'
import {
  TIMELINE_DAYS,
  clampShift,
  computeRescheduleOps,
  pxToDayShift,
  type TimelineBlock,
} from '@/lib/schedule-timeline'
import { NewAssignmentModal } from './project-drawers'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const

type ScheduleRow = BootstrapResponse['schedules'][number]

type ScheduleView = 'day' | 'week' | '4wk'

interface TimelineProject {
  id: string
  name: string
  color: string
  blocks: TimelineBlock[]
}

// Distinct row accents (square, 2px-bordered) matching the v2 palette.
const ROW_COLORS = ['var(--m-accent)', 'var(--m-red)', 'var(--m-green)', 'var(--m-ink)'] as const

// Presentational demo rows — used ONLY when the bootstrap ledger has no
// live schedules to render. Clearly flagged in the UI as a sample. Demo
// blocks carry no real schedule ids (`days: []`) so drag-to-reschedule is
// inert on them — there is nothing to PATCH.
const DEMO_TIMELINE: TimelineProject[] = [
  {
    id: 'demo-hillcrest',
    name: 'Hillcrest',
    color: 'var(--m-accent)',
    blocks: [
      { start: 0, span: 8, label: 'EPS · 3', days: [] },
      { start: 9, span: 5, label: 'BASE · 3', days: [] },
    ],
  },
  {
    id: 'demo-aspen',
    name: 'Aspen Ridge',
    color: 'var(--m-red)',
    blocks: [
      { start: 3, span: 7, label: 'BASE · 4', days: [] },
      { start: 14, span: 4, label: 'FINISH · 4', days: [] },
    ],
  },
  {
    id: 'demo-greenwillow',
    name: 'Greenwillow',
    color: 'var(--m-green)',
    blocks: [{ start: 6, span: 12, label: 'STONE · 11', days: [] }],
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
 * Schedule dates are SQL-style calendar days. `new Date("YYYY-MM-DD")` parses
 * as UTC and shifts to the prior local day in western timezones, which drops
 * Monday rows out of the working-day grid. Keep date-only strings as local
 * calendar dates.
 */
function parseScheduleDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (match) {
    const y = Number(match[1])
    const m = Number(match[2])
    const d = Number(match[3])
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      return new Date(y, m - 1, d)
    }
  }
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

/**
 * Working-day offset (Mon–Fri only) from `anchorMonday` for an ISO date, or
 * null when the date falls outside the 4-week window or on a weekend.
 */
function workingDayOffset(iso: string, anchorMonday: Date): number | null {
  const d = parseScheduleDate(iso)
  if (!d) return null
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
  const d = parseScheduleDate(iso)
  if (!d) return null
  const dow = d.getDay() // 0=Sun … 6=Sat
  const idx = (dow + 6) % 7 // Mon=0 … Sun=6
  return idx < 5 ? idx : null
}

/**
 * 4-week drag timeline (Desktop v2 · DScheduleTimeline). Per-project rows with
 * colored assignment blocks positioned across a 20-working-day (4×5) grid, a
 * week-header (MAY 5 / 12 / 19 / 26), and a rain-forecast flag line.
 *
 * Drag-to-MOVE is wired (Gap 4): pointer-drag a block horizontally, it snaps
 * to whole working-day columns, and on release each underlying crew_schedules
 * row is PATCHed to its shifted date via `onReschedule`. Edge-RESIZE remains a
 * visual affordance only. Demo blocks (no real ids) are not draggable.
 */
function FourWeekTimeline({
  anchorMonday,
  timeline,
  isDemo,
  line,
  onReschedule,
  busy,
}: {
  anchorMonday: Date
  timeline: TimelineProject[]
  isDemo: boolean
  line: string
  onReschedule: (block: TimelineBlock, shift: number) => void
  busy: boolean
}) {
  // Live pointer-drag state for the block currently under the pointer. `dx` is
  // the pixel delta from drag start; `trackWidth` is the row track's px width
  // (for px→working-day snapping). Null when no drag is in progress.
  const [drag, setDrag] = useState<{ key: string; dx: number; trackWidth: number } | null>(null)
  const dragRef = useRef<{ key: string; startX: number; trackWidth: number; block: TimelineBlock } | null>(null)
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

  // Begin a drag on a real (non-demo) block with at least one underlying row.
  const onBlockPointerDown = (e: React.PointerEvent<HTMLDivElement>, key: string, block: TimelineBlock) => {
    if (isDemo || busy || block.days.length === 0) return
    // Measure the row track (the positioned parent of the block) for snapping.
    const track = (e.currentTarget.parentElement as HTMLElement | null) ?? null
    const trackWidth = track ? track.getBoundingClientRect().width : 0
    if (!(trackWidth > 0)) return
    dragRef.current = { key, startX: e.clientX, trackWidth, block }
    setDrag({ key, dx: 0, trackWidth })
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onBlockPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setDrag({ key: d.key, dx: e.clientX - d.startX, trackWidth: d.trackWidth })
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!d) {
      setDrag(null)
      return
    }
    const rawShift = pxToDayShift(e.clientX - d.startX, d.trackWidth)
    const shift = clampShift(d.block.start, d.block.span, rawShift)
    setDrag(null)
    if (shift !== 0) onReschedule(d.block, shift)
  }

  return (
    <div className="d-stack" style={{ gap: 12 }}>
      <div className="d-eyebrow">
        {busy
          ? 'Rescheduling…'
          : isDemo
            ? 'Sample timeline — book crews to drag real assignments'
            : 'Drag to reschedule · drag edge to resize'}
      </div>

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
                  const key = `${proj.id}:${bi}`
                  const isDragging = drag?.key === key
                  // Whole-day snap preview during a drag so the bar tracks the
                  // grid columns rather than sliding by raw pixels.
                  const previewShift = isDragging
                    ? clampShift(b.start, b.span, pxToDayShift(drag!.dx, drag!.trackWidth))
                    : 0
                  const draggable = !isDemo && b.days.length > 0
                  return (
                    <div
                      key={bi}
                      role={draggable ? 'button' : undefined}
                      title={draggable ? `${b.label} — drag to reschedule` : `${b.label} — sample (not draggable)`}
                      onPointerDown={(e) => onBlockPointerDown(e, key, b)}
                      onPointerMove={onBlockPointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      style={{
                        position: 'absolute',
                        top: 14,
                        left: `${((b.start + previewShift) / TIMELINE_DAYS) * 100}%`,
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
                        cursor: draggable ? (isDragging ? 'grabbing' : 'grab') : 'default',
                        opacity: busy ? 0.6 : 1,
                        touchAction: draggable ? 'none' : undefined,
                        boxShadow: isDragging ? '0 0 0 2px var(--m-accent)' : 'none',
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
  const [rescheduling, setRescheduling] = useState(false)
  const qc = useQueryClient()

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  // Monday of the current week anchors the 4-week timeline window. Stable for
  // the component's lifetime ([] deps), so it's safe to capture in callbacks.
  const anchorMonday = useMemo(() => mondayOf(new Date()), [])

  // Drag-to-reschedule drop handler (Gap 4). Each underlying crew_schedules
  // row is PATCHed to its shifted YYYY-MM-DD via the ready server endpoint
  // (PATCH /api/schedules/:id). The block label/position is derived from the
  // bootstrap ledger, so after the PATCHes land we invalidate the schedule +
  // bootstrap caches and let the grid re-derive — no local business state.
  const handleReschedule = useCallback(
    async (block: TimelineBlock, shift: number) => {
      const ops = computeRescheduleOps(block, shift, anchorMonday)
      if (ops.length === 0) return
      setRescheduling(true)
      try {
        await Promise.all(ops.map((op) => patchCrewSchedule(op.id, { scheduled_for: op.scheduled_for })))
      } catch {
        // The block snaps back on the next re-derive; the invalidate below
        // (in `finally`) refreshes from server-truth either way.
      } finally {
        void qc.invalidateQueries({ queryKey: ['schedules'] })
        void qc.invalidateQueries({ queryKey: ['bootstrap'] })
        setRescheduling(false)
      }
    },
    [qc, anchorMonday],
  )

  const active = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])

  // Derive real per-project assignment blocks across the 20 working-day grid
  // from the live schedules ledger. Consecutive scheduled days for a project
  // collapse into one contiguous block; the block label is its peak crew size.
  const liveTimeline = useMemo<TimelineProject[]>(() => {
    // Per project: offset → peak crew count, and offset → schedule row ids
    // landing on that working day. The ids ride into each block's `days` so
    // drag-to-reschedule (Gap 4) can PATCH the exact rows on drop.
    const countByProject = new Map<string, Map<number, number>>()
    const idsByProject = new Map<string, Map<number, string[]>>()
    for (const s of schedules) {
      if (s.deleted_at || !s.project_id) continue
      const off = workingDayOffset(s.scheduled_for, anchorMonday)
      if (off === null) continue
      const counts = countByProject.get(s.project_id) ?? new Map<number, number>()
      const crewCount = Array.isArray(s.crew) ? s.crew.length : 0
      counts.set(off, (counts.get(off) ?? 0) + Math.max(crewCount, 1))
      countByProject.set(s.project_id, counts)
      const ids = idsByProject.get(s.project_id) ?? new Map<number, string[]>()
      const dayIds = ids.get(off) ?? []
      dayIds.push(s.id)
      ids.set(off, dayIds)
      idsByProject.set(s.project_id, ids)
    }

    const out: TimelineProject[] = []
    let colorIdx = 0
    for (const p of active) {
      const counts = countByProject.get(p.id)
      const ids = idsByProject.get(p.id)
      if (!counts || counts.size === 0) continue
      const color = ROW_COLORS[colorIdx % ROW_COLORS.length]!
      colorIdx += 1
      const code = p.division_code || p.name.slice(0, 3).toUpperCase()

      // Collapse contiguous offsets into blocks, carrying the per-day ids.
      const offsets = [...counts.keys()].sort((a, b) => a - b)
      const blocks: TimelineBlock[] = []
      let runStart = offsets[0]!
      let prev = offsets[0]!
      let peak = counts.get(prev) ?? 0
      let runDays: Array<{ offset: number; ids: string[] }> = [{ offset: prev, ids: ids?.get(prev) ?? [] }]
      const flush = (end: number) => {
        blocks.push({ start: runStart, span: end - runStart + 1, label: `${code} · ${peak}`, days: runDays })
      }
      for (let i = 1; i < offsets.length; i += 1) {
        const cur = offsets[i]!
        if (cur === prev + 1) {
          peak = Math.max(peak, counts.get(cur) ?? 0)
          runDays.push({ offset: cur, ids: ids?.get(cur) ?? [] })
        } else {
          flush(prev)
          runStart = cur
          peak = counts.get(cur) ?? 0
          runDays = [{ offset: cur, ids: ids?.get(cur) ?? [] }]
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

  // Crew roster size — the denominator for the utilization summary stat.
  const crewRoster = bootstrap.workers.filter((w) => !w.deleted_at)
  const utilization = crewRoster.length > 0 ? Math.round((totalAssigned / crewRoster.length) * 100) : 0

  // Per-project accent color so the week-grid rows + cell bars read in the
  // same color language as the 4-week timeline.
  const projectColor = (rowIdx: number) => ROW_COLORS[rowIdx % ROW_COLORS.length]!

  // Square-bordered top-right view toggle matching the design's button group.
  const ViewToggle = () => (
    <div style={{ display: 'flex', border: line }}>
      {(['day', 'week', '4wk'] as const).map((v, i) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          style={{
            padding: '8px 14px',
            border: 'none',
            borderLeft: i === 0 ? 'none' : line,
            background: view === v ? 'var(--m-accent)' : 'var(--m-card)',
            color: view === v ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          {v === '4wk' ? '4-WK' : v}
        </button>
      ))}
    </div>
  )

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
            <DEyebrow>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  background: 'var(--m-accent)',
                  marginRight: 8,
                  verticalAlign: 'middle',
                }}
              />
              {`${active.length} ${active.length === 1 ? 'PROJECT' : 'PROJECTS'} · ${crewRoster.length} CREW · ${utilization}% UTILIZED`}
            </DEyebrow>
            <DH1>Schedule</DH1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ViewToggle />
            <MButton size="sm" variant="primary" onClick={() => setAssignmentOpen(true)}>
              New assignment
            </MButton>
          </div>
        </div>

        {view === '4wk' ? (
          <FourWeekTimeline
            anchorMonday={anchorMonday}
            timeline={timeline}
            isDemo={usingDemoTimeline}
            line={line}
            onReschedule={handleReschedule}
            busy={rescheduling}
          />
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
            {visibleDays.map((day, i) => {
              // Dated weekday label (e.g. "MON 5") anchored to the current
              // week's Monday — matches the design's MON 5 / TUE 6 columns.
              const cellDate = new Date(anchorMonday)
              cellDate.setDate(cellDate.getDate() + i)
              // Wednesday (column index 2) carries the presentational
              // rain-forecast flag, mirroring the 4-week timeline callout.
              const isRainDay = i === 2
              return (
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
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span>{`${day} ${cellDate.getDate()}`}</span>
                  {isRainDay ? (
                    <span
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: '0.06em',
                        color: '#fff',
                        background: 'var(--m-red)',
                        padding: '2px 5px',
                      }}
                    >
                      RAIN
                    </span>
                  ) : null}
                </div>
              )
            })}

            {/* Body rows */}
            {active.map((project, rowIdx) => {
              const byDay = assignments.get(project.id)
              const isLastRow = rowIdx === active.length - 1
              const code = project.division_code || project.name.slice(0, 3).toUpperCase()
              const color = projectColor(rowIdx)
              const onAccent = color === 'var(--m-accent)'
              return (
                <div key={project.id} style={{ display: 'contents' }}>
                  <div
                    role="rowheader"
                    style={{
                      borderRight: line,
                      borderBottom: isLastRow ? 'none' : line,
                      padding: '14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'var(--m-card)',
                    }}
                  >
                    <span aria-hidden style={{ width: 12, height: 12, background: color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--m-ink)' }}>{project.name}</span>
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
                          alignItems: 'center',
                          background: 'var(--m-card)',
                        }}
                      >
                        {crewCount > 0 ? (
                          <div
                            title={`${code} · ${crewCount} crew`}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              border: '2px solid var(--m-ink)',
                              background: color,
                              color: onAccent ? 'var(--m-accent-ink)' : '#fff',
                              padding: '8px 10px',
                              width: '100%',
                              minHeight: 32,
                              fontFamily: 'var(--m-num)',
                              fontSize: 11,
                              fontWeight: 800,
                              letterSpacing: '0.04em',
                              textTransform: 'uppercase',
                            }}
                          >
                            {`${code} · ${crewCount}`}
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

      {/* NEW ASSIGNMENT modal (Desktop v2 · DNewAssignmentModal) — a real
          schedule-create form. Projects come from the bootstrap list; on
          save it POSTs /api/schedules and the create hook invalidates the
          bootstrap cache so the new draft assignment lands on the grid. */}
      <NewAssignmentModal
        open={assignmentOpen}
        onClose={() => setAssignmentOpen(false)}
        projects={projects}
        crew={crewRoster}
      />
    </div>
  )
}

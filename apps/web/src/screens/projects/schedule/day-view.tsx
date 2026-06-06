import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { type CrewScheduleRow, type Worker } from '@/lib/api'
import { initials, colorForProject } from './helpers'

interface DayViewProps {
  schedules: CrewScheduleRow[]
  workers: Worker[]
  weekStartMs: number
  selectedDate: string
  onSelectDate: (iso: string) => void
}

export function DayView({ schedules, workers, weekStartMs, selectedDate, onSelectDate }: DayViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const ms = weekStartMs + i * 24 * 3600 * 1000
    const date = new Date(ms)
    return {
      iso: date.toISOString().slice(0, 10),
      dow: date.toLocaleDateString(undefined, { weekday: 'short' }),
      n: date.getDate(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    }
  })

  const todays = schedules.filter((s) => s.scheduled_for === selectedDate)
  const workerById = new Map(workers.map((w) => [w.id, w]))
  const summary = summarizeDay(todays)
  const headerLabel = formatDayHeader(selectedDate)

  return (
    <>
      <div className="flex gap-1.5 px-4 py-2 overflow-x-auto border-b border-line scrollbar-hide">
        {days.map((d) => (
          <button
            key={d.iso}
            type="button"
            onClick={() => onSelectDate(d.iso)}
            className={`shrink-0 min-w-[46px] py-2 px-1 rounded-[10px] text-center ${
              selectedDate === d.iso ? 'bg-ink text-white' : d.isWeekend ? 'text-ink-4' : 'text-ink'
            }`}
          >
            <div className="text-[10px] font-medium opacity-70">{d.dow}</div>
            <div className="num text-[18px] font-semibold mt-0.5">{d.n}</div>
          </button>
        ))}
      </div>

      <div className="px-4 py-4 pb-24">
        {todays.length === 0 ? (
          <Card>
            <div className="text-[13px] font-semibold">No assignments for this day</div>
            <div className="text-[11px] text-ink-3 mt-1">Tap + to create one.</div>
          </Card>
        ) : (
          <div className="space-y-2.5">
            <div className="px-1 pb-1">
              <div className="font-display text-[22px] font-bold tracking-tight leading-tight">
                {headerLabel.eyebrow}
              </div>
              <div className="text-[12px] text-ink-3 mt-0.5">{headerLabel.subhead}</div>
              <div className="text-[12px] text-ink-2 mt-1">
                <span className="num font-medium">{summary.jobs}</span> job{summary.jobs === 1 ? '' : 's'}
                {summary.crew > 0 ? (
                  <>
                    {' · '}
                    <span className="num font-medium">{summary.crew}</span> crew
                  </>
                ) : null}
                {summary.crewHours > 0 ? (
                  <>
                    {' · '}
                    <span className="num font-medium">{summary.crewHours.toFixed(1)}h</span>
                  </>
                ) : null}
                {' · '}
                <span className={summary.allConfirmed ? 'text-good font-medium' : 'text-warn font-medium'}>
                  {summary.allConfirmed ? 'all confirmed' : `${summary.pending} pending`}
                </span>
              </div>
            </div>
            {todays.map((s) => (
              <ScheduleCard key={s.id} schedule={s} workerById={workerById} />
            ))}
            <div className="pt-1 px-1">
              <Attribution source="Live from /api/schedules" />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function summarizeDay(rows: CrewScheduleRow[]): {
  jobs: number
  crew: number
  crewHours: number
  pending: number
  allConfirmed: boolean
} {
  let pending = 0
  let crewHours = 0
  const crewIds = new Set<string>()
  for (const r of rows) {
    if (r.status !== 'confirmed') pending += 1
    const ids = Array.isArray(r.crew) ? (r.crew as unknown[]).filter((x): x is string => typeof x === 'string') : []
    for (const id of ids) crewIds.add(id)
    const hours = hoursBetween(r.start_time, r.end_time)
    if (hours != null) crewHours += hours * ids.length
  }
  return {
    jobs: rows.length,
    crew: crewIds.size,
    crewHours,
    pending,
    allConfirmed: rows.length > 0 && pending === 0,
  }
}

export function formatDayHeader(iso: string): { eyebrow: string; subhead: string } {
  const d = new Date(`${iso}T00:00:00`)
  const today = new Date()
  const isToday =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return {
    eyebrow: isToday ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'long' }),
    subhead: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  }
}

/**
 * Wall-clock hours between two `time` columns. Returns null if either
 * is missing — the day-stream card hides the hours pill in that case
 * rather than showing 0h. Same-day only; an end before start would
 * indicate bad data and we surface as null.
 */
export function hoursBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null
  const a = parseTimeOfDay(start)
  const b = parseTimeOfDay(end)
  if (a == null || b == null || b <= a) return null
  return (b - a) / 3600
}

export function parseTimeOfDay(t: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || s > 59) return null
  return h * 3600 + min * 60 + s
}

export function formatTimeOfDay(t: string): string {
  const seconds = parseTimeOfDay(t)
  if (seconds == null) return t
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour12}:00 ${period}` : `${hour12}:${m.toString().padStart(2, '0')} ${period}`
}

/**
 * "EPS — east elevation" / "EPS · 1,284 sqft" style label. Falls back
 * to just the service-item code when no elevation tag is set, and
 * returns null when no scope link exists (the card hides the line).
 */
export function takeoffScopeLabel(s: CrewScheduleRow): string | null {
  if (!s.takeoff_measurement_id) return null
  const code = s.takeoff_service_item_code ?? ''
  const elev = s.takeoff_elevation?.trim() ?? ''
  if (code && elev) return `${code} — ${elev}`
  if (code) return code
  if (elev) return elev
  return null
}

export function ScheduleCard({ schedule, workerById }: { schedule: CrewScheduleRow; workerById: Map<string, Worker> }) {
  const crewIds = Array.isArray(schedule.crew)
    ? (schedule.crew as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const accent = colorForProject(schedule.project_name ?? schedule.project_id)
  const scopeLabel = takeoffScopeLabel(schedule)
  const hours = hoursBetween(schedule.start_time, schedule.end_time)
  const crewHours = hours != null ? hours * crewIds.length : null
  const timeRange =
    schedule.start_time && schedule.end_time
      ? `${formatTimeOfDay(schedule.start_time)} – ${formatTimeOfDay(schedule.end_time)}`
      : null
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="h-1" style={{ background: accent }} />
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate">{schedule.project_name ?? 'Project'}</div>
            {scopeLabel ? <div className="text-[12px] text-ink-2 mt-0.5 truncate">{scopeLabel}</div> : null}
            {timeRange ? <div className="font-mono tabular-nums text-[12px] text-ink-3 mt-0.5">{timeRange}</div> : null}
          </div>
          <Pill tone={schedule.status === 'confirmed' ? 'good' : 'warn'}>{schedule.status}</Pill>
        </div>
        <div className="flex items-center justify-between mt-3 gap-2">
          <div className="flex min-w-0">
            {crewIds.slice(0, 5).map((id, i) => {
              const w = workerById.get(id)
              return (
                <div
                  key={id}
                  className="w-7 h-7 rounded-full bg-card-soft border-2 border-bg text-[10px] font-semibold flex items-center justify-center text-ink-2"
                  style={{ marginLeft: i === 0 ? 0 : -8 }}
                >
                  {w ? initials(w.name) : '?'}
                </div>
              )
            })}
            {crewIds.length > 5 ? (
              <div
                className="w-7 h-7 rounded-full bg-card-soft border-2 border-bg text-[10px] font-semibold flex items-center justify-center text-ink-3"
                style={{ marginLeft: -8 }}
              >
                +{crewIds.length - 5}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-mono tabular-nums text-[12px] text-ink-2">
              {crewIds.length} crew{crewHours != null ? ` · ${crewHours.toFixed(1)}h` : ''}
            </span>
            <Link to={`/projects/${schedule.project_id}?tab=schedule`} className="text-[12px] text-accent font-medium">
              Open ›
            </Link>
          </div>
        </div>
      </div>
    </Card>
  )
}

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { useClockTimeline } from '@/lib/api'
import {
  formatDecimalHours,
  pairClockSpans,
  startOfDay,
  startOfWeek,
  sumHoursInRange,
} from '@/lib/clock-derive'

/**
 * `wk-hours` — read-only personal pay-period summary.
 *
 * Phase 1D.2 derives totals from /api/clock/timeline (no aggregate
 * endpoint yet). Pay-period defaults to the current Mon–Sun week;
 * Phase 5 will let it follow the company's actual pay schedule when
 * payroll cohort stats land.
 *
 * The OT and burden columns the design shows ("2.5 OT", "GPS approved"
 * anomaly chips) are a Phase 1D.4 wiring on top of time_review_runs.
 */
export function WorkerHoursScreen() {
  const [view, setView] = useState<'hours' | 'week'>('hours')
  return (
    <div className="flex flex-col">
      <div className="px-5 pt-8 pb-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Worker · Time</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">
          {view === 'hours' ? 'My hours' : 'My week'}
        </h1>
        <div className="text-[12px] text-ink-3 mt-1">{formatPeriodLabel()}</div>
      </div>

      {/* Sub-toggle within the Time tab — hours vs week breakdown. */}
      <div className="px-4 pb-3">
        <div className="inline-flex p-1 bg-card-soft rounded-full border border-line">
          <button
            type="button"
            onClick={() => setView('hours')}
            className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
              view === 'hours' ? 'bg-bg text-ink shadow-1' : 'text-ink-3'
            }`}
          >
            Hours
          </button>
          <button
            type="button"
            onClick={() => setView('week')}
            className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
              view === 'week' ? 'bg-bg text-ink shadow-1' : 'text-ink-3'
            }`}
          >
            Week
          </button>
        </div>
      </div>

      <div className="px-4">{view === 'hours' ? <HoursView /> : <WeekView />}</div>
    </div>
  )
}

function HoursView() {
  const todayIso = new Date().toISOString().slice(0, 10)
  const timeline = useClockTimeline({ date: todayIso })
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])

  const nowMs = Date.now()
  const todayMs = startOfDay(nowMs)
  const weekMs = startOfWeek(nowMs)
  const todayHours = useMemo(() => sumHoursInRange(spans, todayMs, todayMs + 24 * 3600 * 1000, nowMs), [spans, todayMs, nowMs])
  const weekHours = useMemo(() => sumHoursInRange(spans, weekMs, nowMs + 24 * 3600 * 1000, nowMs), [spans, weekMs, nowMs])

  return (
    <div className="space-y-3">
      <Card>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">This week</div>
        <div className="num font-display text-[42px] font-bold tracking-tight leading-none mt-2">
          {weekHours.toFixed(1)}
        </div>
        <div className="text-[12px] text-ink-3 mt-1">hours so far</div>
        <div className="mt-4 h-1.5 bg-line rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full"
            style={{ width: `${Math.min(100, (weekHours / 40) * 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-ink-3 mt-1.5">
          <span>0</span>
          <span>40h</span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Today</div>
          <div className="num text-[22px] font-semibold mt-1">{formatDecimalHours(todayHours)}</div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Pay period</div>
          <div className="num text-[22px] font-semibold mt-1">{formatDecimalHours(weekHours)}</div>
          <div className="text-[11px] text-ink-3 mt-1">closes Sun</div>
        </Card>
      </div>

      <Card tight>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12px] font-semibold">Anomalies</div>
            <div className="text-[11px] text-ink-3">Phase 5 cohort model surfaces here</div>
          </div>
          <Pill tone="default">none</Pill>
        </div>
      </Card>

      <div className="text-[12px] text-ink-3 text-center pt-2">
        See a difference?{' '}
        <Link to="/" className="text-accent font-medium">
          Flag a problem
        </Link>
      </div>
    </div>
  )
}

function WeekView() {
  const todayIso = new Date().toISOString().slice(0, 10)
  const timeline = useClockTimeline({ date: todayIso })
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])
  const nowMs = Date.now()
  const weekStart = startOfWeek(nowMs)

  // 7 day rows: Mon…Sun.
  const days = Array.from({ length: 7 }, (_, i) => {
    const dayStart = weekStart + i * 24 * 3600 * 1000
    const dayEnd = dayStart + 24 * 3600 * 1000
    const hours = sumHoursInRange(spans, dayStart, dayEnd, nowMs)
    const date = new Date(dayStart)
    return {
      label: date.toLocaleDateString(undefined, { weekday: 'short' }),
      dayNum: date.getDate(),
      hours,
      isToday: dayStart <= nowMs && nowMs < dayEnd,
      isFuture: dayStart > nowMs,
    }
  })

  return (
    <Card>
      <ul className="divide-y divide-line">
        {days.map((day) => (
          <li key={day.label + day.dayNum} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
            <div className="flex items-baseline gap-3">
              <div className="w-10 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{day.label}</div>
              <div className="num text-[16px] font-medium">{day.dayNum}</div>
              {day.isToday ? <Pill tone="accent">today</Pill> : null}
            </div>
            <div className="num text-[14px] font-medium text-ink-2">
              {day.isFuture ? '—' : formatDecimalHours(day.hours)}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function formatPeriodLabel(): string {
  const start = new Date(startOfWeek(Date.now()))
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `Pay period · ${fmt(start)} – ${fmt(end)}`
}

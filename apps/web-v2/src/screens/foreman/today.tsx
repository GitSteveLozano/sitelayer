import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, PhoneTopBar, Pill } from '@/components/mobile'
import { Attribution, Spark, StripeCard } from '@/components/ai'
import {
  useClockTimeline,
  useSchedules,
  useWorkers,
  type ClockEvent,
  type CrewScheduleRow,
  type Worker,
} from '@/lib/api'
import { findOpenSpan, formatHms, pairClockSpans, startOfDay, sumHoursInRange } from '@/lib/clock-derive'

/**
 * `fm-today-v2` — Foreman home with the WTD-burden card variant.
 *
 * Real wiring:
 *   - Today's clock events drive the running roster (open spans = on
 *     site right now). Refetches every 30s.
 *   - Workers join: per-event worker_id is resolved against /api/workers
 *     so each crew row shows the actual name + role.
 *   - Today's crew_schedules: pulls company-wide schedules via
 *     GET /api/schedules?from=today&to=today; renders confirmed +
 *     drafted scoped to the day.
 *
 * Still placeholders:
 *   - Burden $-figure on the dark card (lands with 1E.5 labor_burden
 *     rollup).
 */
export function ForemanTodayScreen() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })
  const workersQuery = useWorkers()
  const schedules = useSchedules({ from: todayIso, to: todayIso })

  const events = timeline.data?.events ?? []
  const workers = workersQuery.data?.workers ?? []
  const todaySchedules = schedules.data?.schedules ?? []

  // Worker name lookup — O(1) name resolution for the crew rows.
  const workerById = useMemo(() => {
    const m = new Map<string, Worker>()
    for (const w of workers) m.set(w.id, w)
    return m
  }, [workers])

  // Group events by worker so each crew row is a person, not a span.
  const perWorker = useMemo(() => {
    const m = new Map<string, ClockEvent[]>()
    for (const e of events) {
      if (!e.worker_id) continue
      const list = m.get(e.worker_id) ?? []
      list.push(e)
      m.set(e.worker_id, list)
    }
    return m
  }, [events])

  // Build the crew rows: every worker with activity today, plus the
  // workers scheduled for today's project even if they haven't clocked
  // in yet.
  type CrewRow = { worker: Worker; openIn: ReturnType<typeof findOpenSpan>; totalHours: number }
  const crewRows: CrewRow[] = useMemo(() => {
    const ids = new Set<string>(perWorker.keys())
    for (const sched of todaySchedules) {
      if (Array.isArray(sched.crew)) {
        for (const id of sched.crew as unknown[]) {
          if (typeof id === 'string') ids.add(id)
        }
      }
    }
    const rows: CrewRow[] = []
    for (const id of ids) {
      const worker = workerById.get(id)
      if (!worker) continue
      const wEvents = perWorker.get(id) ?? []
      const spans = pairClockSpans(wEvents)
      const open = findOpenSpan(spans)
      const total = spans.reduce((sum, s) => sum + s.hours, 0)
      rows.push({ worker, openIn: open, totalHours: total })
    }
    // Sort: on-site first, then highest hours.
    rows.sort((a, b) => {
      if ((a.openIn !== null) !== (b.openIn !== null)) return a.openIn ? -1 : 1
      return b.totalHours - a.totalHours
    })
    return rows
  }, [workerById, perWorker, todaySchedules])

  const onSiteCount = crewRows.filter((r) => r.openIn !== null).length
  const nowMs = Date.now()
  const todayMs = startOfDay(nowMs)
  const allSpans = useMemo(() => pairClockSpans(events), [events])
  const totalCrewHours = sumHoursInRange(allSpans, todayMs, todayMs + 24 * 3600 * 1000, nowMs)

  return (
    <div className="flex flex-col">
      <PhoneTopBar activeProject={onSiteCount > 0 ? 'On site' : null} />

      <div className="px-5 pt-2 pb-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman</div>
        <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">Today</h1>
        <div className="text-[13px] text-ink-2 mt-1">
          {formatTodayLabel(nowMs)} · {onSiteCount} on site
        </div>
      </div>

      {/* Today's burden — dark card. $-figure lands with 1E.5. */}
      <div className="px-4 pb-3">
        <div className="rounded-[14px] bg-ink text-[#f3ecdf] p-4">
          <div className="flex items-baseline justify-between mb-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[#aea69a]">
              Today's burden so far
            </span>
            <span className="text-[10px] font-semibold text-[#7adba0]">● live</span>
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <div className="num text-[28px] font-bold tracking-tight leading-none">$—</div>
              <div className="num text-[11px] text-[#aea69a] mt-1">
                {totalCrewHours.toFixed(1)} crew-hrs · loaded $/hr lands in 1E.5
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] text-[#aea69a]">target</div>
              <div className="num text-[11px] text-[#aea69a] mt-0.5">— budget</div>
            </div>
          </div>
          <div className="mt-3 text-[10px] text-[#8a8278] flex items-center gap-1.5">
            <Spark state="dim" size={10} aria-label="" />
            Burden $-figure lands with labor_burden rollup
          </div>
        </div>
      </div>

      {/* Crew check-in — real clock state + worker names. */}
      <div className="px-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
          Crew check-in
        </div>
        <Card className="!p-0 overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between border-b border-line">
            <span className="text-[13px] font-semibold">Today's roster</span>
            <Pill tone="good" withDot>
              {onSiteCount} on site
            </Pill>
          </div>
          {crewRows.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-ink-3 text-center">
              No crew activity yet today.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {crewRows.slice(0, 8).map((row) => (
                <li key={row.worker.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Avatar name={row.worker.name} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{row.worker.name}</div>
                      <div className="text-[11px] text-ink-3">{row.worker.role}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    {row.openIn ? (
                      <>
                        <div className="num text-[13px] font-medium">{formatHms(row.openIn.hours)}</div>
                        <Pill tone="good" withDot>
                          on
                        </Pill>
                      </>
                    ) : row.totalHours > 0 ? (
                      <span className="num text-[13px] font-medium text-ink-2">
                        {row.totalHours.toFixed(1)}h
                      </span>
                    ) : (
                      <span className="text-[11px] text-ink-3">scheduled</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="mt-2 px-1">
          <Attribution source="Live from /api/clock/timeline + /api/workers" />
        </div>
      </div>

      {/* Quick actions. */}
      <div className="px-4 mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">Quick</div>
        <div className="grid grid-cols-2 gap-2.5">
          <ActionTile to="/time" label="Crew time" detail={`${crewRows.length} entries`} />
          <ActionTile to="/" label="Crew map" detail="live pins · soon" disabled />
          <ActionTile to="/log" label="Daily log" detail="photos + notes" highlight />
          <ActionTile to="/" label="Materials" detail="request" disabled />
        </div>
      </div>

      {/* Today's schedule — real crew_schedules. */}
      <div className="px-4 mt-5 pb-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
          Today's schedule
        </div>
        {todaySchedules.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No schedules for today.</div>
            <div className="text-[11px] text-ink-3 mt-1">
              Office adds entries via the Projects → Schedule sub-tab.
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {todaySchedules.map((sched) => (
              <ScheduleRow key={sched.id} schedule={sched} workerById={workerById} />
            ))}
            <div className="px-1 pt-1">
              <Attribution source="Live from /api/schedules" />
            </div>
          </div>
        )}
      </div>

      {/* End-of-day daily log entry. */}
      <div className="px-4 pb-8">
        <Link to="/log" className="block">
          <MobileButton variant="primary">End of day → Daily log</MobileButton>
        </Link>
      </div>
    </div>
  )
}

interface ScheduleRowProps {
  schedule: CrewScheduleRow
  workerById: Map<string, Worker>
}

function ScheduleRow({ schedule, workerById }: ScheduleRowProps) {
  const crewIds = Array.isArray(schedule.crew) ? (schedule.crew as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const crewNames = crewIds.map((id) => workerById.get(id)?.name ?? 'Unknown').slice(0, 4)
  return (
    <StripeCard tone={schedule.status === 'confirmed' ? 'good' : 'accent'}>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{schedule.project_name ?? 'Project'}</div>
          <div className="text-[11px] text-ink-3 mt-0.5 truncate">
            {crewIds.length} crew · {crewNames.join(', ') || 'unassigned'}
          </div>
        </div>
        <Pill tone={schedule.status === 'confirmed' ? 'good' : 'warn'}>{schedule.status}</Pill>
      </div>
    </StripeCard>
  )
}

interface ActionTileProps {
  to: string
  label: string
  detail: string
  highlight?: boolean
  disabled?: boolean
}

function ActionTile({ to, label, detail, highlight, disabled }: ActionTileProps) {
  const inner = (
    <Card
      tight
      className={`!flex !flex-col !items-start !gap-1.5 ${disabled ? 'opacity-60' : 'active:bg-card-soft'}`}
    >
      <div className={`text-[13px] font-semibold ${highlight ? 'text-accent' : ''}`}>{label}</div>
      <div className="text-[11px] text-ink-3">{detail}</div>
    </Card>
  )
  if (disabled) {
    return <div aria-disabled="true">{inner}</div>
  }
  return <Link to={to}>{inner}</Link>
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <div className="w-9 h-9 rounded-full bg-accent-soft text-accent-ink text-[12px] font-semibold inline-flex items-center justify-center shrink-0">
      {initials}
    </div>
  )
}

function formatTodayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

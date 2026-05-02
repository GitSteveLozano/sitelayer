import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  useClockTimeline,
  useDailyLogs,
  useLaborBurdenToday,
  useProject,
  useSchedules,
  type ProjectDetail,
} from '@/lib/api'
import { findOpenSpan, pairClockSpans, sumHoursInRange, startOfDay } from '@/lib/clock-derive'
import { EstimateSummaryScreen } from './estimate-summary'
import { TakeoffHubScreen } from './takeoff-hub'

/**
 * `prj-detail` shell — header + sub-tab nav + per-sub-tab content.
 *
 * Sub-tabs from `Sitemap.html` § 02:
 *   - Overview (default) — KPI tiles + open-log card
 *   - Takeoff — links into the polygon canvas + summary
 *   - Schedule — sub-list of upcoming crew assignments for this project
 *   - Time — burden detail with stacked-bar per-worker breakdown
 *
 * Sub-tab state lives in the `?tab=` query param so the back button
 * works the way users expect (browser history captures each tab
 * change).
 */
type SubTab = 'overview' | 'takeoff' | 'estimate' | 'schedule' | 'time'

const SUB_TABS: ReadonlyArray<{ key: SubTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'takeoff', label: 'Takeoff' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'time', label: 'Time' },
]

export function ProjectDetailScreen() {
  const params = useParams<{ id: string }>()
  const id = params.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as SubTab | null
  const tab: SubTab = tabParam && SUB_TABS.some((t) => t.key === tabParam) ? tabParam : 'overview'

  const project = useProject(id)
  const data = project.data?.project

  if (project.isPending) {
    return (
      <div className="px-5 pt-8">
        <div className="text-[13px] text-ink-3">Loading project…</div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="px-5 pt-8">
        <h1 className="font-display text-[24px] font-bold tracking-tight">Project not found</h1>
        <p className="text-[13px] text-ink-2 mt-2">
          <Link to="/projects" className="text-accent font-medium">
            ← back to projects
          </Link>
        </p>
      </div>
    )
  }

  const setTab = (next: SubTab) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('tab', next)
    setSearchParams(sp, { replace: true })
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          {data.customer_name ?? 'No customer'}
          {data.division_code ? ` · ${data.division_code}` : ''}
        </div>
        <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">{data.name}</h1>
        <div className="mt-2 flex items-center gap-2">
          <Pill tone={data.status === 'active' ? 'good' : data.status === 'completed' ? 'default' : 'warn'}>
            {data.status}
          </Pill>
          {Number(data.bid_total) > 0 ? (
            <span className="num text-[12px] text-ink-3">${Number(data.bid_total).toLocaleString()} bid</span>
          ) : null}
        </div>
      </div>

      {/* Sub-tab strip */}
      <div className="px-4 border-b border-line">
        <div className="flex gap-1">
          {SUB_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`relative flex-1 py-3 text-[13px] font-medium ${tab === t.key ? 'text-ink' : 'text-ink-3'}`}
            >
              {t.label}
              {tab === t.key ? (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-4 pb-8">
        {tab === 'overview' ? <OverviewTab project={data} /> : null}
        {tab === 'takeoff' ? <TakeoffHubScreen projectId={data.id} /> : null}
        {tab === 'estimate' ? <EstimateSummaryScreen projectId={data.id} /> : null}
        {tab === 'schedule' ? <SchedulePreview projectId={data.id} /> : null}
        {tab === 'time' ? <TimePreview projectId={data.id} /> : null}
      </div>
    </div>
  )
}

function OverviewTab({ project }: { project: ProjectDetail }) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso })
  const events = (timeline.data?.events ?? []).filter((e) => e.project_id === project.id)
  const spans = pairClockSpans(events)
  const open = findOpenSpan(spans)
  const totalHoursToday = sumHoursInRange(
    spans,
    startOfDay(Date.now()),
    startOfDay(Date.now()) + 24 * 3600 * 1000,
    Date.now(),
  )

  const drafts = useDailyLogs({ projectId: project.id, status: 'draft' })

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5">
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">On site now</div>
          <div className="num text-[22px] font-semibold mt-1">{open ? 1 : 0}</div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Hours today</div>
          <div className="num text-[22px] font-semibold mt-1">{totalHoursToday.toFixed(1)}h</div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Daily budget</div>
          <div className="num text-[22px] font-semibold mt-1">
            {project.daily_budget_cents > 0 ? `$${(project.daily_budget_cents / 100).toLocaleString()}` : '—'}
          </div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Geofence</div>
          <div className="num text-[22px] font-semibold mt-1">
            {project.site_radius_m ? `${project.site_radius_m}m` : '—'}
          </div>
          <div className="text-[11px] text-ink-3 mt-1">
            {project.auto_clock_in_enabled ? 'auto-clock on' : 'reminder only'}
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[13px] font-semibold">Open daily logs</div>
          <Pill tone={drafts.data?.dailyLogs.length ? 'warn' : 'default'}>
            {drafts.data?.dailyLogs.length ?? 0} draft{drafts.data?.dailyLogs.length === 1 ? '' : 's'}
          </Pill>
        </div>
        <div className="text-[12px] text-ink-3">
          {drafts.data?.dailyLogs.length
            ? 'Foreman has unsubmitted logs for this project.'
            : 'All foreman logs submitted to date.'}
        </div>
      </Card>

      <Attribution source="Live from /api/clock/timeline + /api/daily-logs" />

      <div className="grid grid-cols-2 gap-2.5 pt-2">
        <Link to="/log" className="block">
          <MobileButton variant="primary">Open daily log</MobileButton>
        </Link>
        <Link to={`/projects/${project.id}/setup`} className="block">
          <MobileButton variant="ghost">Project setup</MobileButton>
        </Link>
      </div>
      <div className="pt-1">
        <Link to={`/projects/${project.id}/rental-contract`} className="block">
          <MobileButton variant="ghost">Rental contract</MobileButton>
        </Link>
      </div>
    </div>
  )
}

function SchedulePreview({ projectId }: { projectId: string }) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const schedules = useSchedules({ from: todayIso })
  const projectSchedules = (schedules.data?.schedules ?? []).filter((s) => s.project_id === projectId)
  return (
    <div className="space-y-2">
      {projectSchedules.length === 0 ? (
        <Card tight>
          <div className="text-[13px] font-semibold">No upcoming schedules</div>
          <div className="text-[11px] text-ink-3 mt-1">
            Add a crew assignment via the Schedule tab — it'll show up here for the project.
          </div>
          <div className="mt-2.5">
            <Link to="/schedule" className="text-[12px] text-accent font-medium">
              Open Schedule →
            </Link>
          </div>
        </Card>
      ) : (
        projectSchedules.map((s) => (
          <Card key={s.id} tight>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">{formatScheduleDate(s.scheduled_for)}</div>
                <div className="text-[11px] text-ink-3 mt-0.5">
                  {Array.isArray(s.crew) ? (s.crew as unknown[]).length : 0} crew
                </div>
              </div>
              <Pill tone={s.status === 'confirmed' ? 'good' : 'warn'}>{s.status}</Pill>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}

/**
 * Project Time-tab burden card — Sitemap §8 panel 3 ("Labor burden").
 * Big total, stacked-segment bar showing each worker's contribution,
 * then a per-worker list with hours + amount.
 *
 * Each worker gets a deterministic accent shade so the segment in the
 * bar lines up with the row underneath without legend gymnastics.
 */
function TimePreview({ projectId }: { projectId: string }) {
  const burden = useLaborBurdenToday({ projectId })
  const data = burden.data
  if (burden.isPending || !data) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">Loading burden…</div>
      </Card>
    )
  }
  const total = data.total_cents
  const sortedWorkers = [...data.per_worker].sort((a, b) => b.total_cents - a.total_cents)
  const segmentColor = (i: number): string => BURDEN_PALETTE[i % BURDEN_PALETTE.length] ?? BURDEN_PALETTE[0]!
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Burden today</div>
      <div className="font-mono tabular-nums text-[28px] font-bold tracking-tight leading-none mt-1">
        ${(total / 100).toFixed(2)}
      </div>
      <div className="text-[11px] text-ink-3 mt-1">
        {data.total_hours.toFixed(1)} crew-hrs · {sortedWorkers.length} worker
        {sortedWorkers.length === 1 ? '' : 's'}
        {data.total_ot_hours > 0 ? ` · ${data.total_ot_hours.toFixed(1)} OT` : ''}
      </div>
      {sortedWorkers.length > 0 ? (
        <div className="mt-3 flex h-2 rounded-full overflow-hidden" aria-hidden="true">
          {sortedWorkers.map((w, i) => {
            const pct = total > 0 ? (w.total_cents / total) * 100 : 0
            return <span key={w.worker_id} style={{ width: `${pct}%`, background: segmentColor(i) }} />
          })}
        </div>
      ) : null}
      {data.total_budget_cents > 0 ? (
        <div className="font-mono tabular-nums text-[11px] text-ink-3 mt-2">
          {(data.burden_pct_of_budget * 100).toFixed(0)}% of ${(data.total_budget_cents / 100).toLocaleString()} budget
        </div>
      ) : (
        <div className="text-[11px] text-ink-3 mt-2">No daily budget set on this project.</div>
      )}
      {sortedWorkers.length > 0 ? (
        <ul className="mt-3 divide-y divide-line">
          {sortedWorkers.map((w, i) => (
            <li key={w.worker_id} className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden="true"
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ background: segmentColor(i) }}
                />
                <span className="text-[12px] text-ink-2 font-mono tabular-nums">
                  {(w.straight_hours + w.ot_hours).toFixed(1)}h
                </span>
                <span className="text-[12px] text-ink-3 truncate">
                  {w.ot_hours > 0 ? `incl ${w.ot_hours.toFixed(1)} OT` : 'straight'}
                </span>
              </div>
              <span className="font-mono tabular-nums text-[12px] font-medium shrink-0">
                ${(w.total_cents / 100).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3">
        <Attribution source="Live from /api/labor-burden/today?project_id=…" />
      </div>
    </Card>
  )
}

/**
 * Six-stop accent ramp so the stacked-bar segments stay visually
 * distinct without falling out of the warm-sand palette. Sourced from
 * the design's accent + semantic ramp.
 */
const BURDEN_PALETTE = [
  'var(--m-accent)',
  'var(--m-accent-ink)',
  'var(--m-blue)',
  'var(--m-green)',
  'var(--m-amber)',
  'var(--m-red)',
] as const

function formatScheduleDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

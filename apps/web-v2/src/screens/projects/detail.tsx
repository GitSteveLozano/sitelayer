import { useMemo } from 'react'
import { Link, useParams, useSearchParams, NavLink } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution, Spark } from '@/components/ai'
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
 *   - Overview (default) — wired below in 2B
 *   - Takeoff — Phase 3 lands the canvas; placeholder until then
 *   - Schedule — links to `/projects/:id` schedule sub-tab; full
 *     calendar lands in 2D
 *   - Time — pulls live-vs-budget from /api/labor-burden/today scoped
 *     to the project; full burden detail (t-burden) is Phase 5
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
  const totalHoursToday = sumHoursInRange(spans, startOfDay(Date.now()), startOfDay(Date.now()) + 24 * 3600 * 1000, Date.now())

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
    </div>
  )
}

function TakeoffPlaceholder() {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <Spark state="muted" size={12} aria-label="" />
        <div className="text-[13px] font-semibold">Takeoff canvas</div>
      </div>
      <div className="text-[12px] text-ink-2 leading-relaxed">
        Phase 3 lands the polygon canvas, multi-condition takeoff, scale calibration, and the takeoff →
        QBO sqft bridge. The Overview totals here reflect submitted measurements once Phase 3 ships.
      </div>
    </Card>
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
          <div className="text-[12px] text-ink-3">No upcoming schedules.</div>
          <div className="text-[11px] text-ink-3 mt-1">
            Phase 2D adds a per-project schedule sub-tab with the day stream + week grid.
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
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Burden today</div>
      <div className="num text-[26px] font-bold tracking-tight mt-1">${(data.total_cents / 100).toFixed(2)}</div>
      <div className="text-[11px] text-ink-3 mt-1">
        {data.total_hours.toFixed(1)} crew-hrs · {data.per_worker.length} worker
        {data.per_worker.length === 1 ? '' : 's'}
      </div>
      {data.total_budget_cents > 0 ? (
        <div className="text-[11px] text-ink-3 mt-1">
          {(data.burden_pct_of_budget * 100).toFixed(0)}% of $
          {(data.total_budget_cents / 100).toLocaleString()} budget
        </div>
      ) : (
        <div className="text-[11px] text-ink-3 mt-1">No daily budget set on this project.</div>
      )}
      <div className="mt-3">
        <Attribution source="Live from /api/labor-burden/today?project_id=…" />
      </div>
    </Card>
  )
}

function formatScheduleDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

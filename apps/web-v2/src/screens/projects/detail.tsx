import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BurdenHeroCard, Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { TopAppBar } from '@/components/nav/TopAppBar'
import { NavDrawer } from '@/components/nav/NavDrawer'
import { ProjectSwitcherSheet } from '@/components/nav/ProjectSwitcherSheet'
import { CleanBulkCard, TimeReviewRunCard } from '@/components/time-review'
import { useCurrentProjectId } from '@/lib/current-project'
import {
  useClockTimeline,
  useDailyLogs,
  useLaborBurdenToday,
  useProject,
  useProjectSummary,
  useSchedules,
  useTimeReviewRuns,
  type ProjectDetail,
} from '@/lib/api'
import { findOpenSpan, pairClockSpans, sumHoursInRange, startOfDay } from '@/lib/clock-derive'
import { EstimateSummaryScreen } from './estimate-summary'
import { TakeoffListScreen } from './takeoff-list'

/**
 * `prj-detail` shell — top app bar + sub-tab nav + per-sub-tab content.
 *
 * Sub-tabs (per the post-MVP IA — labor management is the per-project
 * Crew tab, not a top-level destination):
 *   - Overview — KPI tiles, open-log card, action grid
 *   - Estimate — scope-vs-bid, send sheet, push to QBO
 *   - Crew — approval queue scoped to this project, links to Burden /
 *            Vs plan; replaces the old "Time" sub-tab
 *   - Schedule — upcoming crew assignments
 *
 * Takeoff is reachable via `?tab=takeoff` (preserved so existing
 * deep links and the takeoff sub-screens' back-links keep working)
 * and via the Takeoff button on Overview, but is intentionally not
 * in the visible tab strip.
 *
 * `?tab=time` is aliased to Crew for backward compatibility — old
 * bookmarks land on the new tab without a redirect round-trip.
 *
 * Sub-tab state lives in the `?tab=` query param so the back button
 * works the way users expect.
 */
type SubTab = 'overview' | 'takeoff' | 'estimate' | 'schedule' | 'crew'

const VALID_SUB_TABS: ReadonlySet<SubTab> = new Set(['overview', 'takeoff', 'estimate', 'schedule', 'crew'])

const VISIBLE_SUB_TABS: ReadonlyArray<{ key: SubTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'crew', label: 'Crew' },
  { key: 'schedule', label: 'Schedule' },
]

function normalizeSubTab(raw: string | null): SubTab {
  if (raw === 'time') return 'crew'
  if (raw && (VALID_SUB_TABS as ReadonlySet<string>).has(raw)) return raw as SubTab
  return 'overview'
}

export function ProjectDetailScreen() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const id = params.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: SubTab = normalizeSubTab(searchParams.get('tab'))

  const [, setCurrentProjectId] = useCurrentProjectId()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const project = useProject(id)
  const data = project.data?.project

  // Pin the project the user is actively viewing as the "current"
  // one. The drawer header and More-tab user card key off this so
  // the project switcher always opens with the right context.
  useEffect(() => {
    if (data?.id) setCurrentProjectId(data.id)
  }, [data?.id, setCurrentProjectId])

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
      <TopAppBar
        eyebrow={
          <>
            {data.customer_name ?? 'No customer'}
            {data.division_code ? ` · ${data.division_code}` : ''}
          </>
        }
        title={data.name}
        showBack
        backTo="/projects"
        onSearch={() => navigate('/projects')}
        onOverflow={() => setDrawerOpen(true)}
      />

      {/* Sub-header KPI strip — restated under the bar so the page
          identity (status + bid) is visible without crowding the bar. */}
      <div className="px-5 pt-3 pb-2 flex items-center gap-2">
        <Pill tone={data.status === 'active' ? 'good' : data.status === 'completed' ? 'default' : 'warn'}>
          {data.status}
        </Pill>
        {Number(data.bid_total) > 0 ? (
          <span className="num text-[12px] text-ink-3">${Number(data.bid_total).toLocaleString()} bid</span>
        ) : null}
      </div>

      {/* Sub-tab strip — 4 visible tabs per Sitemap §02 panel 2 */}
      <div className="px-4 border-b border-line">
        <div className="flex gap-1">
          {VISIBLE_SUB_TABS.map((t) => (
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
        {tab === 'overview' ? <OverviewTab project={data} onOpenEstimate={() => setTab('estimate')} /> : null}
        {tab === 'takeoff' ? <TakeoffListScreen projectId={data.id} /> : null}
        {tab === 'estimate' ? <EstimateSummaryScreen projectId={data.id} /> : null}
        {tab === 'schedule' ? <SchedulePreview projectId={data.id} /> : null}
        {tab === 'crew' ? <CrewTab projectId={data.id} /> : null}
      </div>

      <NavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onAvatarTap={() => {
          setDrawerOpen(false)
          setSwitcherOpen(true)
        }}
      />
      <ProjectSwitcherSheet open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  )
}

function OverviewTab({ project, onOpenEstimate }: { project: ProjectDetail; onOpenEstimate: () => void }) {
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
  // Project-scoped burden — same hero card as fm-today, scoped via
  // project_id so it only sums clock spans for this site.
  const burden = useLaborBurdenToday({ projectId: project.id })

  return (
    <div className="space-y-3">
      <BurdenHeroCard burden={burden.data} label="Project burden today" />
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

      <ScopeProgressCard projectId={project.id} />

      <Attribution source="Live from /api/clock/timeline + /api/daily-logs" />

      <div className="grid grid-cols-2 gap-2.5 pt-2">
        <Link to="/log" className="block">
          <MobileButton variant="primary">Open daily log</MobileButton>
        </Link>
        <MobileButton variant="ghost" onClick={onOpenEstimate}>
          Open estimate
        </MobileButton>
      </div>
      <div className="grid grid-cols-2 gap-2.5 pt-1">
        {/* Takeoff stays one tap away from Overview now that the
            sub-tab strip is Overview / Estimate / Crew / Schedule —
            see the CLAUDE.md note on the IA reshuffle. */}
        <Link to={`/projects/${project.id}?tab=takeoff`} className="block">
          <MobileButton variant="ghost">Takeoff</MobileButton>
        </Link>
        <Link to={`/projects/${project.id}/setup`} className="block">
          <MobileButton variant="ghost">Project setup</MobileButton>
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-2.5 pt-1">
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
 * `prj-detail` Crew sub-tab — project-scoped flavor of the cross-project
 * approval queue. Shares the bulk-approve and per-run card components
 * from `@/components/time-review` so the cross-project queue and this
 * surface never drift.
 *
 * KPI strip surfaces what we already aggregate today (on-site count,
 * crew-hours today, pending review count). Week-to-date hours, loaded
 * cost vs plan, and pace are tracked in CLAUDE.md as a follow-on —
 * `useLaborBurdenToday` is today-only at the moment.
 *
 * Lunch / GPS-match / per-anomaly text from the design also need
 * schema extensions; this tab ships with the data we have and a calm
 * fallback in their place.
 */
function CrewTab({ projectId }: { projectId: string }) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso })
  const events = (timeline.data?.events ?? []).filter((e) => e.project_id === projectId)
  const spans = pairClockSpans(events)
  const open = findOpenSpan(spans)
  const onSiteNow = open ? 1 : 0
  const hoursToday = sumHoursInRange(
    spans,
    startOfDay(Date.now()),
    startOfDay(Date.now()) + 24 * 3600 * 1000,
    Date.now(),
  )

  // Project-scoped runs across all states so we can show both the
  // pending split (clean / needs review) and a tail of recently
  // approved/disputed without three queries.
  const runs = useTimeReviewRuns({ projectId })
  const all = runs.data?.timeReviewRuns ?? []
  const pending = all.filter((r) => r.state === 'pending')
  const cleanPending = pending.filter((r) => r.anomaly_count === 0)
  const reviewPending = pending.filter((r) => r.anomaly_count > 0)
  const recentDecided = all.filter((r) => r.state !== 'pending').slice(0, 3)
  const projectByIdEmpty = useMemo(() => new Map<string, never>(), [])

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2.5">
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">On site now</div>
          <div className="num text-[22px] font-semibold mt-1">{onSiteNow}</div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Hours today</div>
          <div className="num text-[22px] font-semibold mt-1">{hoursToday.toFixed(1)}h</div>
        </Card>
        <Card tight>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Pending</div>
          <div className="num text-[22px] font-semibold mt-1">{pending.length}</div>
          {pending.length > 0 ? (
            <div className="text-[10px] text-ink-3 mt-0.5">
              {reviewPending.length > 0 ? `${reviewPending.length} need review` : 'all clean'}
            </div>
          ) : null}
        </Card>
      </div>

      {runs.isPending ? (
        <Card tight>
          <div className="text-[12px] text-ink-3">Loading approvals…</div>
        </Card>
      ) : pending.length === 0 ? (
        <Card tight>
          <div className="text-[13px] font-semibold">Nothing waiting on you</div>
          <div className="text-[11px] text-ink-3 mt-1">
            New time-review runs land here as the foreman submits crew time for this project.
          </div>
        </Card>
      ) : (
        <>
          {cleanPending.length > 0 ? <CleanBulkCard runs={cleanPending} /> : null}
          {reviewPending.length > 0 ? (
            <>
              <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Needs review ({reviewPending.length})
              </div>
              {reviewPending.map((row) => (
                <TimeReviewRunCard key={row.id} row={row} projectById={projectByIdEmpty} hideProject />
              ))}
            </>
          ) : null}
        </>
      )}

      {recentDecided.length > 0 ? (
        <>
          <div className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Recent</div>
          {recentDecided.map((row) => (
            <TimeReviewRunCard key={row.id} row={row} projectById={projectByIdEmpty} hideProject />
          ))}
        </>
      ) : null}

      <Attribution source="Live from /api/time-review-runs?project_id=… + /api/clock/timeline" />

      <div className="grid grid-cols-2 gap-2.5 pt-2">
        <Link to="/time/burden" className="block">
          <MobileButton variant="ghost">Burden →</MobileButton>
        </Link>
        <Link to="/time/vs" className="block">
          <MobileButton variant="ghost">Vs plan →</MobileButton>
        </Link>
      </div>
    </div>
  )
}

function formatScheduleDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * `prj-overview-by-scope` from Sitemap §4 panel 4 ("Overview by scope").
 *
 * Per-scope progress bars: for each estimate line, % complete is the
 * sum of labor_entries.sqft_done where the service_item_code matches,
 * divided by the line's quantity. Labor without a sqft_done value
 * doesn't contribute (some scopes are billed by hours, not by area).
 *
 * Hides entirely when there are no scope items or no labor entries
 * (calm-by-default per AI Rules Law 03).
 */
function ScopeProgressCard({ projectId }: { projectId: string }) {
  const summary = useProjectSummary(projectId)
  const data = summary.data
  if (!data || data.estimateLines.length === 0) return null
  const laborByCode = new Map<string, number>()
  for (const e of data.laborEntries) {
    const code = e.service_item_code
    if (!code) continue
    const sqft = Number(e.sqft_done ?? 0)
    if (!Number.isFinite(sqft) || sqft <= 0) continue
    laborByCode.set(code, (laborByCode.get(code) ?? 0) + sqft)
  }
  // If nothing has sqft_done, the labor lookup is empty and every row
  // would render at 0% — calmer to hide the card.
  if (laborByCode.size === 0) return null
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-line text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        By scope
      </div>
      <ul className="divide-y divide-line">
        {data.estimateLines.map((line) => {
          const planned = Number(line.quantity)
          const done = laborByCode.get(line.service_item_code) ?? 0
          const pct = planned > 0 ? Math.min(1, done / planned) : 0
          const onTrack = pct >= 0.95 ? 'good' : 'accent'
          return (
            <li key={`${line.service_item_code}-${line.created_at}`} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <div className="text-[13px] font-semibold truncate">{line.service_item_code}</div>
                <div className="font-mono tabular-nums text-[12px] text-ink-2 shrink-0">
                  {done.toFixed(0)} / {planned.toFixed(0)} {line.unit}
                </div>
              </div>
              <div className="h-1.5 bg-card-soft rounded-full overflow-hidden">
                <div
                  className={onTrack === 'good' ? 'h-full bg-good' : 'h-full bg-accent'}
                  style={{ width: `${Math.max(2, pct * 100)}%` }}
                  aria-hidden="true"
                />
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px] text-ink-3">
                <span className="font-mono tabular-nums">{(pct * 100).toFixed(0)}%</span>
                <span>{onTrack === 'good' ? 'complete' : 'in progress'}</span>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="px-4 py-2 border-t border-line">
        <Attribution source="Computed from estimate_lines × labor_entries.sqft_done" />
      </div>
    </Card>
  )
}

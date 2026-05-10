import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BurdenHeroCard, Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { TopAppBar } from '@/components/nav/TopAppBar'
import { NavDrawer } from '@/components/nav/NavDrawer'
import { ProjectSwitcherSheet } from '@/components/nav/ProjectSwitcherSheet'
import { CleanBulkCard, TimeReviewRunCard } from '@/components/time-review'
import { useCurrentProjectId } from '@/lib/current-project'
import { useRole } from '@/lib/role'
import {
  useClockTimeline,
  useCreateTimeReviewRun,
  useDailyLogs,
  useLaborBurdenToday,
  useProject,
  useProjectSummary,
  useSchedules,
  useTimeReviewRuns,
  useWorkers,
  type ClockEvent,
  type ProjectDetail,
  type Worker,
} from '@/lib/api'
import { findOpenSpan, pairClockSpans, sumHoursInRange, startOfDay } from '@/lib/clock-derive'
import { BidAccuracyCard } from './bid-accuracy-card'
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
      {/* Bid-accuracy keystone — surfaced on the overview hero per
          `/tmp/sitelayer_design_stuff/ai-keystone.jsx`. The card
          self-hides via its dismissed state and renders a calm
          single-line placeholder when no comparable cohort exists. */}
      <BidAccuracyCard projectId={project.id} />
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
        {/* Measurements (formerly "Takeoff") stays one tap away from
            Overview now that the sub-tab strip is Overview / Estimate
            / Crew / Schedule — see the CLAUDE.md note on the IA
            reshuffle. */}
        <Link to={`/projects/${project.id}?tab=takeoff`} className="block">
          <MobileButton variant="ghost">Measurements</MobileButton>
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
  const role = useRole()
  // Foreman flavor is a different content shape entirely (dark
  // Today's-crew hero + per-worker In/Lunch/Out pills + Submit for
  // approval). Owner / admin / office land on the approval queue.
  if (role === 'foreman') return <ForemanCrewView projectId={projectId} />
  return <OwnerCrewView projectId={projectId} />
}

function OwnerCrewView({ projectId }: { projectId: string }) {
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

/**
 * Foreman flavor of the Crew sub-tab — dark "Today's crew" hero with
 * a Submit-for-approval CTA, plus per-worker cards showing In / Lunch
 * / Out for the day.
 *
 * Lunch is derived from the gap between consecutive in/out spans on
 * the same worker; we don't have a dedicated lunch event type yet, so
 * a single same-day return between an out and an in registers as
 * lunch, anything longer is shown as the literal break duration. Calm
 * fallback ("—") when only one span exists or the worker is still in.
 */
function ForemanCrewView({ projectId }: { projectId: string }) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso })
  const workers = useWorkers()
  const events = useMemo(
    () => (timeline.data?.events ?? []).filter((e) => e.project_id === projectId),
    [timeline.data, projectId],
  )
  const eventsByWorker = useMemo(() => groupEventsByWorker(events), [events])
  const workerById = useMemo(() => new Map((workers.data?.workers ?? []).map((w) => [w.id, w])), [workers.data])

  const perWorker = useMemo(() => {
    const out: Array<{ workerId: string; worker: Worker | null; rollup: WorkerDayRollup }> = []
    for (const [workerId, wEvents] of eventsByWorker) {
      out.push({ workerId, worker: workerById.get(workerId) ?? null, rollup: rollupWorkerDay(wEvents) })
    }
    return out.sort((a, b) => b.rollup.totalHours - a.rollup.totalHours)
  }, [eventsByWorker, workerById])

  const totals = useMemo(() => {
    const totalHours = perWorker.reduce((sum, p) => sum + p.rollup.totalHours, 0)
    const lunchMinutes = perWorker.reduce((sum, p) => sum + p.rollup.lunchMinutes, 0)
    const earliestIn = perWorker.reduce<number | null>((min, p) => {
      if (p.rollup.firstInMs == null) return min
      return min == null ? p.rollup.firstInMs : Math.min(min, p.rollup.firstInMs)
    }, null)
    const latestOut = perWorker.reduce<number | null>((max, p) => {
      if (p.rollup.lastOutMs == null) return max
      return max == null ? p.rollup.lastOutMs : Math.max(max, p.rollup.lastOutMs)
    }, null)
    return { totalHours, lunchMinutes, earliestIn, latestOut, crewSize: perWorker.length }
  }, [perWorker])

  const createRun = useCreateTimeReviewRun()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const onSubmit = async () => {
    setSubmitError(null)
    setSubmitSuccess(false)
    try {
      await createRun.mutateAsync({ project_id: projectId, period_start: todayIso, period_end: todayIso })
      setSubmitSuccess(true)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed')
    }
  }

  const dayLabel = useMemo(() => {
    const d = new Date(`${todayIso}T00:00:00`)
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }, [todayIso])

  return (
    <div className="space-y-3">
      <div className="text-[12px] text-ink-3 px-1">{dayLabel} · you're foreman of record</div>

      <div className="rounded-2xl bg-ink text-white p-4 shadow-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] opacity-70">Today's crew</div>
            <div className="font-mono tabular-nums text-[36px] font-bold tracking-tight leading-none mt-1">
              {totals.totalHours.toFixed(1)}h
            </div>
          </div>
          <MobileButton
            variant="primary"
            size="sm"
            onClick={onSubmit}
            disabled={createRun.isPending || perWorker.length === 0}
          >
            {createRun.isPending ? '…' : submitSuccess ? 'Submitted' : 'Submit for approval'}
          </MobileButton>
        </div>
        <div className="mt-3 text-[12px] opacity-80">
          {totals.crewSize} crew
          {totals.earliestIn != null && totals.latestOut != null
            ? ` · ${formatHm(totals.earliestIn)}–${formatHm(totals.latestOut)}`
            : ''}
          {totals.lunchMinutes > 0 ? ` · ${(totals.lunchMinutes / 60).toFixed(1)}h lunch` : ''}
        </div>
        {submitError ? <div className="mt-2 text-[12px] text-bad bg-bad-soft rounded p-2">{submitError}</div> : null}
        {submitSuccess && !submitError ? (
          <div className="mt-2 text-[11px] opacity-80">A new review run is now in the approver's queue.</div>
        ) : null}
      </div>

      <div className="px-1 pt-1 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          Crew ({perWorker.length})
        </span>
      </div>

      {timeline.isPending ? (
        <Card tight>
          <div className="text-[12px] text-ink-3">Loading crew…</div>
        </Card>
      ) : perWorker.length === 0 ? (
        <Card tight>
          <div className="text-[13px] font-semibold">No clock activity on this project today</div>
          <div className="text-[11px] text-ink-3 mt-1">
            Once the crew clocks in, In / Lunch / Out times appear here for review before submit.
          </div>
        </Card>
      ) : (
        perWorker.map(({ workerId, worker, rollup }) => (
          <ForemanWorkerCard key={workerId} worker={worker} workerId={workerId} rollup={rollup} />
        ))
      )}

      <Attribution source="Live from /api/clock/timeline (lunch derived from same-day in/out gap)" />
    </div>
  )
}

function ForemanWorkerCard({
  worker,
  workerId,
  rollup,
}: {
  worker: Worker | null
  workerId: string
  rollup: WorkerDayRollup
}) {
  const name = worker?.name ?? `Worker ${workerId.slice(0, 8)}…`
  const role = worker?.role ?? null
  return (
    <Card tight>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={name} />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold truncate">{name}</div>
            {role ? <div className="text-[11px] text-ink-3">{role}</div> : null}
          </div>
        </div>
        <div className="font-mono tabular-nums text-[18px] font-bold tracking-tight shrink-0">
          {rollup.totalHours.toFixed(1)}h
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <TimePill label="In" value={rollup.firstInMs != null ? formatHm(rollup.firstInMs) : '—'} />
        <TimePill
          label="Lunch"
          value={rollup.lunchMinutes > 0 ? `${rollup.lunchMinutes}m` : '—'}
          muted={rollup.lunchMinutes === 0}
        />
        <TimePill label="Out" value={rollup.lastOutMs != null ? formatHm(rollup.lastOutMs) : 'open'} />
      </div>
    </Card>
  )
}

function TimePill({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`rounded-md p-2 border ${muted ? 'bg-card-soft border-line' : 'bg-card border-line-2'}`}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className={`font-mono tabular-nums text-[14px] font-semibold mt-0.5 ${muted ? 'text-ink-3' : 'text-ink'}`}>
        {value}
      </div>
    </div>
  )
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

interface WorkerDayRollup {
  totalHours: number
  /** First clock-in of the day (ms epoch) or null. */
  firstInMs: number | null
  /** Last clock-out (ms epoch) or null when worker is still in. */
  lastOutMs: number | null
  /** Sum of gaps between consecutive in/out pairs on the same day, in minutes. */
  lunchMinutes: number
}

function groupEventsByWorker(events: ClockEvent[]): Map<string, ClockEvent[]> {
  const map = new Map<string, ClockEvent[]>()
  for (const e of events) {
    if (!e.worker_id) continue
    const list = map.get(e.worker_id) ?? []
    list.push(e)
    map.set(e.worker_id, list)
  }
  return map
}

/**
 * Roll an ordered event stream into a foreman-facing day summary.
 * `lunchMinutes` is the total gap-time between consecutive (out → in)
 * pairs — capturing the typical "step out for lunch, come back" flow.
 * Open spans (no closing out) cap totalHours at now() so the hero
 * ticks live.
 */
function rollupWorkerDay(events: ClockEvent[]): WorkerDayRollup {
  const sorted = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
  let totalMs = 0
  let lunchMs = 0
  let firstInMs: number | null = null
  let lastOutMs: number | null = null
  let openInMs: number | null = null
  let lastOutForLunchMs: number | null = null

  for (const e of sorted) {
    const ms = Date.parse(e.occurred_at)
    if (e.event_type === 'in') {
      if (firstInMs == null) firstInMs = ms
      if (lastOutForLunchMs != null) {
        lunchMs += Math.max(0, ms - lastOutForLunchMs)
        lastOutForLunchMs = null
      }
      if (openInMs != null) {
        // Implicit close — same rule as pairClockSpans.
        totalMs += Math.max(0, ms - openInMs)
      }
      openInMs = ms
      continue
    }
    // out / auto_out_geo / auto_out_idle
    if (openInMs != null) {
      totalMs += Math.max(0, ms - openInMs)
      openInMs = null
    }
    lastOutMs = ms
    lastOutForLunchMs = ms
  }
  if (openInMs != null) {
    totalMs += Math.max(0, Date.now() - openInMs)
    lastOutMs = null
  }

  return {
    totalHours: totalMs / (1000 * 60 * 60),
    firstInMs,
    lastOutMs,
    lunchMinutes: Math.round(lunchMs / (1000 * 60)),
  }
}

function formatHm(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
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

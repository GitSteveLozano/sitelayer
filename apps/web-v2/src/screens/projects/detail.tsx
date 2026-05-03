import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BurdenHeroCard, Card, MobileButton, Pill, useConfirmSheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { TopAppBar } from '@/components/nav/TopAppBar'
import { NavDrawer } from '@/components/nav/NavDrawer'
import { ProjectSwitcherSheet } from '@/components/nav/ProjectSwitcherSheet'
import { useCurrentProjectId } from '@/lib/current-project'
import {
  useClockTimeline,
  useDailyLogs,
  useLaborBurdenToday,
  usePatchProject,
  useProject,
  useProjectSummary,
  useSchedules,
  type ProjectDetail,
} from '@/lib/api'
import { findOpenSpan, pairClockSpans, sumHoursInRange, startOfDay } from '@/lib/clock-derive'
import { EstimateSummaryScreen } from './estimate-summary'
import { TakeoffListScreen } from './takeoff-list'

/**
 * `prj-detail` shell — top app bar + sub-tab nav + per-sub-tab content.
 *
 * Sub-tabs from `Sitemap.html` § 02 panel 2:
 *   - Overview (default) — KPI tiles + open-log card + estimate jump
 *   - Takeoff — links into the polygon canvas + summary
 *   - Schedule — sub-list of upcoming crew assignments for this project
 *   - Time — burden detail with stacked-bar per-worker breakdown
 *
 * Estimate is reachable via `?tab=estimate` (preserved so existing
 * deep links work) and via the "Open estimate" button on Overview,
 * but is intentionally not in the visible tab strip — the design
 * keeps the strip to the four operational views.
 *
 * Sub-tab state lives in the `?tab=` query param so the back button
 * works the way users expect.
 */
type SubTab = 'overview' | 'takeoff' | 'estimate' | 'schedule' | 'time'

const VALID_SUB_TABS: ReadonlySet<SubTab> = new Set(['overview', 'takeoff', 'estimate', 'schedule', 'time'])

const VISIBLE_SUB_TABS: ReadonlyArray<{ key: SubTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'takeoff', label: 'Takeoff' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'time', label: 'Time' },
]

export function ProjectDetailScreen() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const id = params.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as SubTab | null
  const tab: SubTab = tabParam && VALID_SUB_TABS.has(tabParam) ? tabParam : 'overview'

  const [, setCurrentProjectId] = useCurrentProjectId()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [confirmNode, askConfirm] = useConfirmSheet()

  const project = useProject(id)
  const data = project.data?.project
  const patchProject = usePatchProject(id ?? '')

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

  const archive = async () => {
    if (!data) return
    const ok = await askConfirm({
      title: 'Archive this project?',
      body: `Archived projects move out of the active list and skip future schedules. You can pull ${data.name} back to active any time from the Archive tab.`,
      confirmLabel: 'Archive',
      cancelLabel: 'Keep active',
      destructive: false,
    })
    if (!ok) return
    try {
      await patchProject.mutateAsync({ status: 'archived', expected_version: data.version })
      navigate('/projects', { replace: true })
    } catch {
      /* swallow — patch errors surface via toast in a later pass */
    }
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
        onOverflow={() => setOptionsOpen(true)}
      />

      {/* Hero header — Sitemap §04 panels 5/8/9 */}
      <ProjectHeroHeader project={data} />

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
        {tab === 'time' ? <TimePreview projectId={data.id} /> : null}
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
      <ProjectOptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onOpenDrawer={() => {
          setOptionsOpen(false)
          setDrawerOpen(true)
        }}
        onArchive={async () => {
          setOptionsOpen(false)
          await archive()
        }}
        canArchive={data.status !== 'archived'}
      />
      {confirmNode}
    </div>
  )
}

/**
 * Hero header — Sitemap §04 panels 5/8/9. Pulls bid_total to a
 * prominent number so the project's "scale" is visible the moment the
 * detail screen opens. Status pill and a contextual eyebrow ride
 * underneath; division/customer already live in the TopAppBar above.
 */
function ProjectHeroHeader({ project }: { project: ProjectDetail }) {
  const bid = Number(project.bid_total)
  const tone =
    project.status === 'active'
      ? 'good'
      : project.status === 'completed'
        ? 'default'
        : project.status === 'archived'
          ? 'default'
          : 'warn'
  const eyebrow =
    project.status === 'lead'
      ? 'Bid'
      : project.status === 'active'
        ? 'Contract'
        : project.status === 'completed'
          ? 'Closed'
          : 'Archived'
  return (
    <div className="px-5 pt-4 pb-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{eyebrow}</div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <div className="num font-display text-[34px] font-bold tracking-tight leading-none">
          {bid > 0 ? `$${bid.toLocaleString()}` : '—'}
        </div>
        <Pill tone={tone}>{project.status}</Pill>
      </div>
    </div>
  )
}

/**
 * Project overflow sheet — `⋯` from the TopAppBar opens this with a
 * short list of project-level actions. Keeps Archive (Sitemap §04
 * panel 12) discoverable without putting destructive options inline
 * on Overview.
 */
function ProjectOptionsSheet({
  open,
  onClose,
  onOpenDrawer,
  onArchive,
  canArchive,
}: {
  open: boolean
  onClose: () => void
  onOpenDrawer: () => void
  onArchive: () => void
  canArchive: boolean
}) {
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Project options"
      className="fixed inset-0 z-40 flex items-end bg-black/45"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full bg-bg rounded-t-[24px] pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] shadow-[0_-4px_24px_rgba(0,0,0,0.12)]">
        <div aria-hidden="true" className="w-9 h-1 bg-line-2 rounded-full mx-auto mb-2" />
        <div className="px-5 pt-1 pb-3 border-b border-line text-[18px] font-semibold tracking-tight">
          Project options
        </div>
        <div className="px-2 py-2">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="w-full text-left px-3 py-3 rounded-md text-[15px] hover:bg-card-soft active:bg-card-soft"
          >
            Open navigation
          </button>
          <button
            type="button"
            onClick={onArchive}
            disabled={!canArchive}
            className="w-full text-left px-3 py-3 rounded-md text-[15px] text-bad hover:bg-card-soft active:bg-card-soft disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Archive this project…
          </button>
        </div>
      </div>
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
      <ProjectProgressHero projectId={project.id} />
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
        <Link to={`/projects/${project.id}/setup`} className="block">
          <MobileButton variant="ghost">Project setup</MobileButton>
        </Link>
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

/**
 * `prj-progress-hero` — Sitemap §04 panel 10 ("Express progress").
 *
 * Aggregates the per-scope completion percentages from
 * `useProjectSummary` into a single project-wide % so the Overview
 * tab opens with a one-glance answer to "how done is this?".
 *
 * Math: weighted average across estimate_lines, weighted by quantity,
 * with completion = sum(labor.sqft_done where service_item_code = line.code) / line.quantity.
 * Lines without sqft_done contribute 0 weight (calm-by-default per AI
 * Rules Law 03 — surface-when-meaningful, not always).
 *
 * Hides entirely when there are no estimate lines or no labor with a
 * sqft_done value.
 */
function ProjectProgressHero({ projectId }: { projectId: string }) {
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
  if (laborByCode.size === 0) return null

  let totalPlanned = 0
  let totalDone = 0
  for (const line of data.estimateLines) {
    const planned = Number(line.quantity)
    if (!Number.isFinite(planned) || planned <= 0) continue
    const done = Math.min(planned, laborByCode.get(line.service_item_code) ?? 0)
    totalPlanned += planned
    totalDone += done
  }
  if (totalPlanned <= 0) return null
  const pct = totalDone / totalPlanned
  const tone = pct >= 0.95 ? 'good' : pct >= 0.5 ? 'accent' : 'accent'

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Progress</div>
          <div className="num text-[28px] font-semibold mt-0.5 leading-none">{(pct * 100).toFixed(0)}%</div>
        </div>
        <div className="text-[11px] text-ink-3 num tabular-nums text-right">
          {totalDone.toFixed(0)} / {totalPlanned.toFixed(0)}
          <div className="mt-0.5 text-ink-4">across {data.estimateLines.length} scopes</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 bg-card-soft rounded-full overflow-hidden">
        <div
          className={tone === 'good' ? 'h-full bg-good' : 'h-full bg-accent'}
          style={{ width: `${Math.max(2, pct * 100)}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-2">
        <Attribution source="Weighted across estimate_lines × labor_entries.sqft_done" />
      </div>
    </Card>
  )
}

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { BurdenHeroCard, Card, Kpi, MobileButton } from '@/components/mobile'
import { AgentSurface, Attribution } from '@/components/ai'
import {
  fetchLaborBurdenToday,
  laborBurdenQueryKeys,
  useProjects,
  type CrewScheduleRow,
  type LaborBurdenSummaryResponse,
  type ProjectListRow,
} from '@/lib/api'
import { fetchProjectSummaryForKpi, formatDollars } from './helpers'
import type { AttentionItem } from './attention-list'

// ---------------------------------------------------------------------------
// db-pm — busy-day dashboard
// ---------------------------------------------------------------------------

interface PmDashboardProps {
  workspaceBurden: LaborBurdenSummaryResponse | undefined
  schedules: CrewScheduleRow[]
  attention: AttentionItem[]
  reviewsCount: number
  onSiteCount: number
  totalHoursToday: number
}

/**
 * `db-pm` — denser layout for hands-on PMs. SNAPSHOT KPI row up top
 * (Active / On clock / Margin from `Sitemap.html` § 03 panel 1), then
 * an AgentSurface narrative card when something's on fire, then the
 * workspace BurdenHeroCard, the approval queue card, and per-active-
 * project burden rows.
 *
 * Pulls active projects via `useProjects({ status: 'active' })` rather
 * than relying on `crew_schedules` so a project still shows up here
 * even on a day with no scheduled crew (the office still wants to see
 * burn for it).
 */
export function PmDashboard({
  workspaceBurden,
  schedules,
  attention,
  reviewsCount,
  onSiteCount,
  totalHoursToday,
}: PmDashboardProps) {
  const projects = useProjects({ status: 'active' })
  const activeProjects = projects.data?.projects ?? []
  // Fan-out per-project burden so each row in the list shows real
  // dollars + budget pct. Throttled to 60s, same as the workspace one.
  const burdenQueries = useQueries({
    queries: activeProjects.map((p) => ({
      queryKey: laborBurdenQueryKeys.today({ projectId: p.id }),
      queryFn: () => fetchLaborBurdenToday({ projectId: p.id }),
      refetchInterval: 60_000 as const,
    })),
  })
  const scheduledIds = useMemo(() => new Set(schedules.map((s) => s.project_id)), [schedules])

  // Sort: scheduled-today first, then highest burden $.
  const rows = useMemo(() => {
    const merged = activeProjects.map((p, i) => ({
      project: p,
      burden: burdenQueries[i]?.data,
      scheduled: scheduledIds.has(p.id),
    }))
    merged.sort((a, b) => {
      if (a.scheduled !== b.scheduled) return a.scheduled ? -1 : 1
      const ac = a.burden?.total_cents ?? 0
      const bc = b.burden?.total_cents ?? 0
      return bc - ac
    })
    return merged
  }, [activeProjects, burdenQueries, scheduledIds])

  // Pick the most-over-budget active project for the AI narrative card.
  // Deterministic, no model needed — the framing matches the AgentSurface
  // contract (review-before-sending for ANY suggestion, even rule-based).
  const narrativeRow = useMemo(() => pickNarrativeRow(rows), [rows])

  // Workspace MARGIN — derived from active-project summaries in
  // parallel. Falls back to "—" when no project has a bid set.
  const summaryQueries = useQueries({
    queries: activeProjects.map((p) => ({
      queryKey: ['projects', 'summary', p.id] as const,
      queryFn: () => fetchProjectSummaryForKpi(p.id),
      staleTime: 60_000,
    })),
  })
  const marginPct = useMemo(() => {
    let revenue = 0
    let cost = 0
    for (const q of summaryQueries) {
      const m = q.data?.metrics?.margin
      if (!m) continue
      revenue += m.revenue ?? 0
      cost += m.cost ?? 0
    }
    if (revenue <= 0) return null
    return (revenue - cost) / revenue
  }, [summaryQueries])

  return (
    <div className="space-y-3">
      {/* SNAPSHOT KPI row — Sitemap §03 panel 1 */}
      <div className="grid grid-cols-3 gap-2">
        <Kpi
          label="Active"
          value={activeProjects.length.toString()}
          meta={schedules.length > 0 ? `${schedules.length} scheduled` : 'none today'}
        />
        <Kpi
          label="On clock"
          value={onSiteCount.toString()}
          meta={`${totalHoursToday.toFixed(1)} crew-hrs`}
          metaTone={onSiteCount > 0 ? 'green' : 'default'}
        />
        <Kpi
          label="Margin"
          value={marginPct === null ? '—' : `${(marginPct * 100).toFixed(0)}%`}
          unit={marginPct === null ? undefined : '%'}
          meta={marginPct === null ? 'no bids set' : 'across active'}
          metaTone={marginPct === null ? 'default' : marginPct < 0.2 ? 'red' : marginPct < 0.3 ? 'amber' : 'green'}
        />
      </div>

      {/* AI narrative — only when there's a clear story to tell */}
      {narrativeRow ? <NarrativeCard row={narrativeRow} /> : null}

      <BurdenHeroCard burden={workspaceBurden} label="Workspace burden today" />

      {reviewsCount > 0 ? (
        <Link to="/time" className="block">
          <Card tight className="!flex !items-center !justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Approval queue</div>
              <div className="text-[13px] font-semibold mt-1">
                {reviewsCount} time-review run{reviewsCount === 1 ? '' : 's'} pending
              </div>
            </div>
            <span className="text-[13px] text-accent font-medium">Review →</span>
          </Card>
        </Link>
      ) : null}

      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pt-1">
        Active projects · burn today
      </div>
      {projects.isPending ? (
        <Card tight>
          <div className="text-[12px] text-ink-3">Loading projects…</div>
        </Card>
      ) : rows.length === 0 ? (
        <Card tight>
          <div className="text-[13px] font-semibold">No active projects</div>
          <div className="text-[11px] text-ink-3 mt-1">Set a project to active in Projects to see it here.</div>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ project, burden, scheduled }) => (
            <li key={project.id}>
              <PmProjectRow project={project} burden={burden} scheduled={scheduled} />
            </li>
          ))}
        </ul>
      )}

      {attention.length > 0 ? (
        <>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pt-2">Watch list</div>
          <PmAttentionList items={attention} />
        </>
      ) : null}

      <div className="pt-1">
        <Attribution source="Live from /api/projects + /api/labor-burden/today (per project)" />
      </div>
    </div>
  )
}

interface PmProjectRowProps {
  project: ProjectListRow
  burden: LaborBurdenSummaryResponse | undefined
  scheduled: boolean
}

function PmProjectRow({ project, burden, scheduled }: PmProjectRowProps) {
  const cents = burden?.total_cents ?? 0
  const budgetCents = burden?.total_budget_cents ?? 0
  const pct = budgetCents > 0 ? (burden?.burden_pct_of_budget ?? 0) : 0
  const overBudget = budgetCents > 0 && cents > budgetCents
  const onSiteCount = burden?.per_worker.length ?? 0
  return (
    <Link to={`/projects/${project.id}`} className="block">
      <Card tight>
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold truncate">{project.name}</div>
            <div className="text-[11px] text-ink-3 mt-0.5 truncate">
              {project.customer_name ?? 'No customer'}
              {scheduled ? ' · scheduled today' : ''}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono tabular-nums text-[14px] font-semibold">{formatDollars(cents)}</div>
            <div className="text-[10px] text-ink-3 mt-0.5">
              {onSiteCount} worker{onSiteCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        {budgetCents > 0 ? (
          <>
            <div className="mt-2 h-1.5 bg-card-soft rounded-full overflow-hidden">
              <div
                className={overBudget ? 'h-full bg-bad' : 'h-full bg-accent'}
                style={{ width: `${Math.min(100, pct * 100)}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px] text-ink-3">
              <span className="font-mono tabular-nums">{(pct * 100).toFixed(0)}% of plan</span>
              <span className="font-mono tabular-nums">{formatDollars(budgetCents)} budget</span>
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[10px] text-ink-3">No daily budget set.</div>
        )}
      </Card>
    </Link>
  )
}

function PmAttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <Link to={item.action_to} className="block">
            <Card tight>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">{item.eyebrow}</div>
                  <div className="text-[13px] font-semibold mt-1 truncate">{item.title}</div>
                </div>
                <span className="text-[13px] text-accent font-medium shrink-0">{item.action_label} →</span>
              </div>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// db-pm narrative + helpers
// ---------------------------------------------------------------------------

interface NarrativeRow {
  project: ProjectListRow
  burden: LaborBurdenSummaryResponse | undefined
  scheduled: boolean
}

/**
 * Pick a project that warrants the day's narrative. Heuristic: largest
 * over-budget project that has a budget set. Returns null when no
 * project is materially over plan — calm-by-default per AI Rules Law 03.
 */
function pickNarrativeRow(rows: NarrativeRow[]): NarrativeRow | null {
  let best: NarrativeRow | null = null
  let worstOverPct = 0
  for (const row of rows) {
    const cents = row.burden?.total_cents ?? 0
    const budget = row.burden?.total_budget_cents ?? 0
    if (budget <= 0) continue
    const overPct = (cents - budget) / budget
    // Surface if at least 10% over plan; tighter than 0% so the narrative
    // doesn't fire on noise-level drift.
    if (overPct > 0.1 && overPct > worstOverPct) {
      worstOverPct = overPct
      best = row
    }
  }
  return best
}

/**
 * AI narrative card for the All sites / PM busy-day variant. Uses
 * `AgentSurface` so the dashed-border + "Agent draft · review before
 * sending" banner is correctly applied — even a deterministic
 * narrative gets the same treatment per AI Rules Law 02 (every AI
 * value carries an Attribution naming its source).
 */
function NarrativeCard({ row }: { row: NarrativeRow }) {
  const cents = row.burden?.total_cents ?? 0
  const budget = row.burden?.total_budget_cents ?? 0
  const overPct = budget > 0 ? Math.round(((cents - budget) / budget) * 100) : 0
  const overDollars = cents - budget
  return (
    <AgentSurface banner="Agent draft · review before sending">
      <div className="text-[14px] font-semibold leading-snug">
        {row.project.name} running {overPct}% over labor
      </div>
      <div className="text-[12px] text-ink-2 mt-1 leading-relaxed">
        {formatDollars(overDollars)} above today's daily budget. Margin is squeezed but recoverable — open the project
        to retag scopes or tighten crew sizing.
      </div>
      <div className="mt-2.5 pt-2.5 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
        <Attribution source="Computed from /api/labor-burden/today vs daily_budget_cents" state="muted" />
        <Link to={`/projects/${row.project.id}`}>
          <MobileButton variant="primary" size="sm" fullWidth={false}>
            Open project
          </MobileButton>
        </Link>
      </div>
    </AgentSurface>
  )
}

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { BurdenHeroCard, Card, Kpi, MobileButton, Pill } from '@/components/mobile'
import { AgentSurface, Attribution, Dismiss, StripeCard, useRejectSheet } from '@/components/ai'
import {
  fetchLaborBurdenToday,
  laborBurdenQueryKeys,
  useAiInsights,
  useApplyInsight,
  useClockTimeline,
  useDailyLogs,
  useDismissInsight,
  useLaborBurdenToday,
  useProjects,
  useSchedules,
  useTimeReviewRuns,
  useTriggerBidFollowUp,
  type AiInsight,
  type BidFollowUpDraft,
  type CrewScheduleRow,
  type LaborBurdenSummaryResponse,
  type ProjectListRow,
} from '@/lib/api'
import { pairClockSpans } from '@/lib/clock-derive'

/**
 * Owner / PM home — `db-calm-default` + `db-pm` variants from
 * `Sitemap.html` § 01.
 *
 * Three views the chip row toggles between:
 *   1. **Today** (default, `db-calm-default`): "You're caught up."
 *      headline, three running projects with on-site count + hours
 *      today.
 *   2. **What needs me?**: priority list of attention items derived
 *      from time-review pending + over-budget burden + stale drafts.
 *   3. **PM** (`db-pm` busy-day): denser layout for hands-on PMs —
 *      workspace BurdenHeroCard + per-project burn rows + inline
 *      attention. Less calm framing, more numbers per screen.
 *
 * Data sources are all existing hooks — composing client-side keeps the
 * dashboard responsive to per-resource cache invalidations from
 * elsewhere in the app (a foreman submitting a log makes the count
 * tick down on the owner's calm view immediately).
 */
type View = 'today' | 'attention' | 'pm'

export function OwnerTodayScreen() {
  const [view, setView] = useState<View>('today')
  const [rejectNode, askReject] = useRejectSheet()
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const schedules = useSchedules({ from: todayIso, to: todayIso })
  const timeline = useClockTimeline({ date: todayIso })
  const burden = useLaborBurdenToday()
  const reviews = useTimeReviewRuns({ state: 'pending' })
  const drafts = useDailyLogs({ status: 'draft' })
  const followUps = useAiInsights<BidFollowUpDraft>({ kind: 'bid_follow_up', open: true })
  const triggerFollowUp = useTriggerBidFollowUp()
  const apply = useApplyInsight()
  const dismiss = useDismissInsight()

  const projectsToday = schedules.data?.schedules ?? []
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])
  const onSiteCount = spans.filter((s) => s.out_at === null).length
  const totalHoursToday = spans.reduce((sum, s) => sum + s.hours, 0)

  const attention = useMemo(
    () =>
      buildAttentionItems({
        reviewsPending: reviews.data?.timeReviewRuns ?? [],
        burden: burden.data,
        drafts: drafts.data?.dailyLogs ?? [],
      }),
    [reviews.data, burden.data, drafts.data],
  )
  const followUpInsights = followUps.data?.insights ?? []
  const attentionCount = attention.length + followUpInsights.length

  return (
    <div className="flex flex-col bg-sand">
      <div className="px-5 pt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{formatDateLabel()}</div>
        {view === 'today' ? (
          <>
            <h1 className="mt-1 font-display text-[34px] font-bold tracking-tight leading-[1] max-w-xs">
              You're
              <br />
              caught up.
            </h1>
            <p className="text-[13px] text-ink-2 mt-2.5 max-w-md leading-relaxed">
              {projectsToday.length === 0
                ? 'No jobs scheduled for today.'
                : `${projectsToday.length} ${projectsToday.length === 1 ? 'job is' : 'jobs are'} running, ${onSiteCount} crew clocked in, the day's plan is set.`}
            </p>
          </>
        ) : view === 'attention' ? (
          <>
            <h1 className="mt-1 font-display text-[30px] font-bold tracking-tight leading-[1] max-w-xs">
              {attentionCount === 0
                ? "You're caught up."
                : `${attentionCount} thing${attentionCount === 1 ? '' : 's'}\nneed${attentionCount === 1 ? 's' : ''} you.`}
            </h1>
            <p className="text-[13px] text-ink-2 mt-2.5 max-w-md leading-relaxed">
              Sorted by impact. Tap to handle, swipe to dismiss.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">PM today</h1>
            <p className="text-[13px] text-ink-2 mt-2 max-w-md leading-relaxed">
              {onSiteCount} on site · {totalHoursToday.toFixed(1)} crew-hrs logged so far. Per-project burn below.
            </p>
          </>
        )}
      </div>

      {/* Filter chips */}
      <div className="px-4 pt-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
        <Chip active={view === 'today'} onClick={() => setView('today')}>
          Today
        </Chip>
        <Chip
          active={view === 'attention'}
          onClick={() => setView('attention')}
          dotTone={attentionCount > 0 ? 'warn' : 'default'}
        >
          What needs me? {attentionCount > 0 ? <span className="opacity-70 ml-1">{attentionCount}</span> : null}
        </Chip>
        <Chip active={view === 'pm'} onClick={() => setView('pm')}>
          PM
        </Chip>
        <Link
          to="/bid-accuracy"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium border bg-card-soft text-ink-2 border-line shrink-0"
        >
          Bid accuracy
        </Link>
        <Link
          to="/financial"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium border bg-card-soft text-ink-2 border-line shrink-0"
        >
          Financial
        </Link>
      </div>

      {view === 'today' && projectsToday.length > 0 ? (
        <div className="px-4 pb-1 pt-1 grid grid-cols-3 gap-2">
          <Kpi label="Active" value={projectsToday.length.toString()} meta="today" />
          <Kpi
            label="On site"
            value={onSiteCount.toString()}
            meta={onSiteCount > 0 ? 'live' : 'none'}
            metaTone={onSiteCount > 0 ? 'green' : 'default'}
          />
          <Kpi label="Crew-hrs" value={totalHoursToday.toFixed(1)} unit="h" />
        </div>
      ) : null}

      <div className="flex-1 px-4 pb-8 pt-2">
        {view === 'today' ? (
          <TodayList projects={projectsToday} totalHoursToday={totalHoursToday} />
        ) : view === 'attention' ? (
          <>
            <AttentionList items={attention} />
            <BidFollowUpList
              insights={followUpInsights}
              onScan={async () => {
                await triggerFollowUp.mutateAsync({}).catch(() => {})
              }}
              scanning={triggerFollowUp.isPending}
              onApply={async (id) => {
                await apply.mutateAsync({ id }).catch(() => {})
              }}
              onDismiss={async (id) => {
                const reason = await askReject({
                  title: 'Dismiss bid follow-up?',
                  body: 'Pick the closest match — this trains the model.',
                })
                if (reason !== null) {
                  await dismiss.mutateAsync({ id, reason }).catch(() => {})
                }
              }}
            />
          </>
        ) : (
          <PmDashboard
            workspaceBurden={burden.data}
            schedules={projectsToday}
            attention={attention}
            reviewsCount={reviews.data?.timeReviewRuns.length ?? 0}
          />
        )}
      </div>
      {rejectNode}
    </div>
  )
}

function ChipDot({ tone }: { tone: 'default' | 'warn' }) {
  const color = tone === 'warn' ? 'bg-warn' : 'bg-ink-4'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} aria-hidden="true" />
}

interface ChipProps {
  active: boolean
  onClick: () => void
  dotTone?: 'default' | 'warn'
  children: React.ReactNode
}
function Chip({ active, onClick, dotTone, children }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors shrink-0 ${
        active ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
      }`}
    >
      {dotTone ? <ChipDot tone={dotTone} /> : null}
      {children}
    </button>
  )
}

interface TodayListProps {
  projects: CrewScheduleRow[]
  totalHoursToday: number
}
function TodayList({ projects, totalHoursToday }: TodayListProps) {
  // Group by project_id — multiple schedules per project today collapse
  // into one row; the per-row hours figure is approximate (we don't have
  // per-project clock joins yet — Phase 2 follow-on).
  const byProject = new Map<string, CrewScheduleRow[]>()
  for (const s of projects) {
    const list = byProject.get(s.project_id) ?? []
    list.push(s)
    byProject.set(s.project_id, list)
  }
  const rows = Array.from(byProject.entries()).slice(0, 3)

  return (
    <div className="space-y-2.5">
      {rows.length === 0 ? (
        <Card>
          <div className="text-[13px] font-semibold">No projects today</div>
          <div className="text-[11px] text-ink-3 mt-1">Schedule something via Projects → Schedule.</div>
        </Card>
      ) : (
        rows.map(([projectId, scheds]) => {
          const first = scheds[0]
          const crewCount = first?.crew && Array.isArray(first.crew) ? (first.crew as unknown[]).length : 0
          return (
            <Link key={projectId} to={`/projects/${projectId}`} className="block">
              <Card>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold truncate">{first?.project_name ?? 'Project'}</div>
                    <div className="text-[11px] text-ink-3 mt-1 truncate">
                      {scheds.length} scope · {crewCount} on plan
                    </div>
                  </div>
                  <Pill tone={first?.status === 'confirmed' ? 'good' : 'warn'}>{first?.status ?? '—'}</Pill>
                </div>
              </Card>
            </Link>
          )
        })
      )}
      {totalHoursToday > 0 ? (
        <div className="pt-2 px-1 text-[11px] text-ink-3 text-center">
          {totalHoursToday.toFixed(1)} crew-hrs logged so far today.
        </div>
      ) : null}
      <div className="pt-3 text-center text-[12px] text-ink-4">Tap a project for detail. Pull down to refresh.</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attention items
// ---------------------------------------------------------------------------

type AttentionKind = 'over_budget' | 'reviews_pending' | 'drafts_stale'

interface AttentionItem {
  id: string
  kind: AttentionKind
  tone: 'warn' | 'accent'
  eyebrow: string
  title: string
  detail: string
  attribution: string
  action_label: string
  action_to: string
}

interface BuildAttentionInputs {
  reviewsPending: {
    id: string
    period_start: string
    period_end: string
    total_hours: string
    total_entries: number
    anomaly_count: number
    created_at: string
  }[]
  burden: import('@/lib/api').LaborBurdenSummaryResponse | undefined
  drafts: { id: string; project_id: string; updated_at: string }[]
}

function buildAttentionItems(inputs: BuildAttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = []

  // Over-budget: total_cents > total_budget_cents (when a budget is set).
  if (inputs.burden && inputs.burden.total_budget_cents > 0) {
    const overCents = inputs.burden.total_cents - inputs.burden.total_budget_cents
    if (overCents > 0) {
      const pct = inputs.burden.burden_pct_of_budget
      items.push({
        id: 'attn:over_budget',
        kind: 'over_budget',
        tone: 'warn',
        eyebrow: `At risk · ${formatDollars(overCents)} over`,
        title: `Today's burden is ${(pct * 100).toFixed(0)}% of plan`,
        detail: `${inputs.burden.total_hours.toFixed(1)} crew-hrs at ${formatDollars(inputs.burden.blended_loaded_hourly_cents)}/hr loaded.`,
        attribution: 'Why this card?',
        action_label: 'Open Time',
        action_to: '/time',
      })
    }
  }

  // Time-review pending — flag when there are runs waiting > 24h or with anomalies.
  const stale = inputs.reviewsPending.filter(
    (r) => r.anomaly_count > 0 || Date.now() - Date.parse(r.created_at) > 24 * 3600 * 1000,
  )
  if (stale.length > 0) {
    const totalEntries = stale.reduce((sum, r) => sum + r.total_entries, 0)
    const anomalies = stale.reduce((sum, r) => sum + r.anomaly_count, 0)
    items.push({
      id: 'attn:reviews_pending',
      kind: 'reviews_pending',
      tone: 'warn',
      eyebrow: `${stale.length} run${stale.length === 1 ? '' : 's'} waiting · ${totalEntries} entries`,
      title: 'Time entries waiting for approval',
      detail:
        anomalies > 0 ? `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}.` : 'All clean — single tap to approve.',
      attribution: 'Pending > 24h or has anomalies surface here.',
      action_label: 'Review',
      action_to: '/time',
    })
  }

  // Stale drafts — daily logs not submitted in 24h.
  const staleDrafts = inputs.drafts.filter((d) => Date.now() - Date.parse(d.updated_at) > 24 * 3600 * 1000)
  if (staleDrafts.length > 0) {
    items.push({
      id: 'attn:drafts_stale',
      kind: 'drafts_stale',
      tone: 'accent',
      eyebrow: `${staleDrafts.length} draft${staleDrafts.length === 1 ? '' : 's'} · last touch > 24h`,
      title: "Daily logs aren't getting submitted",
      detail: 'A foreman has unsubmitted draft logs older than yesterday.',
      attribution: 'Drafts go stale ≥ 24h surface here.',
      action_label: 'Open Logs',
      action_to: '/log',
    })
  }

  return items
}

function AttentionList({ items }: { items: AttentionItem[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const visible = items.filter((i) => !dismissed.has(i.id))

  if (visible.length === 0) {
    return (
      <Card>
        <div className="text-[13px] font-semibold">Nothing's flagged.</div>
        <div className="text-[11px] text-ink-3 mt-1">
          When labor goes over budget, time entries pile up, or daily logs go stale, they'll surface here.
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-2.5">
      {visible.map((item) => (
        <StripeCard key={item.id} tone={item.tone}>
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-warn">{item.eyebrow}</div>
            <Dismiss onDismiss={() => setDismissed((d) => new Set([...d, item.id]))} />
          </div>
          <div className="text-[14.5px] font-semibold leading-snug">{item.title}</div>
          <div className="text-[12px] text-ink-2 mt-1 leading-relaxed">{item.detail}</div>
          <div className="mt-2.5 pt-2.5 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
            <Attribution source={item.attribution} state="muted" />
            <Link to={item.action_to}>
              <MobileButton variant="primary" size="sm" fullWidth={false}>
                {item.action_label}
              </MobileButton>
            </Link>
          </div>
        </StripeCard>
      ))}
    </div>
  )
}

interface BidFollowUpListProps {
  insights: AiInsight<BidFollowUpDraft>[]
  onScan: () => void
  scanning: boolean
  onApply: (id: string) => Promise<void>
  onDismiss: (id: string) => Promise<void>
}

function BidFollowUpList({ insights, onScan, scanning, onApply, onDismiss }: BidFollowUpListProps) {
  if (insights.length === 0) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className="w-full py-3 rounded-md border border-line text-[13px] font-medium text-ink-2 disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : 'Scan for stale bids'}
        </button>
      </div>
    )
  }
  return (
    <div className="mt-4 space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Bid follow-ups</div>
      {insights.map((insight) => (
        <AgentSurface key={insight.id} banner={`Agent draft · ${insight.confidence} confidence`}>
          <div className="text-[13px] font-semibold mb-1">{insight.payload.subject}</div>
          <div className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap">{insight.payload.body}</div>
          <div className="mt-2 pt-2 border-t border-dashed border-line-2 flex items-center justify-between">
            <Attribution source={insight.attribution} />
            <span className="text-[11px] text-ink-3">{insight.payload.days_outstanding}d out</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void onApply(insight.id)}
              className="py-2 rounded-md bg-accent text-white text-[12px] font-medium"
            >
              Mark sent
            </button>
            <button
              type="button"
              onClick={() => void onDismiss(insight.id)}
              className="py-2 rounded-md border border-line text-ink-2 text-[12px] font-medium"
            >
              Dismiss
            </button>
          </div>
        </AgentSurface>
      ))}
    </div>
  )
}

function formatDateLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

function formatDollars(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1000) return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

// ---------------------------------------------------------------------------
// db-pm — busy-day dashboard
// ---------------------------------------------------------------------------

interface PmDashboardProps {
  workspaceBurden: LaborBurdenSummaryResponse | undefined
  schedules: CrewScheduleRow[]
  attention: AttentionItem[]
  reviewsCount: number
}

/**
 * `db-pm` — denser layout for hands-on PMs. Workspace BurdenHeroCard
 * up top, then per-active-project burden rows (one query per project
 * via useQueries), then the same attention items the calm view shows
 * inlined under a "Watch list" header.
 *
 * Pulls active projects via `useProjects({ status: 'active' })` rather
 * than relying on `crew_schedules` so a project still shows up here
 * even on a day with no scheduled crew (the office still wants to see
 * burn for it).
 */
function PmDashboard({ workspaceBurden, schedules, attention, reviewsCount }: PmDashboardProps) {
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

  return (
    <div className="space-y-3">
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

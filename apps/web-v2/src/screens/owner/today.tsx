import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution, Dismiss, StripeCard } from '@/components/ai'
import {
  useClockTimeline,
  useDailyLogs,
  useLaborBurdenToday,
  useSchedules,
  useTimeReviewRuns,
  type CrewScheduleRow,
} from '@/lib/api'
import { pairClockSpans } from '@/lib/clock-derive'

/**
 * Owner / PM home — `db-calm-default` from `Sitemap.html` § 01.
 *
 * Two states the chip row toggles between:
 *   1. **Today** (default): "You're caught up." headline, three running
 *      projects with on-site count + hours today.
 *   2. **What needs me?**: priority list of attention items derived
 *      from time-review pending + over-budget burden + stale drafts.
 *
 * Data sources are all existing hooks — composing client-side keeps the
 * dashboard responsive to per-resource cache invalidations from
 * elsewhere in the app (a foreman submitting a log makes the count
 * tick down on the owner's calm view immediately).
 */
type View = 'today' | 'attention'

export function OwnerTodayScreen() {
  const [view, setView] = useState<View>('today')
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const schedules = useSchedules({ from: todayIso, to: todayIso })
  const timeline = useClockTimeline({ date: todayIso })
  const burden = useLaborBurdenToday()
  const reviews = useTimeReviewRuns({ state: 'pending' })
  const drafts = useDailyLogs({ status: 'draft' })

  const projectsToday = schedules.data?.schedules ?? []
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])
  const onSiteCount = spans.filter((s) => s.out_at === null).length
  const totalHoursToday = spans.reduce((sum, s) => sum + s.hours, 0)

  const attention = useMemo(() => buildAttentionItems({
    reviewsPending: reviews.data?.timeReviewRuns ?? [],
    burden: burden.data,
    drafts: drafts.data?.dailyLogs ?? [],
  }), [reviews.data, burden.data, drafts.data])
  const attentionCount = attention.length

  return (
    <div className="flex flex-col bg-sand">
      <div className="px-5 pt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          {formatDateLabel()}
        </div>
        {view === 'today' ? (
          <>
            <h1 className="mt-1 font-display text-[34px] font-bold tracking-tight leading-[1] max-w-xs">
              You're<br />caught up.
            </h1>
            <p className="text-[13px] text-ink-2 mt-2.5 max-w-md leading-relaxed">
              {projectsToday.length === 0
                ? 'No jobs scheduled for today.'
                : `${projectsToday.length} ${projectsToday.length === 1 ? 'job is' : 'jobs are'} running, ${onSiteCount} crew clocked in, the day's plan is set.`}
            </p>
          </>
        ) : (
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
        )}
      </div>

      {/* Filter chips */}
      <div className="px-4 pt-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
        <Chip active={view === 'today'} onClick={() => setView('today')}>
          Today
        </Chip>
        <Chip active={view === 'attention'} onClick={() => setView('attention')} dotTone={attentionCount > 0 ? 'warn' : 'default'}>
          What needs me? {attentionCount > 0 ? <span className="opacity-70 ml-1">{attentionCount}</span> : null}
        </Chip>
        <Link
          to="/bid-accuracy"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium border bg-card-soft text-ink-2 border-line shrink-0"
        >
          Bid accuracy
        </Link>
      </div>

      <div className="flex-1 px-4 pb-8 pt-2">
        {view === 'today' ? (
          <TodayList projects={projectsToday} totalHoursToday={totalHoursToday} />
        ) : (
          <AttentionList items={attention} />
        )}
      </div>
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
      <div className="pt-3 text-center text-[12px] text-ink-4">
        Tap a project for detail. Pull down to refresh.
      </div>
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
  reviewsPending: { id: string; period_start: string; period_end: string; total_hours: string; total_entries: number; anomaly_count: number; created_at: string }[]
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
      detail: anomalies > 0 ? `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}.` : 'All clean — single tap to approve.',
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

function formatDateLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

function formatDollars(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1000) return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

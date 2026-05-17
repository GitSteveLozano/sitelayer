import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Kpi } from '@/components/mobile'
import { useRejectSheet } from '@/components/ai'
import {
  useAiInsights,
  useApplyInsight,
  useClockTimeline,
  useDailyLogs,
  useDismissInsight,
  useLaborBurdenToday,
  useSchedules,
  useTimeReviewRuns,
  useTriggerBidFollowUp,
  type BidFollowUpDraft,
} from '@/lib/api'
import { pairClockSpans } from '@/lib/clock-derive'
import { useFirstName, greetingWord } from '@/lib/user'
import { AttentionList, BidFollowUpList, buildAttentionItems } from './today/attention-list'
import { InlineAttentionPreview, TodayList } from './today/today-list'
import { ThisWeekList } from './today/this-week-list'
import { PmDashboard } from './today/pm-dashboard'
import {
  buildAllSitesSubline,
  buildCalmSubline,
  formatDateLabel,
  groupHoursByProject,
  isoDateOffset,
} from './today/helpers'

/**
 * Owner / PM home — `db-calm-default` + `db-pm` variants from
 * `Sitemap.html` § 03.
 *
 * Four chip-driven views, vocab matching panels 2 + 3:
 *   1. **today**         (default, `db-calm-default`): "You're caught
 *      up." headline, three running projects with hours-today per row.
 *   2. **what needs me?**: priority list of attention items derived
 *      from time-review pending + over-budget burden + stale drafts.
 *   3. **this week**: 7-day forward look at scheduled crew + drafts.
 *   4. **all sites**     (`db-pm` busy-day): denser layout for hands-on
 *      PMs — personalized greeting, SNAPSHOT KPI row including MARGIN,
 *      AI narrative card when something's on fire, then per-project
 *      burn rows.
 *
 * Data sources are all existing hooks — composing client-side keeps the
 * dashboard responsive to per-resource cache invalidations from
 * elsewhere in the app (a foreman submitting a log makes the count
 * tick down on the owner's calm view immediately).
 */
type View = 'today' | 'attention' | 'this_week' | 'all_sites'

export function OwnerTodayScreen() {
  const [view, setView] = useState<View>('today')
  const [rejectNode, askReject] = useRejectSheet()
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const weekEndIso = useMemo(() => isoDateOffset(todayIso, 7), [todayIso])
  const firstName = useFirstName()

  const schedules = useSchedules({ from: todayIso, to: todayIso })
  const weekSchedules = useSchedules({ from: todayIso, to: weekEndIso })
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
  const hoursByProjectId = useMemo(() => groupHoursByProject(spans), [spans])

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
            {attentionCount > 0 ? (
              <>
                <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight max-w-md">
                  {firstName ? `Good ${greetingWord()}, ${firstName}.` : `Good ${greetingWord()}.`}
                </h1>
                <p className="text-[13px] text-ink-2 mt-2.5 max-w-md leading-relaxed">
                  {buildAllSitesSubline({ projectsCount: projectsToday.length, onSiteCount, attentionCount })}
                </p>
              </>
            ) : (
              <>
                <h1 className="mt-1 font-display text-[34px] font-bold tracking-tight leading-[1] max-w-xs">
                  You're
                  <br />
                  caught up.
                </h1>
                <p className="text-[13px] text-ink-2 mt-2.5 max-w-md leading-relaxed">
                  {buildCalmSubline({
                    projectsCount: projectsToday.length,
                    onSiteCount,
                    attentionCount,
                  })}
                </p>
              </>
            )}
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
        ) : view === 'this_week' ? (
          <>
            <h1 className="mt-1 font-display text-[30px] font-bold tracking-tight leading-tight max-w-xs">This week</h1>
            <p className="text-[13px] text-ink-2 mt-2 max-w-md leading-relaxed">
              Forward-looking — scheduled crew, open drafts, and pending approvals across the next 7 days.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight max-w-md">
              {firstName ? `Good ${greetingWord()}, ${firstName}.` : `Good ${greetingWord()}.`}
            </h1>
            <p className="text-[13px] text-ink-2 mt-2 max-w-md leading-relaxed">
              {buildAllSitesSubline({ projectsCount: projectsToday.length, onSiteCount, attentionCount })}
            </p>
          </>
        )}
      </div>

      {/* Filter chips — vocab from Sitemap §03 panel 2/3 */}
      <div className="px-4 pt-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
        <Chip active={view === 'today'} onClick={() => setView('today')}>
          today
        </Chip>
        <Chip
          active={view === 'attention'}
          onClick={() => setView('attention')}
          dotTone={attentionCount > 0 ? 'warn' : 'default'}
        >
          what needs me? {attentionCount > 0 ? <span className="opacity-70 ml-1">{attentionCount}</span> : null}
        </Chip>
        <Chip active={view === 'this_week'} onClick={() => setView('this_week')}>
          This week
        </Chip>
        <Chip active={view === 'all_sites'} onClick={() => setView('all_sites')}>
          All sites
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
          <>
            {attention.length > 0 ? (
              <div className="mb-3">
                <InlineAttentionPreview
                  top={attention[0]!}
                  totalCount={attentionCount}
                  onSeeAll={() => setView('attention')}
                />
              </div>
            ) : null}
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
              Today on site
            </div>
            <TodayList projects={projectsToday} totalHoursToday={totalHoursToday} hoursByProjectId={hoursByProjectId} />
          </>
        ) : view === 'attention' ? (
          <>
            <AttentionList items={attention} reviewsPending={reviews.data?.timeReviewRuns ?? []} />
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
        ) : view === 'this_week' ? (
          <ThisWeekList
            schedules={weekSchedules.data?.schedules ?? []}
            isLoading={weekSchedules.isPending}
            attentionCount={attentionCount}
          />
        ) : (
          <PmDashboard
            workspaceBurden={burden.data}
            schedules={projectsToday}
            attention={attention}
            reviewsCount={reviews.data?.timeReviewRuns.length ?? 0}
            onSiteCount={onSiteCount}
            totalHoursToday={totalHoursToday}
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

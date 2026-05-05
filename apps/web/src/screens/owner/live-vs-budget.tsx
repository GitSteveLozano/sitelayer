import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { SkeletonRows } from '@/components/shell/LoadingSkeleton'
import { useLaborBurdenToday } from '@/lib/api'

/**
 * `t-vs` from Sitemap §8 panel 4 — "Live vs budget" standalone Time
 * sub-tab. Same /api/labor-burden/today data as t-burden but a
 * different question: are we on pace today?
 *
 * Pacing model:
 *   - Expected burn at this point in the workday = (now − 7am) / 8h
 *     of the daily plan, capped at 100%.
 *   - Actual burn so far = burden_pct_of_budget.
 *   - Delta paints the headline pill: green if within 5%, amber if
 *     5–15%, red if more.
 *
 * Same calm-default empty: no clock activity → EmptyState.
 */
export function OwnerLiveVsBudgetScreen() {
  const burden = useLaborBurdenToday()
  const data = burden.data

  const expectedPctOfDay = computeExpectedPaceFraction()
  const burnPct = data && data.total_budget_cents > 0 ? data.burden_pct_of_budget : 0
  const delta = expectedPctOfDay - burnPct
  const underPlan = delta > 0.05
  const overPlan = delta < -0.05
  const headlineTone: 'good' | 'warn' | 'bad' = overPlan ? 'bad' : underPlan ? 'good' : 'warn'
  const headlineLabel = overPlan ? 'Over pace' : underPlan ? 'Under pace' : 'On pace'

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-4">
        <Link to="/time" className="text-[12px] text-ink-3">
          ← Time
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Live vs budget</h1>
        <div className="text-[13px] text-ink-2 mt-1">Today's burn against the rolled-up daily plan.</div>
      </div>

      <div className="px-4 pb-8 space-y-3">
        {burden.isPending ? (
          <SkeletonRows count={3} className="px-0" />
        ) : !data || data.total_budget_cents === 0 ? (
          <EmptyState
            title={data ? 'No daily plan rolled up' : 'No clock activity today'}
            body={
              data
                ? 'Set a daily_budget on each active project to see live pace tracking here.'
                : "Once a worker clocks in, today's burn vs plan rolls up here in real time."
            }
            primaryAction={
              <Link
                to="/projects"
                className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
              >
                Open projects
              </Link>
            }
          />
        ) : (
          <>
            <Card>
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Today · burn vs plan
                </div>
                <Pill tone={headlineTone} withDot>
                  {headlineLabel}
                </Pill>
              </div>
              <div className="font-mono tabular-nums text-[36px] font-bold tracking-tight leading-none">
                ${(data.total_cents / 100).toFixed(2)}
              </div>
              <div className="text-[12px] text-ink-3 mt-1">
                of ${(data.total_budget_cents / 100).toLocaleString()} planned · {(burnPct * 100).toFixed(0)}% burned
              </div>

              {/* Stacked bar: burned (accent) + remaining (card-soft).
                  Pace marker = vertical line at expectedPctOfDay. */}
              <div className="relative h-3 mt-4 bg-card-soft rounded-full overflow-visible">
                <div
                  className={
                    overPlan
                      ? 'absolute inset-y-0 left-0 bg-bad rounded-full'
                      : underPlan
                        ? 'absolute inset-y-0 left-0 bg-good rounded-full'
                        : 'absolute inset-y-0 left-0 bg-accent rounded-full'
                  }
                  style={{ width: `${Math.min(100, burnPct * 100)}%` }}
                  aria-hidden="true"
                />
                <span
                  aria-label="Expected pace marker"
                  className="absolute top-[-3px] bottom-[-3px] w-[2px] bg-ink"
                  style={{ left: `${Math.min(100, expectedPctOfDay * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-2 text-[11px] text-ink-3">
                <span className="font-mono tabular-nums">{(burnPct * 100).toFixed(0)}% burned</span>
                <span className="font-mono tabular-nums">{(expectedPctOfDay * 100).toFixed(0)}% expected</span>
              </div>
            </Card>

            <Card>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Composition</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-card-soft rounded-md py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Crew-hrs</div>
                  <div className="font-mono tabular-nums text-[18px] font-semibold mt-1">
                    {data.total_hours.toFixed(1)}
                  </div>
                </div>
                <div className="bg-card-soft rounded-md py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">OT-hrs</div>
                  <div
                    className={
                      data.total_ot_hours > 0
                        ? 'font-mono tabular-nums text-[18px] font-semibold mt-1 text-warn'
                        : 'font-mono tabular-nums text-[18px] font-semibold mt-1'
                    }
                  >
                    {data.total_ot_hours.toFixed(1)}
                  </div>
                </div>
                <div className="bg-card-soft rounded-md py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Blended/hr</div>
                  <div className="font-mono tabular-nums text-[18px] font-semibold mt-1">
                    ${(data.blended_loaded_hourly_cents / 100).toFixed(0)}
                  </div>
                </div>
              </div>
            </Card>

            <Attribution source="Pace marker derived from local time vs an 8h workday (7am–3pm)" />
          </>
        )}
      </div>

      <div className="px-4 pb-6 flex gap-2">
        <Link to="/time/burden" className="flex-1">
          <MobileButton variant="ghost">Burden →</MobileButton>
        </Link>
        <Link to="/time" className="flex-1">
          <MobileButton variant="ghost">Back to Time</MobileButton>
        </Link>
      </div>
    </div>
  )
}

/**
 * Compute "where we should be" as a fraction of the daily plan, based
 * on local time. Assumes a 7am–3pm 8h workday — a reasonable default
 * for the construction crews this product targets. Returns 0 before
 * 7am, ramps linearly to 1.0 at 3pm, then plateaus at 1.0.
 */
function computeExpectedPaceFraction(): number {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = 7 * 60 // 7:00 AM
  const end = 15 * 60 // 3:00 PM
  if (minutes <= start) return 0
  if (minutes >= end) return 1
  return (minutes - start) / (end - start)
}

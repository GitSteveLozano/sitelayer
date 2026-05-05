import type { LaborBurdenSummaryResponse } from '@/lib/api'

/**
 * `WTD-burden` hero card — dark ink surface with big mono dollars, a
 * pace ribbon, and a "on pace / under / over" callout. Used by
 * `fm-today-v2` (workspace-wide) and the project Overview tab
 * (project-scoped).
 *
 * Pace model: expected fraction of plan = (now − 7am) / 8h, plateau at
 * 1.0 after 3pm. The vertical ink-light line on the ribbon marks the
 * expected pct; the accent fill is the actual burn.
 */
export interface BurdenHeroCardProps {
  burden: LaborBurdenSummaryResponse | undefined
  /** Override the eyebrow label. Defaults to "Today's burden so far". */
  label?: string
  /**
   * Override the pace expectation when caller knows better than the
   * default 7am–3pm clock. Range [0, 1].
   */
  expectedPctOfDay?: number
}

export function BurdenHeroCard({ burden, label = "Today's burden so far", expectedPctOfDay }: BurdenHeroCardProps) {
  const cents = burden?.total_cents ?? 0
  const hours = burden?.total_hours ?? 0
  const blendedCents = burden?.blended_loaded_hourly_cents ?? 0
  const budgetCents = burden?.total_budget_cents ?? 0
  const pct = budgetCents > 0 ? (burden?.burden_pct_of_budget ?? 0) : 0
  const expected = expectedPctOfDay ?? computeExpectedPaceFraction()
  const planDelta = budgetCents > 0 ? expected - pct : 0
  const onPace = budgetCents > 0 && Math.abs(planDelta) <= 0.05
  const underPlan = budgetCents > 0 && planDelta > 0.05
  const overPlan = budgetCents > 0 && planDelta < -0.05

  return (
    <div className="rounded-[14px] bg-ink text-[#f3ecdf] p-4">
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[#aea69a]">{label}</span>
        <span className="text-[10px] font-semibold text-[#7adba0]">● live</span>
      </div>
      <div className="flex items-baseline justify-between">
        <div>
          <div className="num text-[28px] font-bold tracking-tight leading-none">{formatDollars(cents)}</div>
          <div className="num text-[11px] text-[#aea69a] mt-1">
            {hours.toFixed(1)} crew-hrs · loaded {formatDollars(blendedCents)}/hr
          </div>
        </div>
        <div className="text-right">
          {budgetCents > 0 ? (
            <>
              <div
                className={`text-[13px] font-semibold ${
                  underPlan ? 'text-[#7adba0]' : overPlan ? 'text-[#e89e7d]' : 'text-[#f3ecdf]'
                }`}
              >
                {underPlan
                  ? `↓ ${formatPctDelta(planDelta)} under`
                  : overPlan
                    ? `↑ ${formatPctDelta(-planDelta)} over`
                    : 'on pace'}
              </div>
              <div className="num text-[10px] text-[#aea69a] mt-0.5">
                {(pct * 100).toFixed(0)}% of {formatDollars(budgetCents)}
              </div>
            </>
          ) : (
            <>
              <div className="text-[12px] text-[#aea69a]">no budget set</div>
              <div className="text-[10px] text-[#8a8278] mt-0.5">add daily_budget on project</div>
            </>
          )}
        </div>
      </div>
      {budgetCents > 0 ? (
        <div className="mt-3 relative h-2 bg-[#0e0c0a] rounded-sm overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 bg-accent" style={{ width: `${Math.min(100, pct * 100)}%` }} />
          <div
            className="absolute top-0 bottom-0 w-px bg-[#7adba0]"
            style={{ left: `${Math.min(100, expected * 100)}%` }}
            aria-label="Expected pace marker"
          />
        </div>
      ) : null}
      <div className={`mt-3 text-[10px] flex items-center gap-1.5 ${onPace ? 'text-[#7adba0]' : 'text-[#8a8278]'}`}>
        {budgetCents > 0
          ? `${burden?.total_ot_hours ? burden.total_ot_hours.toFixed(1) + ' OT hrs · ' : ''}${burden?.per_worker.length ?? 0} workers`
          : 'Set daily_budget on the project for plan tracking.'}
      </div>
    </div>
  )
}

function formatDollars(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1000) return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

function formatPctDelta(frac: number): string {
  return `${Math.round(Math.abs(frac) * 100)}%`
}

/**
 * Same pace model as `t-vs` / `OwnerLiveVsBudgetScreen`: linear ramp
 * from 7am to 3pm, plateau at 1.0 after. 0 before 7am.
 */
function computeExpectedPaceFraction(): number {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = 7 * 60
  const end = 15 * 60
  if (minutes <= start) return 0
  if (minutes >= end) return 1
  return (minutes - start) / (end - start)
}

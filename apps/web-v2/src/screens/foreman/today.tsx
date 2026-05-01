import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, PhoneTopBar, Pill } from '@/components/mobile'
import { Attribution, Spark, StripeCard } from '@/components/ai'
import { useClockTimeline } from '@/lib/api'
import { findOpenSpan, formatHms, pairClockSpans, startOfDay, sumHoursInRange } from '@/lib/clock-derive'

/**
 * `fm-today-v2` — Foreman home with the WTD-burden card variant.
 *
 * Real wiring:
 *   - Today's clock events drive crew-status totals (on-site count,
 *     crew-hours so far). Refetches every 30s so the screen stays
 *     in sync as workers clock in/out.
 *
 * Placeholders (lands in Phase 2 / 1D.4 / Phase 5):
 *   - Project name, day-number, plan-budget — needs bootstrap data.
 *   - Per-crew avatars + names — needs the workers endpoint joined to
 *     clock_events. Phase 1D.4 wires this.
 *   - Burden $-figure + "% under plan" — needs labor_burden rollup
 *     (Phase 2). Shown with `<AgentSurface>` + dim spark to set
 *     expectation that the figure will get real later.
 */
export function ForemanTodayScreen() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])

  const nowMs = Date.now()
  const todayMs = startOfDay(nowMs)
  const todayHours = useMemo(() => sumHoursInRange(spans, todayMs, todayMs + 24 * 3600 * 1000, nowMs), [spans, todayMs, nowMs])

  // Distinct workers represented in today's events. Each (worker, in)
  // event is one body on site at some point today. Open spans = on-site
  // right now.
  const onSiteWorkerIds = new Set(spans.filter((s) => s.out_at === null).map((s) => s.project_id ?? 'unknown'))
  const totalCrewHours = todayHours
  const onSiteCount = onSiteWorkerIds.size

  return (
    <div className="flex flex-col">
      <PhoneTopBar activeProject="On site" />

      <div className="px-5 pt-2 pb-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman</div>
        <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">
          Today
        </h1>
        <div className="text-[13px] text-ink-2 mt-1">
          {formatTodayLabel(nowMs)} · {onSiteCount} on site
        </div>
      </div>

      {/* Today's burden — dark card matching the design's headline element.
          Real numbers land in Phase 2; for now we render with the live
          crew-hours figure so the structure is honest. */}
      <div className="px-4 pb-3">
        <div className="rounded-[14px] bg-ink text-[#f3ecdf] p-4">
          <div className="flex items-baseline justify-between mb-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[#aea69a]">
              Today's burden so far
            </span>
            <span className="text-[10px] font-semibold text-[#7adba0]">● live</span>
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <div className="num text-[28px] font-bold tracking-tight leading-none">$—</div>
              <div className="num text-[11px] text-[#aea69a] mt-1">
                {totalCrewHours.toFixed(1)} crew-hrs · loaded $/hr in Phase 2
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] text-[#aea69a]">target</div>
              <div className="num text-[11px] text-[#aea69a] mt-0.5">— budget</div>
            </div>
          </div>
          <div className="mt-3 text-[10px] text-[#8a8278] flex items-center gap-1.5">
            <Spark state="dim" size={10} aria-label="" />
            Burden $-figure lands with labor_burden rollup
          </div>
        </div>
      </div>

      {/* Crew check-in — real clock state. */}
      <div className="px-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
          Crew check-in
        </div>
        <Card className="!p-0 overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between border-b border-line">
            <span className="text-[13px] font-semibold">Today's roster</span>
            <Pill tone="good" withDot>
              {onSiteCount} on site
            </Pill>
          </div>
          {events.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-ink-3 text-center">
              No clock events yet today.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {spans.slice(0, 8).map((span, i) => (
                <li key={span.in_at + i} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">
                      Worker {span.project_id ? `· ${span.project_id.slice(0, 6)}…` : ''}
                    </div>
                    <div className="text-[11px] text-ink-3 num">
                      In at {formatTime(span.in_at)}
                      {span.out_at ? ` · out ${formatTime(span.out_at)}` : ' · still on site'}
                    </div>
                  </div>
                  <span className="num text-[13px] font-medium text-ink-2">
                    {span.out_at ? `${span.hours.toFixed(1)}h` : formatHms(span.hours)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="mt-2 px-1">
          <Attribution source="Live from /api/clock/timeline" />
        </div>
      </div>

      {/* Quick actions — link to the other foreman surfaces. */}
      <div className="px-4 mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">Quick</div>
        <div className="grid grid-cols-2 gap-2.5">
          <ActionTile to="/time" label="Crew time" detail={`${spans.length} entries`} />
          <ActionTile to="/" label="Crew map" detail="live pins · soon" disabled />
          <ActionTile to="/log" label="Daily log" detail="photos + notes" highlight />
          <ActionTile to="/" label="Materials" detail="request" disabled />
        </div>
      </div>

      {/* Today's schedule placeholder — needs crew_schedules wiring (Phase 1D.4). */}
      <div className="px-4 mt-5 pb-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
          Today's schedule
        </div>
        <StripeCard tone="accent">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">EPS — East elevation</div>
              <div className="text-[11px] text-ink-3 mt-0.5">3 crew · 7:00 AM – 3:30 PM · 980 sqft</div>
            </div>
            <Pill tone="good">active</Pill>
          </div>
          <div className="mt-2 pt-2 border-t border-dashed border-line-2">
            <Attribution source="Sample data — wires to crew_schedules in Phase 1D.4" />
          </div>
        </StripeCard>
      </div>

      {/* End-of-day daily log entry — wires to the daily-log composer. */}
      <div className="px-4 pb-8">
        <Link to="/log" className="block">
          <MobileButton variant="primary">End of day → Daily log</MobileButton>
        </Link>
      </div>
    </div>
  )
}

interface ActionTileProps {
  to: string
  label: string
  detail: string
  highlight?: boolean
  disabled?: boolean
}

function ActionTile({ to, label, detail, highlight, disabled }: ActionTileProps) {
  const inner = (
    <Card
      tight
      className={`!flex !flex-col !items-start !gap-1.5 ${disabled ? 'opacity-60' : 'active:bg-card-soft'}`}
    >
      <div className={`text-[13px] font-semibold ${highlight ? 'text-accent' : ''}`}>{label}</div>
      <div className="text-[11px] text-ink-3">{detail}</div>
    </Card>
  )
  if (disabled) {
    return <div aria-disabled="true">{inner}</div>
  }
  return <Link to={to}>{inner}</Link>
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatTodayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

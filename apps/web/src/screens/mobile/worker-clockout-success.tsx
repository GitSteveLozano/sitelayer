/**
 * Clock-out confirmation screen — `wk-clockout-success`
 * (`V2WorkerClockOutSuccess`, "Today → CLOCK OUT"). Shows after a worker
 * punches out for the day. Analogous to the clock-in success surface but
 * end-of-shift: a big "Clocked out." headline, the day's total hours as
 * the hero stat, a 3-stat strip (punched-out time / hours / mode), and a
 * gloved primary back to Today.
 *
 * Server-authoritative: hours come straight from today's clock timeline
 * (`useClockTimeline`) — we pair in→out events for the day and sum the
 * worked spans rather than trusting any client-held running clock. The
 * punch itself already landed in `wk-today`'s `handlePunch('out')` before
 * navigation; this is the confirmation surface, not the writer.
 *
 * The shell applies `.m-dark` for workers, so all colors come from
 * `var(--m-*)` tokens — no hardcoded dark values.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { MBody, MButton, MButtonStack, MI, MPill, MStat, MStatStrip, MTopBar } from '../../components/m/index.js'
import { useClockTimeline, type ClockEvent } from '../../lib/api/clock.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import { useDailyLogs } from '../../lib/api/daily-logs.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { stepStatus } from './worker-scope-steps.js'
import { formatDecimalHours, formatMoney, timeOfDay, todayIso } from './format.js'

/** Sum worked seconds for the day by pairing each `in` with the next
 *  closing event (`out` / `auto_out_geo` / `auto_out_idle`). Open spans
 *  (an `in` with no later close) are ignored — on this screen the worker
 *  just punched out, so there should be no open span, and ignoring it is
 *  the safe under-report. */
function workedSecondsForDay(events: readonly ClockEvent[]): number {
  const sorted = [...events]
    .filter((e) => !e.voided_at)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0))
  let total = 0
  let openInAt: number | null = null
  for (const e of sorted) {
    if (e.event_type === 'in') {
      openInAt = new Date(e.occurred_at).valueOf()
    } else if (openInAt !== null) {
      const closeAt = new Date(e.occurred_at).valueOf()
      if (Number.isFinite(closeAt) && Number.isFinite(openInAt) && closeAt > openInAt) {
        total += Math.floor((closeAt - openInAt) / 1000)
      }
      openInAt = null
    }
  }
  return total
}

export function WorkerClockoutSuccess({
  bootstrap = null,
}: {
  bootstrap?: BootstrapResponse | null
} = {}) {
  const navigate = useNavigate()
  const today = todayIso()
  const timeline = useClockTimeline({ date: today })
  const events = useMemo(() => timeline.data?.events ?? [], [timeline.data?.events])

  const workedSec = useMemo(() => workedSecondsForDay(events), [events])
  const workedHours = workedSec / 3600

  // The opening punch-in for the day — drives the start of the time range
  // and the lunch gap (open span minus worked span).
  const firstIn = useMemo(() => {
    const ins = events
      .filter((e) => e.event_type === 'in' && !e.voided_at)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
    return ins[0] ?? null
  }, [events])

  // The closing event for the day — most-recent out/auto-out. Drives the
  // punch-out time stat and whether the clock-out was manual or automatic.
  const lastClose = useMemo(() => {
    const closes = events
      .filter((e) => e.event_type !== 'in' && !e.voided_at)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    return closes[0] ?? null
  }, [events])

  const punchedOutAt = lastClose?.occurred_at ?? null
  const punchedInAt = firstIn?.occurred_at ?? null
  const projectId = lastClose?.project_id ?? firstIn?.project_id ?? null
  const projectName = lastClose?.project_name ?? null
  const project = bootstrap?.projects.find((p) => p.id === projectId) ?? null

  // Lunch minutes — the elapsed span (in → out) minus actual worked seconds
  // is the unworked gap, surfaced as the "30 MIN LUNCH" detail (msg47).
  const lunchMin = useMemo(() => {
    if (!punchedInAt || !punchedOutAt) return 0
    const span = Math.floor((new Date(punchedOutAt).valueOf() - new Date(punchedInAt).valueOf()) / 1000)
    const gap = span - workedSec
    return gap > 60 ? Math.round(gap / 60) : 0
  }, [punchedInAt, punchedOutAt, workedSec])

  // STEPS done / total — today's brief for the clocked project.
  const briefQuery = useProjectBriefs(projectId, today)
  const briefSteps = useMemo<ProjectBriefStep[]>(() => {
    const b = briefQuery.data?.briefs?.[0]
    return b && Array.isArray(b.steps) ? (b.steps as ProjectBriefStep[]) : []
  }, [briefQuery.data?.briefs])
  const stepsDone = briefSteps.filter((s) => stepStatus(s) === 'done').length
  const stepsTotal = briefSteps.length

  // PHOTOS — today's daily-log photo count for the project.
  const dailyLogs = useDailyLogs(projectId ? { projectId, from: today, to: today } : { from: today, to: today }, {
    enabled: Boolean(projectId),
  })
  const photoCount = useMemo(
    () => (dailyLogs.data?.dailyLogs ?? []).reduce((n, l) => n + (l.photo_keys?.length ?? 0), 0),
    [dailyLogs.data?.dailyLogs],
  )

  // GROSS — worked hours × the project's labor rate. Sparse-data safe: if
  // we can't resolve a rate we hide the gross figure rather than show $0.
  const laborRate = project?.labor_rate != null ? Number(project.labor_rate) : NaN
  const gross = Number.isFinite(laborRate) ? workedHours * laborRate : null

  // TOMORROW lookahead — the worker's next confirmed schedule after today.
  const tomorrowShift = useMemo(() => {
    if (!bootstrap) return null
    const meWorkerId = bootstrap.workers[0]?.id ?? null
    if (!meWorkerId) return null
    const next = bootstrap.schedules
      .filter((s) => {
        if (s.deleted_at) return false
        if (s.status !== 'confirmed') return false
        if (s.scheduled_for.slice(0, 10) <= today) return false
        const ids = Array.isArray(s.crew) ? (s.crew as unknown[]).filter((x): x is string => typeof x === 'string') : []
        return ids.includes(meWorkerId)
      })
      .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : 1))[0]
    if (!next) return null
    const proj = bootstrap.projects.find((p) => p.id === next.project_id)
    return { scheduledFor: next.scheduled_for, projectName: proj?.name ?? null }
  }, [bootstrap, today])

  // No countdown — the worker is done for the day, so we let them sit on
  // the wrap-up. Tapping through is deliberate.
  const reducedMotion = usePrefersReducedMotion()

  return (
    <>
      <MTopBar back title="Clocked out" onBack={() => navigate('/today')} />
      <MBody>
        {tomorrowShift ? (
          /* Day-complete banner — solid green strip with a checkbox glyph,
             the "DAY COMPLETE · SEE YOU TOMORROW" treatment (msg45). */
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              margin: '16px 20px 0',
              padding: '14px 16px',
              background: 'var(--m-green)',
              color: 'var(--m-paper, #F4F1EA)',
            }}
          >
            <span aria-hidden style={{ width: 14, height: 14, flexShrink: 0, background: 'var(--m-paper, #F4F1EA)' }} />
            <span
              className="m-topbar-eyebrow"
              style={{ color: 'var(--m-paper, #F4F1EA)', textTransform: 'uppercase', fontSize: 12, fontWeight: 700 }}
            >
              Day complete · See you tomorrow
            </span>
          </div>
        ) : null}
        <div style={{ padding: '24px 20px 0' }}>
          <div style={ms.eyebrow}>{projectName ? `Wrapped · ${projectName}` : "That's a wrap"}</div>
          <div style={ms.bignum}>
            Clocked
            <br />
            out.
          </div>
        </div>

        {/* HOURS hero — the day's total, the headline number the worker
            cares about at end of shift. Mirrors the clocked-in timer slab
            on wk-today but settled (decimal hours, not a running clock). */}
        <div
          style={{
            margin: '24px 20px',
            border: '2px solid var(--m-line)',
            background: 'var(--m-card-soft)',
            padding: '28px 20px',
            textAlign: 'center',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <ConfettiTicks reducedMotion={reducedMotion} />
          <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)', position: 'relative' }}>
            HOURS TODAY
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 76,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              marginTop: 10,
              color: 'var(--m-ink)',
              position: 'relative',
            }}
          >
            {timeline.isPending ? '—' : formatDecimalHours(workedHours)}
          </div>
          <div
            className="m-topbar-eyebrow num"
            style={{
              color: 'var(--m-ink-4)',
              marginTop: 12,
              textTransform: 'none',
              fontSize: 11,
              position: 'relative',
            }}
          >
            {punchedInAt && punchedOutAt
              ? `${timeOfDay(punchedInAt)} → ${timeOfDay(punchedOutAt)}${lunchMin > 0 ? ` · ${lunchMin} min lunch` : ''}`
              : punchedOutAt
                ? `Punched out ${timeOfDay(punchedOutAt)}`
                : 'Shift logged'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14, position: 'relative' }}>
            <MPill tone="green">✓ Clocked out</MPill>
          </div>
        </div>

        {/* Day-summary stat strip — PHOTOS / STEPS / GROSS (msg47). Gross
            is hidden when no labor rate resolves so sparse data never reads
            as $0. */}
        <MStatStrip>
          <MStat label="Photos" value={dailyLogs.isPending && projectId ? '—' : photoCount} />
          <MStat label="Steps" value={stepsTotal > 0 ? `${stepsDone}/${stepsTotal}` : '—'} />
          <MStat label="Gross" value={gross != null ? formatMoney(gross) : '—'} />
        </MStatStrip>

        {/* "Anything to flag before you leave?" — dashed affordance into the
            flag-issue flow, the end-of-day catch the design prompts (msg47/45). */}
        <div style={{ padding: '16px 20px 0' }}>
          <button
            type="button"
            onClick={() => navigate('/issue')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              border: '2px dashed var(--m-line)',
              background: 'transparent',
              padding: '14px 16px',
              cursor: 'pointer',
              color: 'inherit',
              textAlign: 'left',
            }}
          >
            <MI.AlertTri size={18} />
            <span
              className="m-topbar-eyebrow"
              style={{ color: 'var(--m-ink-3)', textTransform: 'uppercase', fontSize: 11 }}
            >
              Anything to flag before you leave?
            </span>
          </button>
        </div>

        {tomorrowShift ? (
          <div style={{ padding: '16px 20px 0' }}>
            <div style={{ border: '2px solid var(--m-line)', padding: '16px 18px' }}>
              <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)' }}>
                Tomorrow
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 700,
                    fontSize: 20,
                    letterSpacing: '-0.015em',
                  }}
                >
                  {tomorrowShift.projectName ?? 'Next shift'} · {timeOfDay(tomorrowShift.scheduledFor)}
                </div>
                <span
                  className="m-topbar-eyebrow"
                  style={{ color: 'var(--m-accent)', textTransform: 'uppercase', fontSize: 11 }}
                >
                  Same crew
                </span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="m-quiet-sm" style={{ padding: '14px 20px 0' }}>
          Your hours are logged and head to your foreman for review. Drive back into a site geofence to clock in again.
        </div>

        <div style={{ padding: '20px' }}>
          <MButtonStack>
            <MButton variant="primary" data-size="worker" onClick={() => navigate('/today')}>
              {tomorrowShift ? `See you tomorrow · ${timeOfDay(tomorrowShift.scheduledFor)}` : 'Back to today'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/hours')}>
              See this week's hours
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

const ms: Record<string, CSSProperties> = {
  eyebrow: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--m-green)',
  },
  bignum: {
    fontFamily: 'var(--m-font-display)',
    fontSize: 72,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 0.9,
    marginTop: 14,
    color: 'var(--m-ink)',
  },
}

/** Detect the OS-level reduced-motion preference; the celebratory tick
 *  animation is gated in JS so it respects the setting. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mql.matches)
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return reduced
}

/** A quiet brutalist "celebration" — a row of accent ticks across the top
 *  of the hours slab, gently rising when motion is allowed. No emoji, no
 *  party confetti; just enough to mark the day done in the v2 idiom. */
function ConfettiTicks({ reducedMotion }: { reducedMotion: boolean }) {
  const ticks = [12, 40, 72, 110, 150, 196, 236, 272]
  return (
    <svg
      viewBox="0 0 290 24"
      width="100%"
      height="24"
      preserveAspectRatio="none"
      aria-hidden
      style={{ position: 'absolute', top: 0, left: 0, opacity: 0.5 }}
    >
      {ticks.map((x, i) => (
        <rect key={x} x={x} y={6} width={4} height={10} fill={i % 2 === 0 ? 'var(--m-green)' : 'var(--m-accent)'}>
          {reducedMotion ? null : (
            <animate attributeName="y" values="10;4;10" dur="2.6s" begin={`${i * 0.18}s`} repeatCount="indefinite" />
          )}
        </rect>
      ))}
    </svg>
  )
}

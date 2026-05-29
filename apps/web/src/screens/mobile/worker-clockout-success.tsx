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
import { MBody, MButton, MButtonStack, MStat, MStatStrip, MTopBar } from '../../components/m/index.js'
import { useClockTimeline, type ClockEvent } from '../../lib/api/clock.js'
import { formatDecimalHours, timeOfDay, todayIso } from './format.js'

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

export function WorkerClockoutSuccess() {
  const navigate = useNavigate()
  const today = todayIso()
  const timeline = useClockTimeline({ date: today })
  const events = useMemo(() => timeline.data?.events ?? [], [timeline.data?.events])

  const workedSec = useMemo(() => workedSecondsForDay(events), [events])
  const workedHours = workedSec / 3600

  // The closing event for the day — most-recent out/auto-out. Drives the
  // punch-out time stat and whether the clock-out was manual or automatic.
  const lastClose = useMemo(() => {
    const closes = events
      .filter((e) => e.event_type !== 'in' && !e.voided_at)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    return closes[0] ?? null
  }, [events])

  const punchedOutAt = lastClose?.occurred_at ?? null
  const mode =
    lastClose?.event_type === 'auto_out_geo'
      ? 'AUTO · LEFT'
      : lastClose?.event_type === 'auto_out_idle'
        ? 'AUTO · IDLE'
        : 'MANUAL'
  const projectName = lastClose?.project_name ?? null

  // No countdown — the worker is done for the day, so we let them sit on
  // the wrap-up. Tapping through is deliberate.
  const reducedMotion = usePrefersReducedMotion()

  return (
    <>
      <MTopBar back title="Clocked out" onBack={() => navigate('/today')} />
      <MBody>
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
            className="m-topbar-eyebrow"
            style={{ color: 'var(--m-ink-4)', marginTop: 12, textTransform: 'none', fontSize: 11, position: 'relative' }}
          >
            {punchedOutAt ? `Punched out ${timeOfDay(punchedOutAt)}` : 'Shift logged'}
          </div>
        </div>

        <MStatStrip>
          <MStat label="Out" value={punchedOutAt ? timeOfDay(punchedOutAt) : '—'} />
          <MStat label="Hours" value={timeline.isPending ? '—' : formatDecimalHours(workedHours)} />
          <MStat label="Mode" value={mode} />
        </MStatStrip>

        <div className="m-quiet-sm" style={{ padding: '14px 20px 0' }}>
          Your hours are logged and head to your foreman for review. Drive back into a site geofence to clock in again.
        </div>

        <div style={{ padding: '20px' }}>
          <MButtonStack>
            <MButton variant="primary" data-size="worker" onClick={() => navigate('/today')}>
              Back to today
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
            <animate
              attributeName="y"
              values="10;4;10"
              dur="2.6s"
              begin={`${i * 0.18}s`}
              repeatCount="indefinite"
            />
          )}
        </rect>
      ))}
    </svg>
  )
}

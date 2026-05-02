import { useEffect, useState } from 'react'

/**
 * `wk-clockin` — full-screen takeover after an auto-geofence clock-in
 * succeeds, redesigned per Sitemap §11 (Worker app, "Auto clock-in
 * success"). The brief calls for a quiet, full-bleed dark surface with
 * a single orange beacon — the geofence ping confirming the crossing —
 * and a 2-minute correction window so the worker can void if the
 * trigger was wrong.
 *
 * Dark theme is engaged via the `.m-dark` wrapper class, which flips
 * the CSS custom properties (`--m-bg`, `--m-card`, `--m-ink`, …) in
 * `tokens.css`. All Tailwind utilities mapped to those tokens (`bg-bg`,
 * `text-ink`, etc.) automatically pick up the dark values, so the
 * primitives don't need to know they're rendering in focus mode.
 *
 * Auto-fades after 6 seconds per the design (`wk-clockin → wk-today
 * after auto-fade`); the correction window stays open server-side per
 * `correctible_until` regardless of whether this surface is showing.
 */
export interface ClockInSuccessProps {
  projectName?: string | null
  /** ISO timestamp the server stamped on the clock event. */
  occurredAt: string
  /** ISO timestamp when correction window closes (from clock_events.correctible_until). */
  correctibleUntil: string | null
  onDismiss: () => void
  /** Phase 1D.4 wires this through the void endpoint. */
  onVoid?: () => void
}

export function ClockInSuccess({ projectName, occurredAt, correctibleUntil, onDismiss, onVoid }: ClockInSuccessProps) {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(correctibleUntil))

  useEffect(() => {
    if (!correctibleUntil) return
    const id = window.setInterval(() => {
      const left = secondsUntil(correctibleUntil)
      setSecondsLeft(left)
      if (left <= 0) window.clearInterval(id)
    }, 1000)
    return () => window.clearInterval(id)
  }, [correctibleUntil])

  // Auto-fade after 6s — matches the sitemap routing for wk-clockin → wk-today.
  useEffect(() => {
    const id = window.setTimeout(() => onDismiss(), 6_000)
    return () => window.clearTimeout(id)
  }, [onDismiss])

  return (
    <div className="m-dark flex flex-col min-h-dvh bg-bg text-ink">
      <div className="flex-1 flex flex-col px-6 pt-10 pb-8">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-good">Clocked in</div>
        <h1 className="mt-1.5 font-display text-[30px] font-bold tracking-tight leading-tight">You're clocked in</h1>
        <p className="text-[14px] text-ink-2 mt-2 max-w-[24ch]">
          We detected you crossed {projectName ?? 'the project geofence'} at {formatTime(occurredAt)}.
        </p>

        <div className="flex-1 flex items-center justify-center my-10">
          <Beacon />
        </div>

        {correctibleUntil && secondsLeft > 0 ? (
          <button
            type="button"
            onClick={() => onVoid?.()}
            disabled={!onVoid}
            className="w-full text-left bg-card-soft border border-line-2 rounded-[12px] px-4 py-3 mb-3 active:opacity-80"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold">Wrong location?</div>
                <div className="font-mono tabular-nums text-[11px] text-ink-3 mt-0.5">Void in {secondsLeft}s</div>
              </div>
              <span className="text-[12px] font-semibold text-warn shrink-0">Void</span>
            </div>
          </button>
        ) : null}

        <button
          type="button"
          onClick={onDismiss}
          className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold"
        >
          See today's scope
        </button>
      </div>
    </div>
  )
}

/**
 * The single orange ping at the centre of the surface — the visual
 * answer to "was the auto-clock-in actually you". Concentric pulses
 * fade out so the beacon reads as 'live, just confirmed'.
 */
function Beacon() {
  return (
    <div className="relative w-[180px] h-[180px] flex items-center justify-center">
      <span className="absolute inset-0 rounded-full bg-accent/15 animate-ping" aria-hidden="true" />
      <span className="absolute inset-6 rounded-full bg-accent/25" aria-hidden="true" />
      <span
        className="relative w-[68px] h-[68px] rounded-full bg-accent shadow-[0_0_40px_rgba(217,144,74,0.45)]"
        aria-hidden="true"
      />
    </div>
  )
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0
  return Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000))
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

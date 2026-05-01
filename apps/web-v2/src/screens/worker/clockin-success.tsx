import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, PhoneTopBar, Pill } from '@/components/mobile'

/**
 * `wk-clockin` — full-screen takeover after an auto-geofence clock-in
 * succeeds. Shows the location, project, and a 2-minute correction
 * window so the worker can void if the trigger was wrong.
 *
 * Phase 1D.2 ships the visual + countdown; the actual void endpoint
 * lands in Phase 1D.4 along with the clock_events soft-delete migration.
 * The button here just dismisses for now (returns to wk-today).
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
    <div className="flex flex-col h-full bg-bg">
      <PhoneTopBar activeProject={projectName ?? 'On site'} />

      <div className="px-5 pt-6 pb-4 flex-1 flex flex-col">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-good">Clocked in</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">You're checked in</h1>
        <p className="text-[14px] text-ink-2 mt-1">
          {formatTime(occurredAt)} at {projectName ?? 'this project'}
        </p>

        <Card className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-good shrink-0" aria-hidden="true" />
            <span className="text-[13px] font-medium">Auto clock-in confirmed</span>
          </div>
          <p className="text-[12px] text-ink-3 leading-relaxed">
            We detected you crossed the project geofence. The site map shows your pin inside the work area.
          </p>
        </Card>

        {correctibleUntil && secondsLeft > 0 ? (
          <Card className="mt-3" tight>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[12px] font-semibold">Wait, that wasn't me</div>
                <div className="text-[11px] text-ink-3 mt-0.5">{secondsLeft}s left to void this clock-in</div>
              </div>
              <MobileButton variant="ghost" size="sm" fullWidth={false} onClick={() => onVoid?.()} disabled={!onVoid}>
                Void
              </MobileButton>
            </div>
          </Card>
        ) : (
          <Card className="mt-3" tight>
            <div className="flex items-center justify-between">
              <Pill tone="default">Correction window closed</Pill>
              <Link to="/" className="text-[12px] text-accent font-medium">
                Got it
              </Link>
            </div>
          </Card>
        )}

        <div className="mt-auto pt-6">
          <MobileButton variant="primary" onClick={onDismiss}>
            See today's scope
          </MobileButton>
        </div>
      </div>
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

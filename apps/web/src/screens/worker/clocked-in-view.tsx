import { Link } from 'react-router-dom'
import { MobileButton, Pill } from '@/components/mobile'
import { Spark } from '@/components/ai'
import { formatHms } from '@/lib/clock-derive'

/**
 * `wk-today · clocked in` from Sitemap §11 — the focus-mode timer
 * surface that replaces the standard worker home while a clock-in is
 * open. Same `.m-dark` token swap as `ClockInSuccess`, so all
 * Tailwind utilities mapped to design tokens (`bg-bg`, `text-ink`,
 * `border-line`) flip automatically.
 *
 * Layout (top → bottom):
 *   1. Eyebrow + project line
 *   2. Pill (Clocked in · auto / manual)
 *   3. Hero timer (mono, very large)
 *   4. Action row — Break + Clock out
 *   5. Today's scope card (light card on dark surface — the one bright
 *      area, since scope is what keeps the worker oriented)
 *
 * The off-clock layout stays in the parent screen; this is rendered
 * only when `clockedIn === true`.
 */
export interface WorkerClockedInViewProps {
  projectName: string
  startedAtIso: string
  runtimeHours: number
  source: 'auto_geofence' | 'manual'
  onClockOut: () => void | Promise<void>
  isClockingOut?: boolean
}

export function WorkerClockedInView({
  projectName,
  startedAtIso,
  runtimeHours,
  source,
  onClockOut,
  isClockingOut,
}: WorkerClockedInViewProps) {
  return (
    <div className="m-dark min-h-dvh flex flex-col bg-bg text-ink">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{formatDateLabel()}</div>
        <h1 className="mt-1 font-display text-[22px] font-bold tracking-tight leading-tight truncate">{projectName}</h1>
        <div className="mt-2">
          <Pill tone="good" withDot>
            Clocked in · {source === 'auto_geofence' ? 'auto' : 'manual'}
          </Pill>
        </div>
      </div>

      <div className="px-5 flex-1 flex flex-col items-center justify-center text-center">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">
          On site since {formatTime(startedAtIso)}
        </div>
        <div className="font-mono tabular-nums font-bold tracking-tight leading-none text-[64px]">
          {formatHms(runtimeHours)}
        </div>
        <div className="mt-4 text-[12px] text-ink-3 inline-flex items-center gap-1.5">
          <Spark state="muted" size={11} aria-label="" />
          Synced with foreman
        </div>
      </div>

      <div className="px-4 pb-3 grid grid-cols-2 gap-2">
        <MobileButton variant="ghost" disabled>
          Break
        </MobileButton>
        <MobileButton variant="destructive" onClick={() => void onClockOut()} disabled={isClockingOut}>
          {isClockingOut ? 'Clocking out…' : 'Clock out'}
        </MobileButton>
      </div>

      <div className="px-4 pb-6">
        <Link to="/log" className="block bg-card border border-line rounded-[14px] px-4 py-3.5 active:opacity-90">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Today's scope</div>
              <div className="text-[14px] font-semibold mt-0.5">Open the foreman log</div>
              <div className="text-[12px] text-ink-3 mt-0.5">Photos, notes, and the day's narrative.</div>
            </div>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              width="14"
              height="14"
              className="text-ink-4 shrink-0"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </div>
        </Link>
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDateLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

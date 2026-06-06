import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useGeolocationPermission } from '@/lib/permissions'

/**
 * `prm-location` — Sitemap §1 panel 3 ("Location prime").
 *
 * Frame the geolocation ask before the OS dialog appears: a single
 * "Allow Sitelayer to use your location?" framing with a clear reason
 * (auto clock-in when arriving on site) and an explicit Allow / Skip
 * pair. Tapping Allow triggers the *real* native prompt via
 * `useGeolocationPermission().request()` — the OS shrinks the prime
 * surface and shows its own modal on top.
 *
 * After the OS prompt resolves we stay on the prime briefly to show
 * the user *what changed* — a small success card on grant or a
 * "we're blocked, here's how to fix it" card on denial — instead of
 * silently routing back. The user dismisses with Continue.
 *
 * Reachable at /permissions/location?next=/some/path so a feature that
 * needs location (clock-in, geofence setup) can route through and
 * resume on success.
 */
export function LocationPrimeScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') ?? '/'
  const { state, request } = useGeolocationPermission()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'idle' | 'granted' | 'denied'>('idle')

  const onAllow = async () => {
    setBusy(true)
    try {
      const result = await request()
      if (result === 'granted') {
        setOutcome('granted')
      } else if (result === 'denied') {
        setOutcome('denied')
      }
    } finally {
      setBusy(false)
    }
  }

  const onContinue = () => navigate(next, { replace: true })

  return (
    <div className="m-host">
      <div className="m-standalone h-full w-full flex flex-col bg-ink text-[#f3ecdf]">
        {/* Faux Today header in the upper-left so the sheet visually sits
          on top of the actual app, like the design panel. */}
        <div className="px-5 pt-[calc(env(safe-area-inset-top,0px)+24px)]">
          <div className="text-[12px] text-[#8a8278] font-mono tabular-nums">Today</div>
          <div className="text-[10px] text-[#5e5750] mt-0.5">May 02</div>
        </div>

        <div className="flex-1 flex items-end px-4 pb-[calc(env(safe-area-inset-bottom,0px)+24px)]">
          {outcome === 'granted' ? (
            <SuccessCard onContinue={onContinue} />
          ) : outcome === 'denied' ? (
            <DeniedCard onContinue={onContinue} />
          ) : (
            <PrimeCard busy={busy} disabled={state === 'unsupported'} onAllow={onAllow} onSkip={onContinue} />
          )}
        </div>
      </div>
    </div>
  )
}

function PrimeCard({
  busy,
  disabled,
  onAllow,
  onSkip,
}: {
  busy: boolean
  disabled: boolean
  onAllow: () => void
  onSkip: () => void
}) {
  return (
    <div className="w-full bg-[#1a1612] rounded-[18px] border border-[#3a342d] px-5 pt-7 pb-5 text-center">
      <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="26"
          height="26"
          className="text-white"
          aria-hidden="true"
        >
          <path d="M12 2c-4.4 0-8 3.6-8 8 0 5.4 8 12 8 12s8-6.6 8-12c0-4.4-3.6-8-8-8z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </div>

      <h1 className="font-display text-[20px] font-bold tracking-tight leading-tight max-w-[22ch] mx-auto">
        Allow "Sitelayer" to use your location?
      </h1>

      <p className="text-[13px] text-[#aea69a] mt-3 max-w-[32ch] mx-auto leading-relaxed">
        Sitelayer uses location to clock you in when you arrive at a job site.
      </p>

      <div className="mt-6 -mx-5 border-t border-[#3a342d]">
        <button
          type="button"
          onClick={onAllow}
          disabled={busy || disabled}
          className="block w-full py-3 text-[15px] font-medium text-[#7adba0] disabled:opacity-50"
        >
          {busy ? 'Asking…' : 'Allow Once'}
        </button>
        <button
          type="button"
          onClick={onAllow}
          disabled={busy || disabled}
          className="block w-full py-3 text-[15px] font-semibold text-[#7adba0] border-t border-[#3a342d] disabled:opacity-50"
        >
          Allow While Using App
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="block w-full py-3 text-[15px] font-medium text-[#e89e7d] border-t border-[#3a342d]"
        >
          Don't Allow
        </button>
      </div>
    </div>
  )
}

function SuccessCard({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      role="status"
      className="w-full bg-[#1a1612] rounded-[18px] border border-[#3a342d] px-5 pt-7 pb-5 text-center"
    >
      <div className="w-14 h-14 rounded-2xl bg-good flex items-center justify-center mx-auto mb-5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="26"
          height="26"
          className="text-white"
          aria-hidden="true"
        >
          <path d="M5 12l5 5 9-11" />
        </svg>
      </div>
      <h1 className="font-display text-[20px] font-bold tracking-tight leading-tight">Location enabled</h1>
      <p className="text-[13px] text-[#aea69a] mt-3 max-w-[32ch] mx-auto leading-relaxed">
        We'll auto clock-in your crew when they cross a job-site geofence.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-6 w-full h-[48px] rounded-[14px] bg-accent text-white text-[15px] font-semibold inline-flex items-center justify-center"
      >
        Continue
      </button>
    </div>
  )
}

function DeniedCard({ onContinue }: { onContinue: () => void }) {
  return (
    <div role="alert" className="w-full bg-[#1a1612] rounded-[18px] border border-[#3a342d] px-5 pt-7 pb-5 text-center">
      <div className="w-14 h-14 rounded-2xl bg-warn flex items-center justify-center mx-auto mb-5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="26"
          height="26"
          className="text-white"
          aria-hidden="true"
        >
          <path d="M12 9v4M12 17v.01" />
          <path d="M10.3 3.5L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0z" />
        </svg>
      </div>
      <h1 className="font-display text-[20px] font-bold tracking-tight leading-tight">Location is blocked</h1>
      <p className="text-[13px] text-[#aea69a] mt-3 max-w-[32ch] mx-auto leading-relaxed">
        Re-enable it in <span className="text-[#f3ecdf] font-semibold">Settings → Sitelayer → Location</span> to use
        auto clock-in.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-6 w-full h-[48px] rounded-[14px] bg-accent text-white text-[15px] font-semibold inline-flex items-center justify-center"
      >
        Continue without location
      </button>
    </div>
  )
}

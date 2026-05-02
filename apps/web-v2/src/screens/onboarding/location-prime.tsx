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
  const [denied, setDenied] = useState(false)

  const onAllow = async () => {
    setBusy(true)
    setDenied(false)
    try {
      const result = await request()
      if (result === 'granted') {
        navigate(next, { replace: true })
      } else if (result === 'denied') {
        setDenied(true)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh flex flex-col bg-ink text-[#f3ecdf]">
      {/* Faux Today header in the upper-left so the sheet visually sits
          on top of the actual app, like the design panel. */}
      <div className="px-5 pt-[calc(env(safe-area-inset-top,0px)+24px)]">
        <div className="text-[12px] text-[#8a8278] font-mono tabular-nums">Today</div>
        <div className="text-[10px] text-[#5e5750] mt-0.5">May 02</div>
      </div>

      <div className="flex-1 flex items-end px-4 pb-[calc(env(safe-area-inset-bottom,0px)+24px)]">
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

          {denied ? (
            <p className="text-[12px] text-[#e89e7d] mt-4 max-w-[32ch] mx-auto leading-relaxed">
              You blocked location. Re-enable it in Settings → Sitelayer to use auto clock-in.
            </p>
          ) : null}

          <div className="mt-6 -mx-5 border-t border-[#3a342d]">
            <button
              type="button"
              onClick={onAllow}
              disabled={busy || state === 'unsupported'}
              className="block w-full py-3 text-[15px] font-medium text-[#7adba0] disabled:opacity-50"
            >
              {busy ? 'Asking…' : 'Allow Once'}
            </button>
            <button
              type="button"
              onClick={onAllow}
              disabled={busy || state === 'unsupported'}
              className="block w-full py-3 text-[15px] font-semibold text-[#7adba0] border-t border-[#3a342d] disabled:opacity-50"
            >
              Allow While Using App
            </button>
            <button
              type="button"
              onClick={() => navigate(next, { replace: true })}
              className="block w-full py-3 text-[15px] font-medium text-[#e89e7d] border-t border-[#3a342d]"
            >
              Don't Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

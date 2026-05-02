import { useEffect, useState } from 'react'

/**
 * `splash-landing` — Sitemap §1 panel 1 ("Safari landing").
 *
 * First-visit takeover for non-standalone iOS Safari users that frames
 * the value prop and walks them to "Add to Home Screen". Wired into
 * `App.tsx` via `useShouldShowSafariLanding` so it sits above all
 * routes until the user taps Skip / Add to Home Screen.
 *
 * Skipping the landing stamps localStorage so the takeover doesn't
 * fire again for 90 days. The thin `IosInstallHint` banner this used
 * to coexist with was retired — the full-screen surface converts
 * installs at the moment of intent (a deep-link tap) where the banner
 * was easy to miss.
 */
export const SAFARI_LANDING_DISMISS_KEY = 'sitelayer.v2.safari-landing-dismissed-at'
const DISMISS_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days — first-run only

export interface SafariLandingProps {
  onSkip: () => void
}

export function SafariLandingScreen({ onSkip }: SafariLandingProps) {
  return (
    <div className="min-h-dvh flex flex-col bg-ink text-[#f3ecdf]">
      <div className="px-5 pt-[calc(env(safe-area-inset-top,0px)+24px)] flex items-center justify-between">
        <span className="text-[12px] font-mono tabular-nums text-[#aea69a]">app.sitelayer.co</span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-[88px] h-[88px] rounded-2xl bg-accent flex items-center justify-center mb-8 shadow-[0_8px_24px_rgba(217,144,74,0.4)]">
          <span className="font-display text-[36px] font-bold text-white tracking-tight leading-none">SL</span>
        </div>

        <h1 className="font-display text-[34px] font-bold tracking-tight leading-[1.05] max-w-[18ch]">
          Run the day from your pocket.
        </h1>

        <p className="text-[14px] text-[#aea69a] mt-4 max-w-[28ch] leading-relaxed">
          Clock in, takeoff, daily logs, and crew chat — all offline first. Install to your home screen.
        </p>
      </div>

      <div className="px-5 pb-[calc(env(safe-area-inset-bottom,0px)+24px)] space-y-3">
        <a
          href="#install"
          onClick={(e) => {
            e.preventDefault()
            // iOS doesn't expose a programmatic install — we point users
            // at the share sheet hint below, then drop into the app.
            const hint = document.getElementById('safari-share-hint')
            hint?.classList.remove('opacity-50')
            hint?.classList.add('opacity-100', 'ring-2', 'ring-accent')
          }}
          className="block w-full h-[52px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
        >
          Add to Home Screen
        </a>

        <div
          id="safari-share-hint"
          className="text-[12px] text-[#aea69a] text-center px-4 py-2.5 rounded-[10px] border border-[#3a342d] opacity-50 transition-all"
        >
          Tap{' '}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="14"
            height="14"
            className="inline-block align-text-bottom mx-0.5"
            aria-hidden="true"
          >
            <path d="M12 3v13M7 8l5-5 5 5M5 21h14" />
          </svg>{' '}
          in Safari, then <span className="font-semibold text-[#f3ecdf]">"Add to Home Screen"</span>
        </div>

        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(SAFARI_LANDING_DISMISS_KEY, String(Date.now()))
            onSkip()
          }}
          className="block w-full text-[12px] text-[#8a8278] font-medium py-2"
        >
          Skip — I'll install later
        </button>
      </div>
    </div>
  )
}

/**
 * Hook that reports whether the Safari landing should take over the
 * shell. Centralises the "iOS Safari + not standalone + not dismissed"
 * check; returns `ready=false` on the first render so callers know to
 * paint the splash instead of flashing the wrong surface.
 */
export function useShouldShowSafariLanding(): { ready: boolean; show: boolean; skip: () => void } {
  const [state, setState] = useState<{ ready: boolean; show: boolean }>({ ready: false, show: false })

  useEffect(() => {
    if (typeof window === 'undefined') {
      setState({ ready: true, show: false })
      return
    }
    const ua = navigator.userAgent || ''
    const isIos = /iPad|iPhone|iPod/.test(ua)
    if (!isIos) {
      setState({ ready: true, show: false })
      return
    }
    const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
    if (!isSafari) {
      setState({ ready: true, show: false })
      return
    }
    const standalone =
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    if (standalone) {
      setState({ ready: true, show: false })
      return
    }
    const dismissedAt = Number(window.localStorage.getItem(SAFARI_LANDING_DISMISS_KEY) ?? 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) {
      setState({ ready: true, show: false })
      return
    }
    setState({ ready: true, show: true })
  }, [])

  return {
    ready: state.ready,
    show: state.show,
    skip: () => {
      window.localStorage.setItem(SAFARI_LANDING_DISMISS_KEY, String(Date.now()))
      setState({ ready: true, show: false })
    },
  }
}

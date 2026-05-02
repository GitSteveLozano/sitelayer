import { useEffect, useState } from 'react'

/**
 * iOS Add-to-Home-Screen instruction hint from Sitemap §1 panel 2.
 *
 * Apple Safari doesn't expose `BeforeInstallPromptEvent`, so the
 * existing `InstallPromptBanner` is silent on iOS. This banner fills
 * the gap with the canonical instruction copy: tap Share → "Add to
 * Home Screen". Only renders when:
 *
 *   1. UA looks like iOS Safari (iPad / iPhone / iPod, no
 *      `webkit` Chrome / Firefox / Brave variants which all spoof
 *      different UA tails).
 *   2. The page isn't already running in standalone PWA mode
 *      (`navigator.standalone === true` on iOS, or the matchMedia
 *      `(display-mode: standalone)` predicate fires).
 *   3. The user hasn't dismissed the hint within the last 30 days.
 *
 * 30-day dismiss is longer than the BeforeInstallPromptEvent banner's
 * 14d because iOS users can't trigger the install in-flow — pestering
 * them every two weeks is friction they can't resolve in one tap.
 */
const DISMISS_KEY = 'sitelayer.v2.ios-install-hint-dismissed-at'
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function IosInstallHint() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const ua = navigator.userAgent || ''
    const isIos = /iPad|iPhone|iPod/.test(ua)
    if (!isIos) return
    // Crude but effective: actual Safari has 'Safari/' but no
    // 'CriOS' (Chrome) / 'FxiOS' (Firefox) / 'EdgiOS' (Edge) in the UA.
    const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
    if (!isSafari) return
    const standalone =
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    if (standalone) return
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return
    setShow(true)
  }, [])

  if (!show) return null

  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5 bg-card-soft border-b border-line text-[12px]">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        width="16"
        height="16"
        className="text-accent shrink-0 mt-0.5"
        aria-hidden="true"
      >
        <path d="M12 3v13M7 8l5-5 5 5M5 21h14" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-ink font-medium">Install Sitelayer</div>
        <div className="text-ink-3 mt-0.5 leading-snug">
          Tap <span className="font-semibold text-ink-2">Share</span>, then{' '}
          <span className="font-semibold text-ink-2">"Add to Home Screen"</span> for one-tap launch + push.
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
          setShow(false)
        }}
        className="text-ink-3 px-2 py-1 shrink-0"
        aria-label="Dismiss install hint"
      >
        Hide
      </button>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { registerServiceWorker } from '@/pwa/register'

/**
 * Service-worker update banner — sits under OfflineBanner. When the
 * background SW detects a new build, this component flips visible
 * with a "tap to update" affordance. Clicking calls the registered
 * `updateSW(true)` which activates the new SW + reloads.
 *
 * v2 brutalist (aligned to V2StateStale): full-fill ACCENT strip, square
 * pulsing ink block, mono "NEW VERSION" eyebrow over the reload prompt.
 * All colors are `--m-*` tokens so the worker dark theme inverts cleanly.
 *
 * Production-only — `registerServiceWorker` no-ops outside of
 * PROD bundles, so dev still hot-reloads via Vite.
 */
export function UpdateBanner() {
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateSW, setUpdateSW] = useState<((reloadPage?: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!import.meta.env.PROD) return
    const update = registerServiceWorker({
      onNeedRefresh: () => setNeedsRefresh(true),
    })
    setUpdateSW(() => update)
  }, [])

  if (!needsRefresh) return null

  const onTap = async () => {
    if (updating) return
    setUpdating(true)
    try {
      // updateSW(true) skips the waiting SW, takes control, and reloads.
      // Without the `true` arg, vite-plugin-pwa only sends SKIP_WAITING
      // and the user perceives nothing happening.
      if (updateSW) await updateSW(true)
    } catch {
      // Fall back to a manual reload — the new SW will activate when
      // every tab is closed, and the banner will re-show after that.
      window.location.reload()
    }
  }

  return (
    <button
      type="button"
      onClick={onTap}
      role="status"
      aria-live="polite"
      className="block w-full text-left"
      style={{
        padding: '12px 20px',
        background: 'var(--m-accent)',
        color: 'var(--m-accent-ink)',
        borderBottom: '2px solid var(--m-ink)',
        borderTop: '2px solid var(--m-ink)',
        cursor: 'pointer',
      }}
    >
      <span className="inline-flex items-center gap-2.5">
        <span
          aria-hidden="true"
          style={{
            width: 12,
            height: 12,
            background: 'var(--m-ink)',
            animation: 'm-pulse 1s infinite',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {updating ? 'Updating…' : 'New version · tap to reload'}
        </span>
      </span>
    </button>
  )
}

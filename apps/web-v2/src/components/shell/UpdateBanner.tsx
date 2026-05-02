import { useEffect, useState } from 'react'
import { registerServiceWorker } from '@/pwa/register'

/**
 * Service-worker update banner — sits under OfflineBanner. When the
 * background SW detects a new build, this component flips visible
 * with a "Tap to update" affordance. Clicking calls the registered
 * `updateSW(true)` which activates the new SW + reloads.
 *
 * Production-only — `registerServiceWorker` no-ops outside of
 * PROD bundles, so dev still hot-reloads via Vite.
 */
export function UpdateBanner() {
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateSW, setUpdateSW] = useState<(() => Promise<void>) | null>(null)

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
      // The reload is what the user perceives as "new version applied."
      if (updateSW) await updateSW()
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
      className="block w-full text-left px-4 py-2.5 bg-accent text-white text-[13px] font-medium"
    >
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true">↻</span>
        {updating ? 'Updating…' : 'New version — tap to update'}
      </span>
    </button>
  )
}

import { useEffect, useState } from 'react'
import { registerServiceWorker } from '@/pwa/register'
import { MUpdateState } from '@/components/m-states'

/**
 * Service-worker update takeover. When the background SW detects a new build,
 * this flips into a full-screen "NEW VERSION" takeover (design msg__06): an
 * accent (#FFD400) hero with a "● NEW VERSION" mono eyebrow, the bold
 * "Sitelayer got an update." headline, a "WHAT'S NEW" list, and RELOAD APP /
 * LATER actions. RELOAD APP calls the registered `updateSW(true)` which
 * activates the waiting SW + reloads; LATER dismisses until the next check.
 *
 * v2 brutalist via MUpdateState (square corners, hard ink borders, mono labels,
 * full-fill accent hero). All colors are `--m-*` tokens so the worker dark
 * theme inverts cleanly.
 *
 * Production-only — `registerServiceWorker` no-ops outside of PROD bundles, so
 * dev still hot-reloads via Vite.
 */

/** Curated "what's new" copy mirroring the design's WHAT'S NEW list. */
const WHATS_NEW = ['AI auto-takeoff drafts', 'Cross-sheet reference jumps', 'Faster offline sync'] as const

export function UpdateBanner() {
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateSW, setUpdateSW] = useState<((reloadPage?: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!import.meta.env.PROD) return
    const update = registerServiceWorker({
      onNeedRefresh: () => {
        setNeedsRefresh(true)
        setDismissed(false)
      },
    })
    setUpdateSW(() => update)
  }, [])

  if (!needsRefresh || dismissed) return null

  const onReload = async () => {
    if (updating) return
    setUpdating(true)
    try {
      // updateSW(true) skips the waiting SW, takes control, and reloads.
      // Without the `true` arg, vite-plugin-pwa only sends SKIP_WAITING
      // and the user perceives nothing happening.
      if (updateSW) await updateSW(true)
    } catch {
      // Fall back to a manual reload — the new SW will activate when
      // every tab is closed, and the takeover re-shows after that.
      window.location.reload()
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update available"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'var(--m-sand)',
        overflowY: 'auto',
      }}
    >
      <MUpdateState
        title="Sitelayer got an update."
        body="Reload to keep using. Your work is safe."
        changes={WHATS_NEW}
        primaryLabel={updating ? 'Reloading…' : 'Reload app'}
        onPrimary={onReload}
        secondaryLabel="Later"
        onSecondary={() => setDismissed(true)}
      />
    </div>
  )
}

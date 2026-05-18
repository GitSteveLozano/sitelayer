import { useEffect, useState } from 'react'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { offlineMutationCount, subscribeOfflineMutations } from '@/lib/offline/queue'
import { replayOfflineQueue } from '@/lib/offline/replay'
import { cn } from '@/lib/cn'

/**
 * Sticky offline indicator. Renders when navigator.onLine is false OR
 * when there are pending queued mutations (a row could be queued from
 * a transient blip that's already cleared — we keep the banner up
 * until the queue drains).
 *
 * Offline copy explicitly calls out cached data so a foreman doesn't
 * make a field decision against a 5-minute-old financial snapshot
 * without knowing it. The badge becomes a warning-tone strip with the
 * cloud-off glyph; the inline pending-count is appended so they still
 * see how much work is sitting in the queue.
 *
 * Mounted inside AppShell so it shows on every screen.
 */
export function OfflineBanner() {
  const online = useOnlineStatus()
  const [pending, setPending] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void offlineMutationCount()
        .then((n) => {
          if (!cancelled) setPending(n)
        })
        .catch(() => {
          // IndexedDB unavailable (Safari private mode etc.) — leave at 0.
        })
    }
    refresh()
    const unsub = subscribeOfflineMutations(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  if (online && pending === 0) return null

  const offlineLabel =
    pending === 0
      ? 'Offline — showing cached data'
      : `Offline — showing cached data · ${pending} change${pending === 1 ? '' : 's'} will sync when you're back`

  return (
    <div
      className={cn(
        'sticky top-0 z-40 px-4 py-2',
        'flex items-center gap-3 text-[12px] font-medium',
        online ? 'bg-warn-soft text-warn' : 'bg-ink text-[#f3ecdf]',
      )}
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-online={online ? 'true' : 'false'}
    >
      {online ? (
        <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />
      ) : (
        // Cloud-off glyph — inline SVG so we don't pay for the lucide
        // dependency tree on every render. Sized to match the other
        // banner indicators.
        <svg
          className="w-3.5 h-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 2l20 20" />
          <path d="M5.2 5.2A8 8 0 0 0 12 19h6a4 4 0 0 0 1.7-7.6" />
          <path d="M9 5a8 8 0 0 1 12 4 4 4 0 0 1 .5 7.8" />
        </svg>
      )}
      <span className="flex-1 min-w-0 truncate">
        {online ? `${pending} change${pending === 1 ? '' : 's'} catching up…` : offlineLabel}
      </span>
      {online && pending > 0 ? (
        <button
          type="button"
          onClick={() => void replayOfflineQueue()}
          className="text-[11px] font-semibold underline-offset-2 hover:underline"
        >
          Retry now
        </button>
      ) : null}
    </div>
  )
}

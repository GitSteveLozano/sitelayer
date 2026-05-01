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

  return (
    <div
      className={cn(
        'sticky top-0 z-40 px-4 py-2',
        'flex items-center gap-3 text-[12px] font-medium',
        online ? 'bg-warn-soft text-warn' : 'bg-ink text-[#f3ecdf]',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">
        {online
          ? `${pending} change${pending === 1 ? '' : 's'} catching up…`
          : `Offline · ${pending} change${pending === 1 ? '' : 's'} will sync when you're back`}
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

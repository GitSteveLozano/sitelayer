import { useEffect, useState } from 'react'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { offlineMutationCount, subscribeOfflineMutations } from '@/lib/offline/queue'
import { replayOfflineQueue } from '@/lib/offline/replay'

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
 * v2 brutalist (aligned to V2StateOffline): offline is a full-fill ink
 * banner with a square red status block; the catching-up state stays an
 * amber-fill strip. Every color is a `--m-*` token (NOT a hardcoded hex)
 * so the worker dark theme (`.m-dark` shell wrapper) inverts it for
 * free — that's the V2StateOfflineWorker requirement.
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
      className="sticky top-0 z-40 px-5 py-3 flex items-center gap-3"
      style={{
        background: online ? 'var(--m-amber)' : 'var(--m-ink)',
        color: online ? '#fff' : 'var(--m-sand)',
        borderBottom: '2px solid var(--m-ink)',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-online={online ? 'true' : 'false'}
    >
      {online ? (
        // Square pulsing status block — catching up.
        <span
          className="shrink-0"
          style={{ width: 12, height: 12, background: 'currentColor' }}
          aria-hidden="true"
        />
      ) : (
        // Square red status block — offline. Brutalist: hard edges, full
        // fill, no glyph. Uses the red token so it inverts with the theme.
        <span
          className="shrink-0"
          style={{ width: 14, height: 14, background: 'var(--m-red)' }}
          aria-hidden="true"
        />
      )}
      <span className="flex-1 min-w-0 truncate">
        {online ? `${pending} change${pending === 1 ? '' : 's'} catching up…` : offlineLabel}
      </span>
      {online && pending > 0 ? (
        <button
          type="button"
          onClick={() => void replayOfflineQueue()}
          className="shrink-0"
          style={{
            background: 'transparent',
            border: '1.5px solid currentColor',
            color: 'inherit',
            borderRadius: 0,
            padding: '4px 10px',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Retry now
        </button>
      ) : null}
    </div>
  )
}

import { useEffect, useState } from 'react'

/**
 * Reactive online/offline status. Wraps `navigator.onLine` + the
 * `online`/`offline` window events.
 *
 * Note: navigator.onLine is famously fuzzy — it returns true for any
 * link-layer connectivity, not actual reachability of the API. The
 * replay engine treats every queued mutation's failure as the source
 * of truth; this hook is a UX prompt, not a gate.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => (typeof navigator === 'undefined' ? true : navigator.onLine))

  useEffect(() => {
    if (typeof window === 'undefined') return
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}

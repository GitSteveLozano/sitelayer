import { forceServiceWorkerUpdate } from './register'

/**
 * Build-version guard — the safety net under the service-worker auto-update.
 *
 * The SW lifecycle (register.ts) handles the normal case. This catches the
 * edge cases: a SW that's wedged, a browser that throttled update checks, or a
 * client that's been open across multiple deploys. It compares the build SHA
 * baked into THIS bundle (import.meta.env.VITE_BUILD_SHA, set at build time)
 * against the live server build from GET /api/version. On a mismatch it:
 *   1. asks the SW to update (which, via controllerchange, reloads the page);
 *   2. if no reload happens within a grace window (no SW / wedged), hard-reloads.
 *
 * No-ops when the build SHA is unknown ('dev' — local/unbuilt), so dev HMR is
 * untouched and tests don't reload.
 */

const CLIENT_BUILD = (import.meta.env.VITE_BUILD_SHA as string | undefined) ?? 'dev'
const CHECK_INTERVAL_MS = 5 * 60 * 1000
const RELOAD_GRACE_MS = 12 * 1000

let triggered = false
let started = false

interface VersionResponse {
  build_sha?: string
}

async function checkOnce(): Promise<void> {
  if (triggered) return
  if (document.visibilityState !== 'visible' || !navigator.onLine) return
  let server: VersionResponse
  try {
    const res = await fetch('/api/version', { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return
    server = (await res.json()) as VersionResponse
  } catch {
    return // network blip — try again next tick
  }
  const serverBuild = server.build_sha
  if (!serverBuild || serverBuild === CLIENT_BUILD) return

  // A newer (or just different) build is live. Apply it.
  triggered = true
  void forceServiceWorkerUpdate()
  // If the SW route didn't reload us (no controller / wedged SW), force it.
  // The page will already be gone if controllerchange fired first.
  window.setTimeout(() => {
    window.location.reload()
  }, RELOAD_GRACE_MS)
}

/**
 * Start the version guard. Production-only and only when a real build SHA was
 * baked in. Checks on start, on an interval, and whenever the tab refocuses.
 */
export function initVersionGuard(): void {
  if (started) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!import.meta.env.PROD) return
  if (CLIENT_BUILD === 'dev' || !CLIENT_BUILD) return
  started = true

  void checkOnce()
  window.setInterval(() => void checkOnce(), CHECK_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkOnce()
  })
}

import { registerSW } from 'virtual:pwa-register'

/**
 * Service-worker registration + auto-update lifecycle.
 *
 * `vite-plugin-pwa` (registerType: 'autoUpdate') generates the SW with
 * skipWaiting + clientsClaim, so a new deploy's SW installs, activates, and
 * claims open tabs without waiting. THAT ALONE DOES NOT REFRESH THE PAGE — the
 * tab keeps running the old JS/asset bundle under the new SW (the exact stale-
 * UI bug we hit in prod 2026-05-29). This module closes that gap:
 *
 *   1. `controllerchange` → reload once. When the new SW takes control
 *      (clientsClaim), reload the page so it picks up the new precached shell +
 *      asset graph. A sessionStorage flag guards against reload loops.
 *   2. Periodic `registration.update()` — long-open tabs (a foreman who leaves
 *      the app open all day) poll for a new SW every UPDATE_INTERVAL_MS and
 *      whenever the tab regains visibility, so a deploy propagates within
 *      ~minutes instead of "never until they close every tab".
 *
 * Combined with the version guard (src/pwa/version-guard.ts), a deploy reaches
 * every client with no manual cache-clear.
 *
 * Production-only: `registerSW` is a no-op in dev (Vite HMR owns reloads).
 */
export interface RegisterOptions {
  onNeedRefresh?: () => void
  onOfflineReady?: () => void
  onRegisterError?: (err: unknown) => void
}

// Re-check for a new SW this often on a long-open tab. 30 min is a balance
// between fast propagation and not hammering the network.
const UPDATE_INTERVAL_MS = 30 * 60 * 1000

let controllerChangeWired = false

/**
 * Reload the page when a NEW service worker replaces the one that was already
 * controlling this page (a new deploy taking over). Critically: if there was
 * NO controller when the page loaded (a first-ever visit, or the first load
 * after a SW reset), the first `controllerchange` is just the initial claim —
 * the page already has the current assets, so we must NOT reload (doing so
 * would spuriously double-load every first visit and break e2e). Capturing the
 * controller at load time and re-capturing on each subsequent page load makes
 * this correct across multiple deploys in one session.
 */
function wireControllerChangeReload(): void {
  if (controllerChangeWired) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  controllerChangeWired = true
  const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller)
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtLoad) return // initial claim — not a deploy swap
    if (refreshing) return
    refreshing = true
    window.location.reload()
  })
}

export function registerServiceWorker(opts: RegisterOptions = {}): (reloadPage?: boolean) => Promise<void> {
  wireControllerChangeReload()

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      // Periodic update check for long-lived tabs.
      const check = () => {
        // Only poll when online + visible — no point waking a backgrounded tab.
        if (document.visibilityState === 'visible' && navigator.onLine) {
          registration.update().catch(() => {})
        }
      }
      window.setInterval(check, UPDATE_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
    onNeedRefresh: () => opts.onNeedRefresh?.(),
    onOfflineReady: () => opts.onOfflineReady?.(),
    onRegisterError: (err) => opts.onRegisterError?.(err),
  })
  return updateSW
}

/**
 * Force the SW to check for an update now and, if one is found, activate it.
 * Used by the version guard when /api/version reports a newer build than the
 * one this tab is running. Returns true if a refresh was triggered.
 */
export async function forceServiceWorkerUpdate(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg) await reg.update()
  } catch {
    // ignore — the version guard falls back to a hard reload
  }
}

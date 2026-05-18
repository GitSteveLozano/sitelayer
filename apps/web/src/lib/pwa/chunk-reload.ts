// Stale-chunk recovery after a deploy.
//
// When the SPA is open during a deploy, any subsequent `React.lazy()`
// import points at an old hashed chunk URL (e.g.
// `/assets/takeoff-canvas-abc123.js`) that the deploy replaced with a
// new hash. The browser fetches the stale URL, gets a 404, and React
// throws a `ChunkLoadError` that crashes the route. The user sees a
// blank screen until they manually hit reload.
//
// Strategy: install a global `error` + `unhandledrejection` listener
// that detects the canonical chunk-load failure messages, logs a
// Sentry breadcrumb so we can correlate the crash with the deploy,
// then force `window.location.reload()` after ~500ms. A
// sessionStorage flag (`pwa.chunk-reload-attempted`) guards against
// infinite reload loops — if the reload also fails to fetch the new
// chunk (e.g. CDN propagation is incomplete) we don't keep cycling.
//
// We rely on the React 19 / TanStack Suspense error boundary to bubble
// the error up so the global handlers see it. The Sentry React
// ErrorBoundary in `instrument-sentry-boundary.tsx` re-throws once it
// reports, which keeps this path live.

import { Sentry } from '@/instrument'

const SESSION_FLAG = 'pwa.chunk-reload-attempted'
const RELOAD_DELAY_MS = 500

// Patterns the bundler / browser emits for a missing chunk. Vite/Rollup
// throws "Failed to fetch dynamically imported module" with the URL in
// the message; older toolchains throw "Loading chunk N failed" /
// "ChunkLoadError". Match all three case-insensitively.
const CHUNK_ERROR_PATTERN = /loading chunk|Failed to fetch dynamically imported module|ChunkLoadError/i

function extractMessage(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { message?: unknown }).message
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

function extractUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  // Vite embeds the chunk URL in `error.url` or in the message.
  const direct = (value as { url?: unknown }).url
  if (typeof direct === 'string') return direct
  const msg = extractMessage(value)
  // Heuristic: pull the first http(s):// substring from the message.
  const m = msg.match(/https?:\/\/\S+/)
  return m ? m[0] : null
}

/**
 * Returns true if the error/message looks like a stale-chunk failure.
 * Exported for unit-test coverage; the install side reuses it.
 */
export function isChunkLoadError(value: unknown): boolean {
  const msg = extractMessage(value)
  if (msg && CHUNK_ERROR_PATTERN.test(msg)) return true
  // Some browsers surface only `error.name`.
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name
    if (typeof name === 'string' && /ChunkLoadError/i.test(name)) return true
  }
  return false
}

function readReloadAttempted(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_FLAG) === '1'
  } catch {
    return false
  }
}

function writeReloadAttempted(): void {
  try {
    window.sessionStorage.setItem(SESSION_FLAG, '1')
  } catch {
    // sessionStorage failure (private mode etc.) — best-effort; without
    // the flag we may reload twice but that's still bounded by the
    // browser's own request cache.
  }
}

/**
 * Trigger a reload after a stale-chunk error. Idempotent: only the
 * first call per session schedules the reload; subsequent calls and
 * subsequent errors are no-ops. Exported so the React error boundary
 * can call it directly when an `errorInfo` comes through.
 *
 * Returns true if a reload was scheduled, false if the once-per-session
 * guard short-circuited or we're in a non-browser environment.
 */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === 'undefined') return false
  if (readReloadAttempted()) {
    // Don't loop. The second crash means the new chunk is also broken
    // (CDN propagation delay, bad deploy) — let the Sentry error
    // boundary render its fallback so the user sees an actionable
    // "Reload the page" message instead of a flicker.
    Sentry.addBreadcrumb({
      category: 'pwa',
      type: 'navigation',
      level: 'warning',
      message: 'pwa.chunk_reload skipped — already attempted this session',
      data: { error_message: extractMessage(error).slice(0, 200) },
    })
    return false
  }
  writeReloadAttempted()
  Sentry.addBreadcrumb({
    category: 'pwa',
    type: 'navigation',
    level: 'warning',
    message: 'pwa.chunk_reload',
    data: {
      error_message: extractMessage(error).slice(0, 200),
      chunk_url: extractUrl(error),
    },
  })
  // Small delay so the breadcrumb has a chance to flush and the user
  // perceives a brief beat instead of a hard flicker.
  window.setTimeout(() => {
    try {
      window.location.reload()
    } catch {
      // location.reload is technically `void` and shouldn't throw; the
      // catch is defensive against bizarre embedder behavior.
    }
  }, RELOAD_DELAY_MS)
  return true
}

/**
 * Wire up the global listeners. Idempotent — calling it twice from
 * tests / HMR doesn't double-fire. Returns a cleanup function used by
 * tests.
 */
export function installChunkReloadHandler(): () => void {
  if (typeof window === 'undefined') return () => {}
  const onError = (event: ErrorEvent) => {
    // event.error is the actual thrown value when the browser can
    // surface it; some legacy paths only populate `event.message`.
    const candidate = event.error ?? { message: event.message }
    if (isChunkLoadError(candidate)) {
      recoverFromChunkError(candidate)
    }
  }
  const onUnhandled = (event: PromiseRejectionEvent) => {
    if (isChunkLoadError(event.reason)) {
      recoverFromChunkError(event.reason)
    }
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandled)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandled)
  }
}

/** Exposed for tests so they can reset the once-per-session guard. */
export const __test = {
  SESSION_FLAG,
  RELOAD_DELAY_MS,
}

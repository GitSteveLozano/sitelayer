/**
 * Sentry bootstrap — kept as the single import point for the rest of the
 * SPA, but the heavy `@sentry/react` chunk is now lazy-loaded.
 *
 * Why: shipping the SDK on the critical path costs ~85 kB (gzip ~29 kB)
 * before first paint. The DSN check, `Sentry.init`, replay integration,
 * etc. all happen on `requestIdleCallback` after the app has rendered.
 *
 * How call sites stay simple: this module exports a `Sentry` facade
 * object that exposes the methods callers use (`captureException`,
 * `captureMessage`, `addBreadcrumb`, `getTraceData`). Before the real
 * SDK loads they are safe no-ops; once `loadSentry()` resolves they
 * delegate to the real `@sentry/react` exports. `Sentry.ErrorBoundary`
 * is handled separately — `main.tsx` mounts a `React.lazy` wrapper
 * (`./instrument-sentry-boundary`) so the boundary doesn't pull the
 * SDK into the eager graph either.
 *
 * Lazy-chunk tree-shaking: the dynamic import points at
 * `./instrument-sentry-impl`, not `@sentry/react` directly. That module
 * uses named imports so Rollup can shake out the integrations the SPA
 * doesn't reference (replay, profiler, react-router compat, ...).
 *
 * Tests: in `MODE === 'test'` the idle-callback bootstrap is skipped so
 * vitest runs (jsdom) never trigger a dynamic import of the SDK.
 */

import type { SentryImpl as SentryImplT } from './instrument-sentry-impl'

type CaptureContext = Parameters<SentryImplT['captureException']>[1]
type CaptureMessageContext = Parameters<SentryImplT['captureMessage']>[1]
type Breadcrumb = Parameters<SentryImplT['addBreadcrumb']>[0]
type TraceData = ReturnType<SentryImplT['getTraceData']>

let realSentry: SentryImplT | null = null
let loadPromise: Promise<SentryImplT | null> | null = null

const DSN = import.meta.env.VITE_SENTRY_DSN?.trim()
const ENV = (import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE || 'development') as string
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined

/**
 * Dynamically import the narrow Sentry impl module, run `init` once,
 * and cache the module on `realSentry` so subsequent facade calls
 * delegate to it.
 *
 * Idempotent — repeat calls return the same in-flight promise. Returns
 * `null` if dynamic import or `init` throws so callers never see a
 * rejected promise (we already silently no-op when Sentry isn't ready).
 */
export function loadSentry(): Promise<SentryImplT | null> {
  if (realSentry) return Promise.resolve(realSentry)
  if (loadPromise) return loadPromise
  loadPromise = import('./instrument-sentry-impl')
    .then(({ SentryImpl }) => {
      if (DSN) {
        try {
          SentryImpl.init({
            dsn: DSN,
            environment: ENV,
            release: RELEASE,
            // Tier-aware defaults match the eager version: prod 0.1,
            // everywhere else 1.0.
            tracesSampleRate: ENV === 'production' ? 0.1 : 1.0,
            sendDefaultPii: false,
          })
        } catch {
          // init failures must not break the host app — swallow and
          // continue with the facade no-op behavior.
        }
      }
      realSentry = SentryImpl
      return SentryImpl
    })
    .catch(() => null)
  return loadPromise
}

/**
 * Schedule the lazy load to run after first paint. Skipped in test
 * mode so vitest doesn't dynamically import the SDK during specs.
 */
function scheduleLazyInit(): void {
  if (import.meta.env.MODE === 'test') return
  if (typeof window === 'undefined') return
  const trigger = () => {
    void loadSentry()
  }
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (typeof ric === 'function') {
    ric(trigger)
  } else {
    window.setTimeout(trigger, 0)
  }
}

scheduleLazyInit()

/**
 * Facade exposing the subset of `@sentry/react` the SPA actually calls.
 * Methods are safe no-ops until `loadSentry()` resolves; afterwards they
 * delegate. `ErrorBoundary` is intentionally NOT on the facade — see
 * `instrument-sentry-boundary.tsx`, which `main.tsx` mounts via
 * `React.lazy`.
 */
export const Sentry = {
  captureException(error: unknown, context?: CaptureContext): string | undefined {
    return realSentry?.captureException(error, context)
  },
  captureMessage(message: string, context?: CaptureMessageContext): string | undefined {
    return realSentry?.captureMessage(message, context)
  },
  addBreadcrumb(breadcrumb: Breadcrumb): void {
    realSentry?.addBreadcrumb(breadcrumb)
  },
  getTraceData(): TraceData | undefined {
    return realSentry?.getTraceData?.()
  },
}

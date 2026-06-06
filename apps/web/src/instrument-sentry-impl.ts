/**
 * Concrete Sentry implementation — imported lazily by `instrument.ts`.
 *
 * Why this file exists: the facade in `instrument.ts` only needs a small
 * subset of `@sentry/react` (init, captureException, captureMessage,
 * addBreadcrumb, getTraceData). When Vite/Rollup processes a dynamic
 * `import('@sentry/react')` the namespace access pattern (`mod.init`,
 * `mod.captureException`, ...) defeats tree-shaking and the whole SDK —
 * replay, profiler, react-router integrations — lands in the lazy chunk.
 *
 * Splitting the call sites into this module lets Rollup see the actual
 * named imports (`{ init, captureException, ... }`) and tree-shake the
 * unused integrations out of the lazy chunk. The result is one async
 * vendor-sentry chunk that's roughly the same size as the old eager
 * one, just no longer on the critical path.
 */
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  ErrorBoundary,
  getTraceData,
  init,
  replayIntegration,
} from '@sentry/react'

export type SentryInitOptions = Parameters<typeof init>[0]

export const SentryImpl = {
  init,
  addBreadcrumb,
  captureException,
  captureMessage,
  getTraceData,
  ErrorBoundary,
  replayIntegration,
}

export type SentryImpl = typeof SentryImpl

/**
 * Lazy-loadable Sentry ErrorBoundary entry point.
 *
 * `main.tsx` mounts this via `React.lazy(() => import('./instrument-sentry-boundary'))`
 * so the `@sentry/react` chunk is only fetched when React asks for it.
 * Before the chunk arrives a `<Suspense>` fallback renders the children
 * directly — there is no spinner; the boundary is "transparent" while
 * loading so first paint isn't blocked by the SDK download.
 *
 * The boundary imports from `./instrument-sentry-impl` (the narrow named
 * re-export) rather than `@sentry/react` directly so Vite can lift it
 * into the same lazy vendor-sentry chunk created by `instrument.ts`.
 *
 * Once the chunk has loaded `loadSentry()` (in `instrument.ts`) is also
 * invoked from this module so subsequent calls to the facade's
 * `captureException` / `addBreadcrumb` / `getTraceData` immediately
 * benefit from the real SDK without waiting on the idle callback.
 */
import { type ReactNode } from 'react'
import { SentryImpl } from './instrument-sentry-impl'
import { loadSentry } from './instrument'

// Touching the real SDK from this lazy module ensures `loadSentry()`
// completes (and the facade flips to real implementations) at the same
// time React begins rendering the boundary — no double-import, no
// duplicate `Sentry.init`.
void loadSentry()

const { ErrorBoundary } = SentryImpl

type Props = {
  children?: ReactNode
  fallback: ReactNode
}

function SentryBoundary({ children, fallback }: Props) {
  return <ErrorBoundary fallback={() => <>{fallback}</>}>{children}</ErrorBoundary>
}

export default SentryBoundary

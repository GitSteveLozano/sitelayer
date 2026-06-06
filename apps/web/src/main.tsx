// instrument.ts must be the first import — Sentry needs to wrap everything.
// (Now a thin facade; the real @sentry/react module is lazy-loaded on
// `requestIdleCallback` after first paint, so this import is cheap.)
import './instrument'
import { lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installDemoTierNoIndex } from './lib/demo/robots-noindex'
import { startOfflineReplayLoop } from './lib/offline/replay'
import { installChunkReloadHandler } from './lib/pwa/chunk-reload'
import { initVersionGuard } from './pwa/version-guard'
import './styles/globals.css'
// m.css is the design-token + component CSS for the mobile shell at /m/*
// (migrated from apps/web in #229). Loaded eagerly so /m routes render
// without a flash of unstyled content; the rules are scoped under .m-*
// classes so they don't bleed into v2's main routes.
import './styles/m.css'
// portal.css = scoped --p-* tokens for the public/unauthenticated customer
// portal screens (apps/web/src/portal/*). Holds the legacy neutral-grey /
// slate values verbatim so removing inline hex causes no visual change.
import './styles/portal.css'
// d.css = the Desktop v2 "command center" primitives (.d-* classes) for the
// >=1024px owner/estimator surface. Scoped under .d-* so it doesn't bleed
// into the mobile (.m-*) rules; shares the v2 tokens from tokens.css/m.css.
import './styles/d.css'

// Lazy-load Sentry's React error boundary so the SDK stays out of the
// eager graph. Suspense fallback renders the children directly — no
// spinner — so the app is visible while @sentry/react streams in.
const SentryBoundary = lazy(() => import('./instrument-sentry-boundary'))

// Site-wide robots noindex on the demo tier (no-op everywhere else). Runs
// before render so the tag is in <head> as early as possible. See
// lib/demo/robots-noindex.ts.
installDemoTierNoIndex()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

const root = createRoot(container)

root.render(
  <StrictMode>
    <LazyErrorBoundary fallback={(info) => <RootError eventId={info.eventId} />}>
      <App />
    </LazyErrorBoundary>
  </StrictMode>,
)

// SW registration moved into <UpdateBanner /> in the AppShell so the
// "new version available" UI ships alongside the registration call.
// The banner mounts in PROD and surfaces the update prompt; in DEV we
// skip the SW entirely and rely on Vite's HMR.

// Offline mutation queue + replay loop (1E.6). Boots regardless of SW
// availability so the queue still works in dev / Safari private mode.
startOfflineReplayLoop()

// Stale-chunk recovery. After a deploy any React.lazy() import that
// targets an old hashed asset URL 404s; the global handlers catch the
// resulting ChunkLoadError / "Failed to fetch dynamically imported
// module" and force one reload per session to pick up the new bundle.
installChunkReloadHandler()

// Build-version guard: detects a newer server build (vs the SHA baked into
// this bundle) and applies it via the SW / a hard reload, so a deploy reaches
// every client without a manual cache-clear. No-op in dev / unbuilt.
initVersionGuard()

function LazyErrorBoundary({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: (info: { eventId?: string | undefined }) => ReactNode
}) {
  // Suspense fallback IS the children: while the Sentry boundary chunk
  // is loading the app renders unprotected (the entire SPA wouldn't be
  // crashing during the 1-frame load anyway). This avoids the user
  // staring at a spinner waiting for an SDK that isn't blocking paint.
  return (
    <Suspense fallback={<>{children}</>}>
      <SentryBoundary fallback={fallback}>{children}</SentryBoundary>
    </Suspense>
  )
}

function RootError({ eventId }: { eventId?: string | undefined }) {
  // Give the user a copy-pasteable block to quote in a report. error id ->
  // Sentry; time + page -> the incident tool's vague lookup
  // (scripts/incident.ts --around <time> --route <page>). Without this, an
  // unhandled-error report has nothing to trace from.
  const ref = [
    eventId ? `error id: ${eventId}` : null,
    `time: ${new Date().toISOString()}`,
    typeof location !== 'undefined' ? `page: ${location.pathname}${location.search}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Sitelayer hit an error.</h1>
      <p style={{ fontSize: 14, color: '#5b544c' }}>
        Reload the page. If this keeps happening, ping #sitelayer-support and include this:
      </p>
      <pre
        style={{
          fontSize: 12,
          background: '#f5f3f0',
          border: '1px solid #e0dcd5',
          borderRadius: 6,
          padding: 12,
          marginTop: 8,
          whiteSpace: 'pre-wrap',
        }}
      >
        {ref}
      </pre>
    </div>
  )
}

// instrument.ts must be the first import — Sentry needs to wrap everything.
// (Now a thin facade; the real @sentry/react module is lazy-loaded on
// `requestIdleCallback` after first paint, so this import is cheap.)
import './instrument'
import { lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startOfflineReplayLoop } from './lib/offline/replay'
import { installChunkReloadHandler } from './lib/pwa/chunk-reload'
import './styles/globals.css'
// m.css is the design-token + component CSS for the mobile shell at /m/*
// (migrated from apps/web in #229). Loaded eagerly so /m routes render
// without a flash of unstyled content; the rules are scoped under .m-*
// classes so they don't bleed into v2's main routes.
import './styles/m.css'

// Lazy-load Sentry's React error boundary so the SDK stays out of the
// eager graph. Suspense fallback renders the children directly — no
// spinner — so the app is visible while @sentry/react streams in.
const SentryBoundary = lazy(() => import('./instrument-sentry-boundary'))

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

const root = createRoot(container)

root.render(
  <StrictMode>
    <LazyErrorBoundary fallback={<RootError />}>
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

function LazyErrorBoundary({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
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

function RootError() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Sitelayer hit an error.</h1>
      <p style={{ fontSize: 14, color: '#5b544c' }}>
        Reload the page. If this keeps happening, ping #sitelayer-support.
      </p>
    </div>
  )
}

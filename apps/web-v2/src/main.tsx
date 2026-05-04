// instrument.ts must be the first import — Sentry needs to wrap everything.
import { Sentry } from './instrument'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startOfflineReplayLoop } from './lib/offline/replay'
import './styles/globals.css'
// m.css is the design-token + component CSS for the mobile shell at /m/*
// (migrated from apps/web in #229). Loaded eagerly so /m routes render
// without a flash of unstyled content; the rules are scoped under .m-*
// classes so they don't bleed into v2's main routes.
import './styles/m.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

const root = createRoot(container)

root.render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<RootError />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

// SW registration moved into <UpdateBanner /> in the AppShell so the
// "new version available" UI ships alongside the registration call.
// The banner mounts in PROD and surfaces the update prompt; in DEV we
// skip the SW entirely and rely on Vite's HMR.

// Offline mutation queue + replay loop (1E.6). Boots regardless of SW
// availability so the queue still works in dev / Safari private mode.
startOfflineReplayLoop()

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

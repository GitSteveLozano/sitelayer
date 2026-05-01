// instrument.ts must be the first import — Sentry needs to wrap everything.
import { Sentry } from './instrument'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './pwa/register'
import './styles/globals.css'

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

// Phase 0 registers the SW passively — no toast, no auto-reload. UI for
// "new version available" lands in Phase 1 with the offline mutation queue.
if (import.meta.env.PROD) {
  registerServiceWorker({
    onRegisterError: (err) => Sentry.captureException(err),
  })
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

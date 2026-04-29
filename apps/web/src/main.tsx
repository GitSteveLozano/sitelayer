import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { App } from './App.js'
import { Button } from './components/ui/button.js'
import { FIXTURES_ENABLED } from './api.js'
import { captureException, initSentry } from './instrument.js'
import { installSupportRecorder } from './support-recorder.js'
import './styles.css'
import './components/ui/mobile.css'

const BUILD_ID = import.meta.env.VITE_SENTRY_RELEASE || import.meta.env.MODE || 'local'
const CHUNK_RELOAD_STORAGE_KEY = 'sitelayer.chunk-reload-build'

function runWhenIdle(run: () => void, timeout: number) {
  if (typeof window === 'undefined') return
  const requestIdleCallback = window.requestIdleCallback
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout })
  } else {
    globalThis.setTimeout(run, 1000)
  }
}

function getChunkErrorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name} ${error.message}`
  return String(error)
}

function isChunkLoadError(error: unknown) {
  return /ChunkLoadError|CSS_CHUNK_LOAD_FAILED|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    getChunkErrorMessage(error),
  )
}

function reloadOnceForChunkError(error: unknown, force = false) {
  if (typeof window === 'undefined') return false
  if (!force && !isChunkLoadError(error)) return false

  try {
    if (window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY) === BUILD_ID) return false
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, BUILD_ID)
  } catch {
    return false
  }

  window.location.reload()
  return true
}

function installChunkRecovery() {
  if (typeof window === 'undefined') return

  window.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload ?? event
    captureException(payload, { tags: { scope: 'vite_preload_error' } })
    if (reloadOnceForChunkError(payload, true)) {
      event.preventDefault()
    }
  })
}

// Kick off the Sentry SDK dynamic import immediately so that early errors
// (which can land before the browser goes idle on slow devices or offline)
// still reach the captureException buffer. Web vitals stay deferred.
initSentry()
installSupportRecorder()
runWhenIdle(() => {
  void import('./web-vitals.js').then(({ captureWebVitals }) => captureWebVitals())
}, 4000)
installChunkRecovery()

// Sitelayer Clerk theming. The color values mirror the HSL triplets declared in
// styles.css (`--primary`, `--background`, etc.) so the hosted <SignIn>/<SignUp>
// widgets match the rest of the SPA. Keep these in sync if styles.css rotates.
const clerkAppearance = {
  layout: {
    logoImageUrl: '/sitelayer-logo.svg',
    logoPlacement: 'inside' as const,
  },
  variables: {
    colorPrimary: 'hsl(25, 78%, 46%)',
    colorBackground: 'hsl(0, 0%, 100%)',
    colorText: 'hsl(210, 18%, 14%)',
    colorInputBackground: 'hsl(210, 24%, 97%)',
    colorInputText: 'hsl(210, 18%, 14%)',
    borderRadius: '8px',
    fontFamily: 'inherit',
  },
  elements: {
    card: 'sitelayer-clerk-card',
    rootBox: 'sitelayer-clerk-root',
  },
}

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!PUBLISHABLE_KEY && !FIXTURES_ENABLED) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set; the SPA cannot mount without a Clerk frontend key')
}

function FallbackError({ error, resetError }: { error: unknown; resetError: () => void }) {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred. The Sitelayer team has been notified.</p>
      <pre style={{ background: '#fee', padding: '1rem', whiteSpace: 'pre-wrap' }}>
        {error instanceof Error ? error.message : String(error)}
      </pre>
      <Button type="button" onClick={resetError}>
        Try again
      </Button>
    </div>
  )
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: unknown | null }> {
  state = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    captureException(error, { tags: { scope: 'react_error_boundary' } })
    reloadOnceForChunkError(error)
  }

  resetError = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return <FallbackError error={this.state.error} resetError={this.resetError} />
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      {FIXTURES_ENABLED || !PUBLISHABLE_KEY ? (
        <App />
      ) : (
        <ClerkProvider publishableKey={PUBLISHABLE_KEY} appearance={clerkAppearance}>
          <App />
        </ClerkProvider>
      )}
    </AppErrorBoundary>
  </React.StrictMode>,
)

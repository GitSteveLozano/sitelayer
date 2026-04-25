import { Sentry } from './instrument.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.js'
import { Button } from './components/ui/button.js'
import { captureWebVitals } from './web-vitals.js'
import './styles.css'

captureWebVitals()

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={FallbackError} showDialog={false}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)

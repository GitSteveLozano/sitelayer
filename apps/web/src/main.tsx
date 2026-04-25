import { Sentry } from './instrument.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { App } from './App.js'
import { Button } from './components/ui/button.js'
import { FIXTURES_ENABLED } from './api.js'
import { captureWebVitals } from './web-vitals.js'
import './styles.css'
import './components/ui/mobile.css'

captureWebVitals()

// Sitelayer Clerk theming. The color values mirror the HSL triplets declared in
// styles.css (`--primary`, `--background`, etc.) so the hosted <SignIn>/<SignUp>
// widgets match the rest of the SPA. Keep these in sync if styles.css rotates.
const clerkAppearance = {
  layout: {
    logoImageUrl: '/sitelayer-logo.svg',
    logoPlacement: 'inside' as const,
  },
  variables: {
    colorPrimary: 'hsl(204, 94%, 67%)',
    colorBackground: 'hsl(222, 47%, 5%)',
    colorText: 'hsl(226, 100%, 97%)',
    colorInputBackground: 'hsl(218, 25%, 17%)',
    colorInputText: 'hsl(226, 100%, 97%)',
    borderRadius: '6px',
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={FallbackError} showDialog={false}>
      {FIXTURES_ENABLED || !PUBLISHABLE_KEY ? (
        <App />
      ) : (
        <ClerkProvider publishableKey={PUBLISHABLE_KEY} appearance={clerkAppearance}>
          <App />
        </ClerkProvider>
      )}
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)

/**
 * Sentry bootstrap — imported first by main.tsx so the SDK is wired
 * before any other code runs. Mirrors apps/web/src/instrument.* in
 * principle (lazy-loaded, low overhead in dev, opt-in via env DSN) but
 * is intentionally minimal in Phase 0.
 *
 * Phase 5 will add: replay integration (text-masking + media-masking),
 * web-vitals reporting, offline-queue replay span, and stale-chunk
 * reload recovery on the React error boundary. Don't pre-build them
 * here — substrate only.
 */
import * as Sentry from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN?.trim()
const ENV = (import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() ||
  import.meta.env.MODE ||
  'development') as string
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    release: RELEASE,
    // Tier-aware defaults match v1: prod 0.1, everywhere else 1.0.
    tracesSampleRate: ENV === 'production' ? 0.1 : 1.0,
    sendDefaultPii: false,
  })
}

export { Sentry }

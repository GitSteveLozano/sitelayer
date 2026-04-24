interface ImportMetaEnv {
  readonly MODE?: string
  readonly VITE_API_URL?: string
  readonly VITE_APP_TIER?: string
  readonly VITE_COMPANY_SLUG?: string
  readonly VITE_FIXTURES?: string
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string
  readonly VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE?: string
  readonly VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE?: string
  readonly VITE_USER_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

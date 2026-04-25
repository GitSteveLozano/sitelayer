import * as Sentry from '@sentry/node'
import { loadLocalEnv } from '@sitelayer/config'
import { registerSentry } from '@sitelayer/logger'

loadLocalEnv()

const dsn = process.env.SENTRY_WORKER_DSN ?? process.env.SENTRY_DSN
const tier = process.env.APP_TIER ?? 'local'
const defaultTraceRate = tier === 'prod' ? 0.1 : 1.0

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? tier ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? defaultTraceRate),
    sendDefaultPii: false,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.postgresIntegration(),
      Sentry.contextLinesIntegration(),
    ],
  })
}

registerSentry({
  getActiveSpan: () => {
    const span = Sentry.getActiveSpan()
    if (!span) return undefined
    return { spanContext: () => span.spanContext() }
  },
})

export { Sentry }

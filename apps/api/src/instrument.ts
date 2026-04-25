import * as Sentry from '@sentry/node'
import { loadLocalEnv } from '@sitelayer/config'
import { registerSentry } from '@sitelayer/logger'

loadLocalEnv()

const dsn = process.env.SENTRY_DSN
const tier = process.env.APP_TIER ?? 'local'
const defaultTraceRate = tier === 'prod' ? 0.1 : 1.0
const configuredTraceRate = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim()
const traceRate =
  configuredTraceRate === undefined || configuredTraceRate === ''
    ? defaultTraceRate
    : Math.min(1, Math.max(0, Number(configuredTraceRate)))

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? tier ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number.isFinite(traceRate) ? traceRate : defaultTraceRate,
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

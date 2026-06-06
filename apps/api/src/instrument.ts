import * as Sentry from '@sentry/node'
import { loadLocalEnv } from '@sitelayer/config'
import { registerSentry } from '@sitelayer/logger'
import { scrubSentryEvent, type ScrubbableEvent } from './sentry-scrub.js'

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
    // Single-pane logs: ship structured log records to Sentry Logs keyed by
    // the active trace_id. The @sitelayer/logger Pino hook mirrors each record
    // into Sentry.logger.*; consoleLoggingIntegration catches any stray
    // console.* writes. No-op without a DSN (this whole block is DSN-guarded).
    enableLogs: true,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.postgresIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend(event) {
      return scrubSentryEvent(event as ScrubbableEvent) as typeof event
    },
    beforeSendTransaction(event) {
      return scrubSentryEvent(event as ScrubbableEvent) as typeof event
    },
  })
}

registerSentry({
  getActiveSpan: () => {
    const span = Sentry.getActiveSpan()
    if (!span) return undefined
    return { spanContext: () => span.spanContext() }
  },
  // Pino records flow here. When Sentry has no DSN these calls are inert.
  logger: Sentry.logger,
})

/**
 * Entity context shape used as Sentry tags on captured exceptions /
 * messages. Every field is optional so call sites in partially-typed
 * paths can pass what they have; helper drops `undefined` keys before
 * forwarding to Sentry so we don't emit empty-string tags.
 */
export type EntityContext = {
  entity_type?: string
  entity_id?: string
  company_id?: string
  scope?: string
  workflow_name?: string
  /** Additional tags merged in last; useful for ad-hoc keys like outbox_id. */
  extra_tags?: Record<string, string | number | boolean | undefined>
}

function buildEntityTags(ctx: EntityContext): Record<string, string> {
  const out: Record<string, string> = {}
  if (ctx.entity_type) out.entity_type = ctx.entity_type
  if (ctx.entity_id) out.entity_id = ctx.entity_id
  if (ctx.company_id) out.company_id = ctx.company_id
  if (ctx.scope) out.scope = ctx.scope
  if (ctx.workflow_name) out.workflow_name = ctx.workflow_name
  if (ctx.extra_tags) {
    for (const [k, v] of Object.entries(ctx.extra_tags)) {
      if (v === undefined || v === null) continue
      out[k] = String(v)
    }
  }
  return out
}

/**
 * Capture an exception with entity-scoped tags. Use this everywhere a
 * thrown error happens inside an entity context (a specific
 * outbox row, a specific company sync, a workflow event) so Sentry
 * issues can be filtered/grouped on the same dimensions the rest of
 * the observability stack uses.
 */
export function captureWithEntityContext(err: unknown, ctx: EntityContext): void {
  Sentry.captureException(err, { tags: buildEntityTags(ctx) })
}

/**
 * Companion helper for `Sentry.captureMessage`. Same tag conventions
 * as `captureWithEntityContext`; pass `level` to override the default
 * 'warning'.
 */
export function captureMessageWithEntityContext(
  message: string,
  ctx: EntityContext & { level?: Sentry.SeverityLevel; extra?: Record<string, unknown> },
): void {
  const { level, extra, ...rest } = ctx
  Sentry.captureMessage(message, {
    level: level ?? 'warning',
    tags: buildEntityTags(rest),
    ...(extra ? { extra } : {}),
  })
}

export { Sentry }

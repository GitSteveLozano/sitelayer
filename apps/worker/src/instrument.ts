import * as Sentry from '@sentry/node'
import { loadLocalEnv } from '@sitelayer/config'
import { registerSentry } from '@sitelayer/logger'

loadLocalEnv()

const dsn = process.env.SENTRY_WORKER_DSN ?? process.env.SENTRY_DSN
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

/**
 * Entity context shape used as Sentry tags on captured exceptions /
 * messages. Mirrors the API helper in apps/api/src/instrument.ts —
 * keep the two in sync. We don't share via @sitelayer/logger because
 * each binary owns its own Sentry SDK instance.
 */
export type EntityContext = {
  entity_type?: string
  entity_id?: string
  company_id?: string
  scope?: string
  workflow_name?: string
  /** Additional tags merged in last; useful for outbox_id, mutation_type, etc. */
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

export function captureWithEntityContext(err: unknown, ctx: EntityContext): void {
  Sentry.captureException(err, { tags: buildEntityTags(ctx) })
}

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

import { AsyncLocalStorage } from 'node:async_hooks'
import pino, { type Logger, type LoggerOptions } from 'pino'

export interface RequestContext {
  requestId: string
  companySlug?: string
  companyId?: string
  userId?: string
  actorUserId?: string
  /** The real impersonator (Clerk `act` sub) during an audited impersonation
   *  session. recordAudit() stamps audit_events.impersonated_by from this. */
  impersonatedBy?: string
  actorRole?: string
  captureSessionId?: string
  route?: string
  method?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

function readSentryIds(): { trace_id?: string; span_id?: string } {
  const sentry = (globalThis as { __sentry_client__?: unknown }).__sentry_client__
  if (!sentry) return {}
  try {
    type ActiveSpan = { spanContext?: () => { traceId: string; spanId: string } }
    const getActiveSpan = (sentry as { getActiveSpan?: () => ActiveSpan }).getActiveSpan
    if (typeof getActiveSpan !== 'function') return {}
    const span = getActiveSpan()
    const ctx = span?.spanContext?.()
    if (!ctx) return {}
    return { trace_id: ctx.traceId, span_id: ctx.spanId }
  } catch {
    return {}
  }
}

/** Subset of `Sentry.logger` we forward Pino records into. Each method takes a
 *  message plus a structured-attributes bag. Optional so a Sentry build/version
 *  without the Logs API (or no DSN) is a no-op. */
export type SentryLoggerSink = {
  trace?: (message: string, attributes?: Record<string, unknown>) => void
  debug?: (message: string, attributes?: Record<string, unknown>) => void
  info?: (message: string, attributes?: Record<string, unknown>) => void
  warn?: (message: string, attributes?: Record<string, unknown>) => void
  error?: (message: string, attributes?: Record<string, unknown>) => void
  fatal?: (message: string, attributes?: Record<string, unknown>) => void
}

export type SentryAccessors = {
  getActiveSpan: () => { spanContext: () => { traceId: string; spanId: string } } | undefined
  /** When provided AND Sentry logging is enabled, Pino records created via
   *  createLogger() are mirrored here keyed by the already-stamped trace_id. */
  logger?: SentryLoggerSink
}

export function registerSentry(sentry: SentryAccessors): void {
  ;(globalThis as { __sentry_client__?: unknown }).__sentry_client__ = sentry
}

function readSentryLogSink(): SentryLoggerSink | undefined {
  const sentry = (globalThis as { __sentry_client__?: unknown }).__sentry_client__
  if (!sentry) return undefined
  const sink = (sentry as { logger?: SentryLoggerSink }).logger
  return sink && typeof sink === 'object' ? sink : undefined
}

// Map Pino numeric levels to the Sentry logger method names.
const PINO_LEVEL_TO_SENTRY: Record<number, keyof SentryLoggerSink> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

/** Pino `hooks.logMethod` that mirrors each record into the registered Sentry
 *  logger sink (if any). No-op when Sentry isn't configured: `registerSentry`
 *  is called without a `logger`, or no DSN means `Sentry.logger.*` does nothing.
 *  Failures here are swallowed so logging never breaks the request path. */
function forwardToSentry(
  this: Logger,
  args: Parameters<Logger['info']>,
  method: (...a: unknown[]) => void,
  level: number,
): void {
  try {
    const sink = readSentryLogSink()
    if (sink) {
      const fn = sink[PINO_LEVEL_TO_SENTRY[level] ?? 'info']
      if (typeof fn === 'function') {
        const [first, second] = args as unknown[]
        let message: string
        let attrs: Record<string, unknown> | undefined
        if (typeof first === 'string') {
          message = first
        } else {
          // Pino's (obj, msg) form: object first, message second.
          attrs = first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined
          message = typeof second === 'string' ? second : ''
        }
        if (message) fn(message, attrs)
      }
    }
  } catch {
    // never let Sentry forwarding break a log call
  }
  method.apply(this, args as unknown[])
}

export function createLogger(service: string, opts: LoggerOptions = {}): Logger {
  const base: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    base: { service, tier: process.env.APP_TIER ?? 'local' },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = storage.getStore()
      const sentryIds = readSentryIds()
      return { ...sentryIds, ...(ctx ? ctx : {}) }
    },
    // Mirror every record into Sentry's Logs sink (single-pane logs).
    // No-op when registerSentry() was called without a `logger` accessor
    // or when Sentry has no DSN — the sink's methods just don't fire.
    hooks: {
      logMethod: forwardToSentry,
    },
    ...opts,
  }
  return pino(base)
}

export type { Logger, LoggerOptions }

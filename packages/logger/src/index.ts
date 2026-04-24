import { AsyncLocalStorage } from 'node:async_hooks'
import pino, { type Logger, type LoggerOptions } from 'pino'

export interface RequestContext {
  requestId: string
  companySlug?: string
  userId?: string
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

export type SentryAccessors = {
  getActiveSpan: () => { spanContext: () => { traceId: string; spanId: string } } | undefined
}

export function registerSentry(sentry: SentryAccessors): void {
  ;(globalThis as { __sentry_client__?: unknown }).__sentry_client__ = sentry
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
    ...opts,
  }
  return pino(base)
}

export type { Logger, LoggerOptions }

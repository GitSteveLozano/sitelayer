import type http from 'node:http'
// NOTE: import `@sentry/node` directly here rather than going through
// `./instrument.js`. The instrument module side-effects `Sentry.init()` when
// SENTRY_DSN is set (production / dev with .env.local loaded), which swaps
// the SDK's async context strategy to OpenTelemetry. We don't want a
// downstream require of this module to drag instrument.ts into
// vitest-loaded test files, because that triggers the same init from
// hoisted .env values and silently changes propagation semantics under the
// test. Importing the SDK alone here keeps the helper unit-testable.
import * as Sentry from '@sentry/node'

// ---------------------------------------------------------------------------
// Inbound trace propagation. Sitelayer already PERSISTS sentry-trace +
// baggage onto audit_events, mutation_outbox, sync_event_log, and
// context_handoff_events via mutation-tx.ts:currentTraceHeaders(). But until
// this module shipped, the request handler did not READ the incoming
// `sentry-trace` and `baggage` headers, so each request started a fresh
// trace and the downstream ledger rows recorded that fresh trace_id — not
// the upstream client's. That broke end-to-end "follow the trace" claims:
// the SPA / collaborator script could emit a sentry-trace and Sitelayer
// would silently drop it.
//
// continueTrace() in @sentry/node@10 is the OTel-backed continuation API:
// given the wire-format header pair, it installs the incoming propagation
// context on the active scope so spans + breadcrumbs + captured exceptions
// inherit the upstream trace_id. We invoke it BEFORE the isolation scope
// and BEFORE Sentry.startSpan() in server.ts so the root span IS the
// continuation, not a parallel sibling.
//
// Health/metrics probes are bypassed — they hit the API many times per
// minute, never carry trace headers, and have no downstream work. Running
// continueTrace per probe burns cycles for no signal.
// ---------------------------------------------------------------------------

/**
 * Routes that bypass trace continuation. These are operator probes (load
 * balancer healthcheck, Prometheus scrape) with no upstream caller and no
 * downstream effect. Returning fast keeps them off the trace timeline.
 */
const TRACE_BYPASS_PATHS = new Set<string>(['/health', '/api/metrics'])

export function shouldBypassTraceContinuation(pathname: string): boolean {
  return TRACE_BYPASS_PATHS.has(pathname)
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined
  if (typeof value === 'string') return value.trim() || undefined
  return undefined
}

/**
 * Pull the `sentry-trace` and `baggage` request headers in the shape
 * @sentry/node's continueTrace expects. Header lookup is case-insensitive
 * (Node lowercases header keys); we still normalize the value with
 * firstHeader() so a multi-value baggage header doesn't blow up.
 */
export function extractTraceHeaders(headers: http.IncomingHttpHeaders): {
  sentryTrace: string | undefined
  baggage: string | undefined
} {
  return {
    sentryTrace: firstHeader(headers['sentry-trace']),
    baggage: firstHeader(headers['baggage']),
  }
}

/**
 * Wrap `fn` inside `Sentry.continueTrace(...)` when the incoming request
 * carries `sentry-trace` (the wire-format trace continuation header). If
 * the header is absent, this is still safe: continueTrace generates a
 * fresh propagation context. Call this BEFORE establishing the per-request
 * isolation scope so the scope inherits the continued context.
 *
 * The callback shape mirrors continueTrace itself: it's synchronous and
 * returns whatever the inner callback returns. The inner callback is a
 * promise-returning function in server.ts, but continueTrace doesn't
 * await; it just propagates the active scope into the synchronous portion
 * of the callback, which is enough for the AsyncLocalStorage that backs
 * Sentry's OTel context manager to carry the trace through the awaits.
 */
export function continueRequestTrace<T>(headers: http.IncomingHttpHeaders, fn: () => T): T {
  const { sentryTrace, baggage } = extractTraceHeaders(headers)
  return Sentry.continueTrace({ sentryTrace, baggage }, fn)
}

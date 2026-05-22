import { describe, expect, it } from 'vitest'
import * as Sentry from '@sentry/node'
import { continueRequestTrace, extractTraceHeaders, shouldBypassTraceContinuation } from './trace-ingress.js'

// ---------------------------------------------------------------------------
// Smoke check: incoming `sentry-trace` continuation. The proving-ground plan
// (docs/PROVING_GROUND_PLAN.md, "Wedge: Trace Propagation Patch") flagged
// the API ingress as the boundary break that invalidated end-to-end trace
// claims downstream. This test pins the contract: given an incoming
// `sentry-trace` header carrying a known trace_id, the active scope's
// propagation context inside the handler MUST inherit that trace_id.
//
// We don't initialize Sentry here — continueTrace + getCurrentScope work
// against the no-op client when no DSN is configured, which is exactly the
// vitest unit-test environment. The propagation context still carries the
// trace_id even with the no-op client; that's the contract we're pinning.
// ---------------------------------------------------------------------------

describe('extractTraceHeaders', () => {
  it('reads sentry-trace and baggage headers when present', () => {
    expect(
      extractTraceHeaders({
        'sentry-trace': '0123456789abcdef0123456789abcdef-0011223344556677-1',
        baggage: 'sentry-environment=prod,sentry-public_key=abc',
      }),
    ).toEqual({
      sentryTrace: '0123456789abcdef0123456789abcdef-0011223344556677-1',
      baggage: 'sentry-environment=prod,sentry-public_key=abc',
    })
  })

  it('returns undefined when headers are missing', () => {
    expect(extractTraceHeaders({})).toEqual({ sentryTrace: undefined, baggage: undefined })
  })

  it('takes the first value of a multi-value header', () => {
    expect(
      extractTraceHeaders({
        baggage: ['sentry-environment=prod', 'sentry-environment=dev'],
      }),
    ).toEqual({ sentryTrace: undefined, baggage: 'sentry-environment=prod' })
  })

  it('treats blank/whitespace headers as absent', () => {
    expect(
      extractTraceHeaders({
        'sentry-trace': '   ',
        baggage: '',
      }),
    ).toEqual({ sentryTrace: undefined, baggage: undefined })
  })
})

describe('shouldBypassTraceContinuation', () => {
  it('bypasses /health', () => {
    expect(shouldBypassTraceContinuation('/health')).toBe(true)
  })

  it('bypasses /api/metrics', () => {
    expect(shouldBypassTraceContinuation('/api/metrics')).toBe(true)
  })

  it('does not bypass /api/version or other paths', () => {
    expect(shouldBypassTraceContinuation('/api/version')).toBe(false)
    expect(shouldBypassTraceContinuation('/api/bootstrap')).toBe(false)
    expect(shouldBypassTraceContinuation('/')).toBe(false)
  })
})

describe('continueRequestTrace', () => {
  it('propagates the incoming trace_id onto the active scope', () => {
    const incomingTraceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const sentryTrace = `${incomingTraceId}-0011223344556677-1`

    let observedTraceId: string | undefined
    continueRequestTrace(
      {
        'sentry-trace': sentryTrace,
        baggage: `sentry-trace_id=${incomingTraceId},sentry-environment=test`,
      },
      () => {
        observedTraceId = Sentry.getCurrentScope().getPropagationContext().traceId
      },
    )

    expect(observedTraceId).toBe(incomingTraceId)
  })

  it('generates a fresh propagation context when no header is supplied', () => {
    let observedTraceId: string | undefined
    continueRequestTrace({}, () => {
      observedTraceId = Sentry.getCurrentScope().getPropagationContext().traceId
    })

    // Fresh trace ids are 32 lowercase hex chars; we don't pin the value,
    // just the shape, so we don't conflate "fresh trace_id generated"
    // with "trace_id leaked from a previous test".
    expect(observedTraceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the callback result', () => {
    const result = continueRequestTrace({}, () => 'handler-return-value')
    expect(result).toBe('handler-return-value')
  })
})

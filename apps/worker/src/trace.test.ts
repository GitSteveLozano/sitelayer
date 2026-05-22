import { describe, expect, it } from 'vitest'
import * as Sentry from '@sentry/node'
import { spanForAppliedRow, withRowTrace } from './trace.js'

describe('worker trace spans', () => {
  it('does not throw when trace fields are null', () => {
    expect(() =>
      spanForAppliedRow({
        id: '00000000-0000-0000-0000-000000000001',
        kind: 'outbox',
        entity_type: 'project',
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// withRowTrace pins the trace-continuation contract for the worker side of
// the API→DB→worker handoff. The companion API-ingress test lives at
// apps/api/src/trace-ingress.test.ts. Together they assert:
//
//   API request carries sentry-trace=ABC...
//     -> continueRequestTrace continues into ABC
//     -> mutation_outbox row persists sentry_trace=ABC
//     -> worker pusher claims row, calls push(...) with sentry_trace=ABC
//     -> withRowTrace continues into ABC again
//     -> external QBO call shares ABC, not a fresh worker trace
//
// We intentionally do NOT import `./instrument.js` here — that side-effects
// Sentry.init() and would switch the SDK to OpenTelemetry async-context
// mode, which routes continueTrace through OTel context rather than the
// scope. Importing `@sentry/node` alone keeps us in the stack strategy
// where `getCurrentScope().getPropagationContext()` is the readable
// assertion surface. See trace-ingress.test.ts for the same reasoning.
// ---------------------------------------------------------------------------

describe('withRowTrace', () => {
  it('propagates the originating sentry-trace into the active scope', () => {
    const incoming = 'feedfacefeedfacefeedfacefeedface'
    let observed: string | undefined
    withRowTrace(
      {
        sentry_trace: `${incoming}-0011223344556677-1`,
        sentry_baggage: `sentry-trace_id=${incoming},sentry-environment=test`,
      },
      () => {
        observed = Sentry.getCurrentScope().getPropagationContext().traceId
      },
    )
    expect(observed).toBe(incoming)
  })

  it('runs the callback unchanged when the row has no sentry_trace', () => {
    const sentinel = { ok: true }
    const result = withRowTrace({ sentry_trace: null, sentry_baggage: null }, () => sentinel)
    expect(result).toBe(sentinel)
  })

  it('tolerates null baggage when sentry_trace is present', () => {
    const incoming = 'cafebabecafebabecafebabecafebabe'
    let observed: string | undefined
    withRowTrace(
      {
        sentry_trace: `${incoming}-aabbccddeeff0011-1`,
        sentry_baggage: null,
      },
      () => {
        observed = Sentry.getCurrentScope().getPropagationContext().traceId
      },
    )
    expect(observed).toBe(incoming)
  })

  it('returns the callback result', () => {
    const result = withRowTrace({ sentry_trace: null }, () => 'worker-handler-return')
    expect(result).toBe('worker-handler-return')
  })
})

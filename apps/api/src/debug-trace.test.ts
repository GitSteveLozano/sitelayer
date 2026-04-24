import { describe, expect, it } from 'vitest'
import {
  authorizeDebugTraceRequest,
  DebugTraceError,
  parseTraceIdFromSentryTraceHeader,
  readSentryTraceConfig,
} from './debug-trace.js'

describe('debug trace authorization', () => {
  it('hides the endpoint when DEBUG_TRACE_TOKEN is missing', () => {
    expect(
      authorizeDebugTraceRequest({
        debugToken: undefined,
        tier: 'local',
        authorizationHeader: undefined,
        requestId: 'req_1',
      }),
    ).toMatchObject({ ok: false, status: 404, body: { error: 'not found' } })
  })

  it('rejects missing and wrong bearer tokens', () => {
    const missing = authorizeDebugTraceRequest({
      debugToken: 'debug-token',
      tier: 'local',
      authorizationHeader: undefined,
      requestId: 'req_1',
    })
    const wrong = authorizeDebugTraceRequest({
      debugToken: 'debug-token',
      tier: 'local',
      authorizationHeader: 'Bearer wrong-token',
      requestId: 'req_1',
    })

    expect(missing).toMatchObject({ ok: false, status: 401, authenticate: true })
    expect(wrong).toMatchObject({ ok: false, status: 401, authenticate: true })
  })

  it('accepts the configured bearer token outside prod', () => {
    expect(
      authorizeDebugTraceRequest({
        debugToken: 'debug-token',
        tier: 'preview',
        authorizationHeader: 'Bearer debug-token',
        requestId: 'req_1',
      }),
    ).toEqual({ ok: true, presentedToken: 'debug-token' })
  })

  it('keeps prod disabled unless explicitly allowed', () => {
    expect(
      authorizeDebugTraceRequest({
        debugToken: 'debug-token',
        tier: 'prod',
        authorizationHeader: 'Bearer debug-token',
        requestId: 'req_1',
      }),
    ).toMatchObject({ ok: false, status: 403 })

    expect(
      authorizeDebugTraceRequest({
        debugToken: 'debug-token',
        tier: 'prod',
        allowProd: '1',
        authorizationHeader: 'Bearer debug-token',
        requestId: 'req_1',
      }),
    ).toEqual({ ok: true, presentedToken: 'debug-token' })
  })
})

describe('debug trace Sentry config', () => {
  it('requires org and auth token before calling Sentry', () => {
    expect(() => readSentryTraceConfig({ SENTRY_ORG: 'sandolabs' })).toThrow(DebugTraceError)
    expect(() => readSentryTraceConfig({ SENTRY_AUTH_TOKEN: 'token' })).toThrow(DebugTraceError)
    expect(readSentryTraceConfig({ SENTRY_ORG: 'sandolabs', SENTRY_AUTH_TOKEN: 'token' })).toMatchObject({
      org: 'sandolabs',
      token: 'token',
      host: 'sentry.io',
    })
  })

  it('parses trace ids from sentry-trace headers', () => {
    expect(parseTraceIdFromSentryTraceHeader('0123456789abcdef0123456789abcdef-0123456789abcdef-1')).toBe(
      '0123456789abcdef0123456789abcdef',
    )
    expect(parseTraceIdFromSentryTraceHeader('not-a-trace')).toBeNull()
    expect(parseTraceIdFromSentryTraceHeader(null)).toBeNull()
  })
})

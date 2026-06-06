import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sentry facade is read at report time for the sentry-trace header.
const sentryMock = vi.hoisted(() => ({
  getTraceData: vi.fn<() => Record<string, string>>(() => ({})),
}))
vi.mock('@/instrument', () => ({ Sentry: sentryMock }))

// Stub the capture-session API so no real network fires.
const createCaptureSession = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, any>) => ({ capture_session: { id: 's' } })),
)
const finalizeCaptureSession = vi.hoisted(() =>
  vi.fn(async (_id: string, _input: Record<string, any>) => ({
    work_item: { id: 'w1' },
    support_packet: { id: 'p1' },
    event: null,
  })),
)
vi.mock('@/lib/api/capture-sessions', () => ({ createCaptureSession, finalizeCaptureSession }))

// Stub the client helpers (avoid pulling the whole client + its trace-capture
// import back in a cycle during the test).
vi.mock('@/lib/api/client', () => ({
  getBuildSha: () => 'sha-test',
  nextRequestId: () => 'web-req-1',
}))

import { __resetTraceCaptureForTests, reportServer5xx, reportTraceCapture } from './trace-capture'
import { __resetLiveWorkflowAnchorForTests, recordLiveWorkflowAnchor } from './live-workflow-anchor'

describe('trace-capture (STEP4)', () => {
  beforeEach(() => {
    __resetTraceCaptureForTests()
    __resetLiveWorkflowAnchorForTests()
    createCaptureSession.mockClear()
    finalizeCaptureSession.mockClear()
    sentryMock.getTraceData.mockReturnValue({})
    window.history.replaceState({}, '', '/projects/abc')
  })
  afterEach(() => {
    __resetTraceCaptureForTests()
    __resetLiveWorkflowAnchorForTests()
  })

  it('opens a trace-mode session with NO media and finalizes a triage work_item', async () => {
    const workItemId = await reportTraceCapture({ origin: 'error_boundary', message: 'boom' })
    expect(workItemId).toBe('w1')

    const sessionInput = createCaptureSession.mock.calls[0]![0]
    expect(sessionInput.mode).toBe('trace')
    // PII-safe: no media streams and no artifacts in the consent scope.
    expect(sessionInput.consent_scope.streams).toEqual([])
    expect(sessionInput.consent_scope.artifacts).toEqual({})
    expect(sessionInput.metadata.capture_profile).toBe('trace')
    expect(sessionInput.metadata.origin).toBe('error_boundary')

    const finalizeInput = finalizeCaptureSession.mock.calls[0]![1]
    expect(finalizeInput.lane).toBe('triage')
    expect(finalizeInput.category).toBe('trace_auto_capture')
  })

  it('stamps the live workflow anchor + sentry trace into the metadata', async () => {
    recordLiveWorkflowAnchor({ eventRef: 'workflow_event:rental:abc:3', workflowName: 'rental', entityId: 'r1' })
    sentryMock.getTraceData.mockReturnValue({ 'sentry-trace': 'trace-abc-1' })

    await reportTraceCapture({ origin: 'error_boundary', message: 'boom' })
    const sessionInput = createCaptureSession.mock.calls[0]![0]
    expect(sessionInput.metadata.workflow_event_ref).toBe('workflow_event:rental:abc:3')
    expect(sessionInput.metadata.workflow_name).toBe('rental')
    expect(sessionInput.metadata.sentry_trace).toBe('trace-abc-1')
  })

  it('debounces an identical error storm to a single filing', async () => {
    await reportTraceCapture({ origin: 'unhandledrejection', errorName: 'TypeError', message: 'x is undefined' })
    await reportTraceCapture({ origin: 'unhandledrejection', errorName: 'TypeError', message: 'x is undefined' })
    await reportTraceCapture({ origin: 'unhandledrejection', errorName: 'TypeError', message: 'x is undefined' })
    expect(createCaptureSession).toHaveBeenCalledTimes(1)
  })

  it('caps the number of distinct filings per page', async () => {
    for (let i = 0; i < 8; i += 1) {
      // Distinct messages so the debounce/dedupe never collapses them.
      await reportTraceCapture({ origin: 'window_error', message: `distinct-error-${i}` })
    }
    // MAX_SESSIONS_PER_PAGE = 5
    expect(createCaptureSession).toHaveBeenCalledTimes(5)
  })

  it('rolls back the page budget when the session never opens', async () => {
    createCaptureSession.mockRejectedValueOnce(new Error('offline'))
    const first = await reportTraceCapture({ origin: 'window_error', message: 'one' })
    expect(first).toBeNull()
    // A different error still files (the failed attempt didn't burn the budget).
    const second = await reportTraceCapture({ origin: 'window_error', message: 'two' })
    expect(second).toBe('w1')
  })

  it('reportServer5xx ignores <500 and skips the capture endpoints (no recursion)', async () => {
    reportServer5xx({ status: 404, path: '/api/projects', method: 'GET', requestId: 'r' })
    reportServer5xx({ status: 500, path: '/api/capture-sessions/x/finalize', method: 'POST', requestId: 'r' })
    // Let any microtasks settle.
    await Promise.resolve()
    expect(createCaptureSession).not.toHaveBeenCalled()

    reportServer5xx({ status: 502, path: '/api/projects/1/summary', method: 'GET', requestId: 'r9' })
    await Promise.resolve()
    await Promise.resolve()
    expect(createCaptureSession).toHaveBeenCalledTimes(1)
    const sessionInput = createCaptureSession.mock.calls[0]![0]
    expect(sessionInput.metadata.http_status).toBe(502)
    expect(sessionInput.metadata.api_path).toBe('/api/projects/1/summary')
  })
})

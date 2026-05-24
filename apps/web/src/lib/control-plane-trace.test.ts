import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compactTraceEventType,
  compactWorkflowSnapshot,
  emitControlPlaneTrace,
  readControlPlaneTraceCapabilitiesWhenActive,
} from './control-plane-trace.js'

type TestTraceBridge = {
  active?: () => { trace_id?: string } | null
  emit?: (event: Record<string, unknown>) => unknown
  capabilities?: () => Record<string, unknown>
}

function setTraceBridge(bridge: TestTraceBridge): void {
  const globalWindow = window as Window & { __controlPlaneTrace?: TestTraceBridge }
  globalWindow.__controlPlaneTrace = bridge
}

function clearTraceBridge(): void {
  delete (window as Window & { __controlPlaneTrace?: TestTraceBridge }).__controlPlaneTrace
}

describe('control-plane trace helpers', () => {
  afterEach(() => {
    clearTraceBridge()
  })

  it('does not emit when there is no active trace', () => {
    const emit = vi.fn()
    setTraceBridge({ active: () => null, emit })

    expect(emitControlPlaneTrace('sitelayer.probe.state', { key: 'projectState' })).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits compact summary-only events when active', () => {
    const emit = vi.fn()
    setTraceBridge({ active: () => ({ trace_id: 'trace-1' }), emit })

    expect(
      emitControlPlaneTrace('sitelayer.workflow.event', {
        workflow_id: 'projectLifecycle',
        event_type: 'ACCEPT',
        state_version: 3,
        title: 'raw customer text',
        url: 'https://example.test/path?token=secret',
      }),
    ).toBe(true)

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'trace-1',
        event_type: 'sitelayer.workflow.event',
        severity: 'debug',
        redaction: { status: 'summary_only', reason: 'sitelayer_client_trace_tap' },
        payload: {
          route_path: '/',
          workflow_id: 'projectLifecycle',
          event_type: 'ACCEPT',
          state_version: 3,
        },
      }),
    )
  })

  it('reads capabilities only while a trace is active', () => {
    const capabilities = vi.fn(() => ({ streams: ['app_events'] }))
    setTraceBridge({ active: () => null, capabilities })
    expect(readControlPlaneTraceCapabilitiesWhenActive()).toBeNull()
    expect(capabilities).not.toHaveBeenCalled()

    setTraceBridge({ active: () => ({ trace_id: 'trace-1' }), capabilities })
    expect(readControlPlaneTraceCapabilitiesWhenActive()).toEqual({ streams: ['app_events'] })
  })

  it('keeps workflow/event summaries bounded', () => {
    expect(compactTraceEventType({ type: 'DECLINE', reason: 'operator-entered reason' })).toBe('DECLINE')
    expect(
      compactWorkflowSnapshot({
        state: 'accepted',
        state_version: 5,
        next_events: [{ type: 'START' }, { type: 'ARCHIVE' }],
        context: { customer_name: 'Raw name' },
      }),
    ).toEqual({
      state: 'accepted',
      state_version: 5,
      next_events: ['START', 'ARCHIVE'],
    })
  })
})

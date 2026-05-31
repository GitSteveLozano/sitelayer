import { describe, expect, it } from 'vitest'
import { __meshTraceForwardTestHooks } from './mesh-trace-forward.js'

describe('mesh trace forwarder', () => {
  it('emits stable event refs and preserves capture session joins', () => {
    const row = {
      workflow_name: 'estimate_share',
      entity_id: '00000000-0000-4000-8000-000000000123',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      state_version: 7,
      event_type: 'POST_SUCCEEDED',
      state_after: 'posted',
      applied_at: '2026-05-31T18:00:00.000Z',
    }

    const event = __meshTraceForwardTestHooks.toTraceEvent(row)
    const resent = __meshTraceForwardTestHooks.toTraceEvent({
      ...row,
      applied_at: '2026-05-31T18:05:00.000Z',
    })

    expect(event.event_ref).toMatch(/^workflow_event:estimate_share:[a-f0-9]{16}:7$/)
    expect(resent.event_ref).toBe(event.event_ref)
    expect(event.session_id).toBe(row.capture_session_id)
    expect(event.capture_session_id).toBe(row.capture_session_id)
    expect(event.route_path).toBe('/wf/estimate_share')
    expect(event.payload).toEqual({ workflow_id: 'estimate_share', event_name: 'POST_SUCCEEDED' })
  })

  it('falls back to entity session id when no capture session is present', () => {
    const event = __meshTraceForwardTestHooks.toTraceEvent({
      workflow_name: 'rental_billing',
      entity_id: 'entity-1',
      capture_session_id: null,
      state_version: 3,
      event_type: 'SYNC_FAILED',
      state_after: 'failed',
      applied_at: '2026-05-31T18:00:00.000Z',
    })

    expect(event.session_id).toBe('entity-1')
    expect(event.capture_session_id).toBeUndefined()
    expect(event.outcome).toBe('failed')
    expect(event.error_code).toBe('SYNC_FAILED')
  })
})

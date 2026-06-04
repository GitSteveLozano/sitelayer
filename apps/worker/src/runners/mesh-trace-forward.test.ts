import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __meshTraceForwardTestHooks } from './mesh-trace-forward.js'

describe('mesh trace forwarder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it('forwards capture-session events as low-PII product trace', () => {
    const event = __meshTraceForwardTestHooks.toCaptureTraceEvent({
      id: '22222222-2222-4222-8222-222222222222',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      seq: 12,
      event_type: 'ui.dead_button',
      event_class: 'interaction',
      route_path: '/desktop/takeoff?sheet=A101',
      workflow_id: 'takeoff_scale_verify',
      entity_type: 'project',
      entity_id: 'project-1',
      occurred_at: '2026-05-31T18:00:00.000Z',
    })

    expect(event).toMatchObject({
      event_ref: 'capture_session_event:22222222-2222-4222-8222-222222222222',
      session_id: '11111111-1111-4111-8111-111111111111',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      seq: 12,
      event_class: 'interaction',
      route_path: '/desktop/takeoff',
      outcome: 'succeeded',
      payload: {
        event_name: 'ui.dead_button',
        workflow_id: 'takeoff_scale_verify',
        entity_type: 'project',
        entity_id: 'project-1',
      },
    })
    expect(JSON.stringify(event)).not.toContain('sheet=A101')
  })

  it('marks failing capture-session events as failed without forwarding raw payload bodies', () => {
    const event = __meshTraceForwardTestHooks.toCaptureTraceEvent({
      id: '22222222-2222-4222-8222-222222222222',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      seq: 13,
      event_type: 'api.error',
      event_class: '',
      route_path: null,
      workflow_id: null,
      entity_type: null,
      entity_id: null,
      occurred_at: '2026-05-31T18:00:00.000Z',
    })

    expect(event.outcome).toBe('failed')
    expect(event.error_code).toBe('api.error')
    expect(event.event_class).toBe('capture_session_event')
    expect(event.route_path).toBe('/capture/session')
  })

  it('builds durable forward-state records without adding raw capture payloads', () => {
    const event = __meshTraceForwardTestHooks.toCaptureTraceEvent({
      id: '22222222-2222-4222-8222-222222222222',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      seq: 13,
      event_type: 'trace.smoke',
      event_class: 'smoke',
      route_path: '/desktop/takeoff?sheet=A101',
      workflow_id: 'capture_trace_smoke',
      entity_type: 'capture_session',
      entity_id: '11111111-1111-4111-8111-111111111111',
      occurred_at: '2026-05-31T18:00:00.000Z',
    })

    const records = __meshTraceForwardTestHooks.toForwardStateRecords(
      [
        {
          company_id: '33333333-3333-4333-8333-333333333333',
          event_ref: event.event_ref,
          source_kind: 'capture_session_event',
          source_id: '22222222-2222-4222-8222-222222222222',
          capture_session_id: '11111111-1111-4111-8111-111111111111',
          event,
        },
      ],
      {
        projectKey: 'sitelayer',
        status: 'forwarded',
        httpStatus: 202,
        error: null,
      },
    )

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event_ref: 'capture_session_event:22222222-2222-4222-8222-222222222222',
      source_kind: 'capture_session_event',
      source_id: '22222222-2222-4222-8222-222222222222',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      status: 'forwarded',
      last_status: 202,
    })
    expect(JSON.stringify(records[0])).not.toContain('sheet=A101')
  })

  it('skips candidates already recorded as forwarded', () => {
    const events = [
      {
        company_id: '33333333-3333-4333-8333-333333333333',
        event_ref: 'event:a',
        source_kind: 'workflow_event_log' as const,
        source_id: '44444444-4444-4444-8444-444444444444',
        capture_session_id: null,
        event: {
          event_ref: 'event:a',
          session_id: 'entity-1',
          capture_session_id: undefined,
          seq: 1,
          event_class: 'workflow_event',
          route_path: '/wf/x',
          state_after: 'done',
          outcome: 'succeeded',
          error_code: '',
          occurred_at: '2026-05-31T18:00:00.000Z',
          payload: { workflow_id: 'x', event_name: 'DONE' },
        },
      },
      {
        company_id: '33333333-3333-4333-8333-333333333333',
        event_ref: 'event:b',
        source_kind: 'workflow_event_log' as const,
        source_id: '55555555-5555-4555-8555-555555555555',
        capture_session_id: null,
        event: {
          event_ref: 'event:b',
          session_id: 'entity-2',
          capture_session_id: undefined,
          seq: 2,
          event_class: 'workflow_event',
          route_path: '/wf/y',
          state_after: 'done',
          outcome: 'succeeded',
          error_code: '',
          occurred_at: '2026-05-31T18:00:00.000Z',
          payload: { workflow_id: 'y', event_name: 'DONE' },
        },
      },
    ]

    expect(__meshTraceForwardTestHooks.filterUnforwardedEvents(events, new Set(['event:a']))).toEqual([events[1]])
  })

  it('records forwarded state after an accepted ingest response', async () => {
    const insertedStatePayloads: unknown[] = []
    const query = vi.fn(async (sqlLike: unknown, params?: unknown[]) => {
      const sql = String(sqlLike)
      if (/from workflow_event_log/i.test(sql)) {
        return {
          rows: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              company_id: '33333333-3333-4333-8333-333333333333',
              workflow_name: 'estimate_share',
              entity_id: '00000000-0000-4000-8000-000000000123',
              capture_session_id: '11111111-1111-4111-8111-111111111111',
              state_version: 7,
              event_type: 'POST_SUCCEEDED',
              state_after: 'posted',
              applied_at: '2026-05-31T18:00:00.000Z',
            },
          ],
        }
      }
      if (/from capture_session_events/i.test(sql)) return { rows: [] }
      if (/from mesh_trace_forward_state/i.test(sql)) return { rows: [] }
      if (/insert into mesh_trace_forward_state/i.test(sql)) {
        insertedStatePayloads.push(JSON.parse(String(params?.[0])))
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202 })),
    )

    const summary = await __meshTraceForwardTestHooks.forwardOnce(
      { query } as unknown as Pool,
      {
        url: 'http://mesh.test/api/product-trace/ingest',
        path: '/api/product-trace/ingest',
        component: 'sitelayer-test',
        secretHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        projectKey: 'sitelayer',
        intervalMs: 60000,
        windowMinutes: 60,
        requestTimeoutMs: 3000,
      },
      () => {},
    )

    expect(summary.forwarded_events).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(insertedStatePayloads).toHaveLength(1)
    const records = insertedStatePayloads[0] as Array<Record<string, unknown>>
    expect(records[0]).toMatchObject({
      company_id: '33333333-3333-4333-8333-333333333333',
      source_kind: 'workflow_event_log',
      source_id: '44444444-4444-4444-8444-444444444444',
      capture_session_id: '11111111-1111-4111-8111-111111111111',
      status: 'forwarded',
      last_status: 202,
    })
  })
})

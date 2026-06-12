import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import { buildOpsDiagnostics, handleOpsDiagnosticsRoutes } from './ops-diagnostics.js'

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

describe('ops diagnostics', () => {
  it('summarizes local control-plane primitives without returning raw details', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/api/diagnostics')) {
        return json({
          status: 'ok',
          summary: { total: 7, ok: 7 },
          components: {
            mesh: { status: 'ok' },
            browser_bridge: { status: 'ok' },
            voice: { status: 'ok' },
            capture_router: { status: 'ok' },
          },
        })
      }
      if (url.endsWith('/api/screen/status')) {
        return json({
          recording: true,
          local_storage_only: true,
          stream_dir: '/mnt/backup/screen-stream-hot',
          monitors: [
            { name: 'HDMI-0', retention_minutes: 720, geometry: '3840x2160+0+0' },
            { name: 'DP-0', retention_minutes: 720, geometry: '5120x1440+3840+0' },
          ],
        })
      }
      if (url.endsWith('/health')) {
        return json({
          ok: true,
          sinks: ['inbox'],
          sideEffectLedger: '/home/taylorsando/projects/capture-router/side-effects-ledger.jsonl',
          durableSideEffectClaims: 2,
        })
      }
      return json({ error: 'not found' }, { status: 404 })
    }

    const response = await buildOpsDiagnostics({
      fetchImpl,
      gatewayDiagnosticsUrl: 'http://gateway.local/api/diagnostics',
      screenCaptureUrl: 'http://screen.local',
      captureRouterUrl: 'http://router.local',
      timeoutMs: 500,
    })

    expect(response.status).toBe('ok')
    expect(response.summary).toMatchObject({ total: 3, ok: 3 })
    expect(response.onsite_session).toMatchObject({
      status: 'ready',
      control_level: 'route',
      recommended_entry: 'dispatch_agent_review',
      can_capture_desktop: true,
      can_route_work: true,
      can_dispatch_agent_review: true,
      blockers: [],
    })
    expect(response.onsite_session.actions.filter((action) => action.enabled).map((action) => action.key)).toEqual([
      'capture_field_context',
      'capture_desktop_context',
      'route_support_packet',
      'dispatch_agent_review',
    ])
    expect(response.components.find((c) => c.key === 'screen_capture')?.facts).toMatchObject({
      monitor_count: 2,
      recording: true,
      retention_minutes: 720,
    })
    expect(JSON.stringify(response)).not.toContain('/mnt/backup')
    expect(JSON.stringify(response)).not.toContain('geometry')
    expect(JSON.stringify(response)).not.toContain('side-effects-ledger')
  })

  it('marks onsite sessions blocked when capture and routing are not usable', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/api/diagnostics')) {
        return json({
          status: 'ok',
          summary: { total: 4, ok: 4 },
          components: {
            mesh: { status: 'ok' },
            browser_bridge: { status: 'ok' },
            voice: { status: 'ok' },
            capture_router: { status: 'ok' },
          },
        })
      }
      if (url.endsWith('/api/screen/status')) {
        return json({ recording: false, monitors: [] })
      }
      if (url.endsWith('/health')) {
        return json({ ok: false, sinks: [] })
      }
      return json({ error: 'not found' }, { status: 404 })
    }

    const response = await buildOpsDiagnostics({
      fetchImpl,
      gatewayDiagnosticsUrl: 'http://gateway.local/api/diagnostics',
      screenCaptureUrl: 'http://screen.local',
      captureRouterUrl: 'http://router.local',
      timeoutMs: 500,
    })

    expect(response.status).toBe('degraded')
    expect(response.onsite_session).toMatchObject({
      status: 'blocked',
      control_level: 'observe',
      recommended_entry: 'capture_field_context',
      can_capture_desktop: false,
      can_route_work: false,
      can_dispatch_agent_review: false,
    })
    expect(response.onsite_session.actions).toContainEqual(
      expect.objectContaining({ key: 'capture_field_context', enabled: true }),
    )
    expect(response.onsite_session.actions).toContainEqual(
      expect.objectContaining({ key: 'capture_desktop_context', enabled: false }),
    )
    expect(response.onsite_session.blockers.length).toBeGreaterThanOrEqual(2)
  })

  it('uses app_issue.view as the route gate', async () => {
    const responses: Array<{ status: number; body: unknown }> = []
    const handled = await handleOpsDiagnosticsRoutes(
      { method: 'GET' } as http.IncomingMessage,
      new URL('http://localhost/api/ops/diagnostics'),
      {
        requireCapability: async () => {
          responses.push({ status: 403, body: { error: 'forbidden' } })
          return false
        },
        sendJson: (status, body) => responses.push({ status, body }),
      },
    )

    expect(handled).toBe(true)
    expect(responses).toEqual([{ status: 403, body: { error: 'forbidden' } }])
  })
})

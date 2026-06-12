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
    expect(response.components.find((c) => c.key === 'screen_capture')?.facts).toMatchObject({
      monitor_count: 2,
      recording: true,
      retention_minutes: 720,
    })
    expect(JSON.stringify(response)).not.toContain('/mnt/backup')
    expect(JSON.stringify(response)).not.toContain('geometry')
    expect(JSON.stringify(response)).not.toContain('side-effects-ledger')
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

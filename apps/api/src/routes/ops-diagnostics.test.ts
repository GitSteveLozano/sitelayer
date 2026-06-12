import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import {
  __resetOpsDiagnosticSessionsForTests,
  buildOpsDiagnostics,
  handleOpsDiagnosticsRoutes,
} from './ops-diagnostics.js'

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

const OPS_AGENT_AUDIENCE_ENV = 'SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE'
const AGENT_FEED_TOKENS_ENV = 'AGENT_FEED_TOKENS'
const READY_AGENT_FEED_OPTIONS = {
  diagnosticAgentAudience: 'onsite-diagnostics',
  agentFeedTokensEnv: JSON.stringify({ 'onsite-diagnostics': 'ready-test-token' }),
}

async function withReadyOpsAgentFeed<T>(fn: () => Promise<T>): Promise<T> {
  const previousAudience = process.env[OPS_AGENT_AUDIENCE_ENV]
  const previousTokens = process.env[AGENT_FEED_TOKENS_ENV]
  process.env[OPS_AGENT_AUDIENCE_ENV] = READY_AGENT_FEED_OPTIONS.diagnosticAgentAudience
  process.env[AGENT_FEED_TOKENS_ENV] = READY_AGENT_FEED_OPTIONS.agentFeedTokensEnv
  try {
    return await fn()
  } finally {
    restoreEnv(OPS_AGENT_AUDIENCE_ENV, previousAudience)
    restoreEnv(AGENT_FEED_TOKENS_ENV, previousTokens)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function greenFetch(): typeof fetch {
  return async (input) => {
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
        monitors: [{ name: 'HDMI-0', retention_minutes: 720 }],
      })
    }
    if (url.endsWith('/health')) {
      return json({ ok: true, sinks: ['inbox'], durableSideEffectClaims: 2 })
    }
    return json({ error: 'not found' }, { status: 404 })
  }
}

function blockedFetch(): typeof fetch {
  return async (input) => {
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
    if (url.endsWith('/api/screen/status')) return json({ recording: false, monitors: [] })
    if (url.endsWith('/health')) return json({ ok: false, sinks: [] })
    return json({ error: 'not found' }, { status: 404 })
  }
}

describe('ops diagnostics', () => {
  it('summarizes local control-plane primitives without returning raw details', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const response = await greenFetch()(input)
      if (String(input).endsWith('/api/screen/status')) {
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
      if (String(input).endsWith('/health')) {
        return json({
          ok: true,
          sinks: ['inbox'],
          sideEffectLedger: '/home/taylorsando/projects/capture-router/side-effects-ledger.jsonl',
          durableSideEffectClaims: 2,
        })
      }
      return response
    }

    const response = await buildOpsDiagnostics({
      fetchImpl,
      gatewayDiagnosticsUrl: 'http://gateway.local/api/diagnostics',
      screenCaptureUrl: 'http://screen.local',
      captureRouterUrl: 'http://router.local',
      timeoutMs: 500,
      ...READY_AGENT_FEED_OPTIONS,
    })

    expect(response.status).toBe('ok')
    expect(response.summary).toMatchObject({ total: 4, ok: 4 })
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
    expect(response.components.find((c) => c.key === 'agent_feed')).toMatchObject({
      status: 'ok',
      facts: {
        audience_configured: true,
        tokens_configured: true,
        audience_has_token: true,
        audience_count: 1,
      },
    })
    expect(JSON.stringify(response)).not.toContain('/mnt/backup')
    expect(JSON.stringify(response)).not.toContain('geometry')
    expect(JSON.stringify(response)).not.toContain('side-effects-ledger')
    expect(JSON.stringify(response)).not.toContain('ready-test-token')
  })

  it('marks onsite sessions blocked when capture and routing are not usable', async () => {
    const response = await buildOpsDiagnostics({
      fetchImpl: blockedFetch(),
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
    expect(response.components.find((c) => c.key === 'agent_feed')).toMatchObject({
      status: 'degraded',
      facts: { audience_configured: false, tokens_configured: false, audience_has_token: false },
    })
    expect(response.onsite_session.blockers.length).toBeGreaterThanOrEqual(2)
  })

  it('blocks routed actions when the onsite agent feed audience is not token-backed', async () => {
    const response = await buildOpsDiagnostics({
      fetchImpl: greenFetch(),
      gatewayDiagnosticsUrl: 'http://gateway.local/api/diagnostics',
      screenCaptureUrl: 'http://screen.local',
      captureRouterUrl: 'http://router.local',
      timeoutMs: 500,
      diagnosticAgentAudience: 'onsite-diagnostics',
      agentFeedTokensEnv: JSON.stringify({ other: 'not-the-onsite-token' }),
    })

    expect(response.status).toBe('degraded')
    expect(response.components.find((c) => c.key === 'agent_feed')).toMatchObject({
      status: 'degraded',
      facts: {
        audience_configured: true,
        tokens_configured: true,
        audience_has_token: false,
        audience_count: 1,
      },
    })
    expect(response.onsite_session).toMatchObject({
      status: 'limited',
      control_level: 'capture',
      can_capture_desktop: true,
      can_route_work: false,
      can_dispatch_agent_review: false,
    })
    expect(response.onsite_session.actions).toContainEqual(
      expect.objectContaining({
        key: 'route_support_packet',
        enabled: false,
        reason: 'Agent feed is not ready for routed work.',
      }),
    )
    expect(JSON.stringify(response)).not.toContain('not-the-onsite-token')
  })

  it('starts an expiring onsite diagnostic session without exposing the control token in later reads', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const responses: Array<{ status: number; body: unknown }> = []
      const capabilities: string[] = []
      const handled = await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        {
          requireCapability: async (capability) => {
            capabilities.push(capability)
            return true
          },
          sendJson: (status, body) => responses.push({ status, body }),
          readBody: async () => ({ label: 'Plant walkdown', intent: 'dispatch_agent_review' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        },
      )

      expect(handled).toBe(true)
      expect(capabilities).toEqual(['app_issue.capture'])
      expect(responses[0]?.status).toBe(201)
      const created = responses[0]?.body as {
        control_token?: string
        session?: {
          id?: string
          operator_user_id?: string | null
          label?: string | null
          plan?: { control_level?: string; recommended_entry?: string }
          audit_events?: Array<{ type: string; effect: string }>
        }
      }
      expect(created.control_token).toEqual(expect.any(String))
      expect(created.session).toMatchObject({
        operator_user_id: 'user_42',
        label: 'Plant walkdown',
        plan: { control_level: 'route', recommended_entry: 'dispatch_agent_review' },
      })
      expect(created.session?.audit_events).toEqual([
        expect.objectContaining({ type: 'session.started', effect: 'audit_only' }),
      ])
      expect(JSON.stringify(created.session)).not.toContain(String(created.control_token))

      const reads: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'GET' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session?.id}`),
        {
          requireCapability: async (capability) => {
            expect(capability).toBe('app_issue.view')
            return true
          },
          sendJson: (status, body) => reads.push({ status, body }),
        },
      )
      expect(reads[0]?.status).toBe(200)
      expect(JSON.stringify(reads[0]?.body)).not.toContain(String(created.control_token))
    })
  })

  it('records token-gated onsite diagnostic action requests as audit-only events', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({}),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        },
      )
      const created = createdResponses[0]?.body as { control_token: string; session: { id: string } }

      const actionResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async (capability) => {
            expect(capability).toBe('app_issue.capture')
            return true
          },
          sendJson: (status, body) => actionResponses.push({ status, body }),
          readBody: async () => ({
            control_token: created.control_token,
            action_key: 'dispatch_agent_review',
          }),
          getCurrentUserId: () => 'user_99',
        },
      )

      expect(actionResponses[0]?.status).toBe(202)
      expect(actionResponses[0]?.body).toMatchObject({
        schema: 'sitelayer.ops_diagnostic_session_action.v1',
        accepted_action: { key: 'dispatch_agent_review', effect: 'audit_only' },
        session: {
          audit_events: [
            expect.objectContaining({ type: 'session.started' }),
            expect.objectContaining({
              type: 'action.requested',
              action_key: 'dispatch_agent_review',
              actor_user_id: 'user_99',
              effect: 'audit_only',
            }),
          ],
        },
      })

      const deniedResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => deniedResponses.push({ status, body }),
          readBody: async () => ({
            control_token: 'wrong',
            action_key: 'dispatch_agent_review',
          }),
        },
      )
      expect(deniedResponses).toEqual([{ status: 403, body: { error: 'invalid control token' } }])
    })
  })

  it('rejects onsite diagnostic actions that were unavailable when the session started', async () => {
    __resetOpsDiagnosticSessionsForTests()
    const createdResponses: Array<{ status: number; body: unknown }> = []
    await handleOpsDiagnosticsRoutes(
      { method: 'POST' } as http.IncomingMessage,
      new URL('http://localhost/api/ops/diagnostics/sessions'),
      {
        requireCapability: async () => true,
        sendJson: (status, body) => createdResponses.push({ status, body }),
        readBody: async () => ({}),
        fetchImpl: blockedFetch(),
      },
    )
    const created = createdResponses[0]?.body as { control_token: string; session: { id: string } }

    const responses: Array<{ status: number; body: unknown }> = []
    await handleOpsDiagnosticsRoutes(
      { method: 'POST' } as http.IncomingMessage,
      new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
      {
        requireCapability: async () => true,
        sendJson: (status, body) => responses.push({ status, body }),
        readBody: async () => ({
          control_token: created.control_token,
          action_key: 'dispatch_agent_review',
        }),
      },
    )

    expect(responses[0]).toMatchObject({
      status: 409,
      body: {
        error: 'action is not available',
        reason: 'Gateway, capture router, and agent feed are not all ready.',
      },
    })
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

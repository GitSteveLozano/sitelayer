import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Readable } from 'node:stream'
import type { PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'
import {
  __captureOnsiteDesktopEvidenceForTests,
  __agentFeedDeliveryFromRowForTests,
  __desktopEvidenceFromRowForTests,
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

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  writes: Array<{ key: string; contents: Buffer; contentType: string | undefined }> = []

  async put(key: string, contents: Buffer, contentType?: string): Promise<void> {
    this.writes.push({ key, contents, contentType })
  }

  async putStream(_key: string, _body: Readable, _options?: PutStreamOptions): Promise<void> {
    throw new Error('not implemented')
  }

  async get(_key: string): Promise<Buffer> {
    throw new Error('not implemented')
  }

  async copy(_sourceKey: string, _destKey: string): Promise<void> {
    throw new Error('not implemented')
  }

  async deleteObject(_storagePath: string): Promise<void> {
    throw new Error('not implemented')
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions): Promise<string | null> {
    return null
  }
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

function routedFetch(
  deliveries: unknown[],
  routeResponse: Response = json({ routed: true }, { status: 202 }),
): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    if (url.endsWith('/ingest')) {
      deliveries.push(JSON.parse(String(init?.body ?? '{}')))
      return routeResponse.clone()
    }
    return greenFetch()(input, init)
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

  it('records token-gated onsite diagnostic actions and routes a capture WorkRequest', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const routedEnvelopes: unknown[] = []
      const fetchImpl = routedFetch(routedEnvelopes)
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({}),
          getCurrentUserId: () => 'user_42',
          fetchImpl,
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
          fetchImpl,
        },
      )

      expect(actionResponses[0]?.status).toBe(202)
      expect(actionResponses[0]?.body).toMatchObject({
        schema: 'sitelayer.ops_diagnostic_session_action.v1',
        accepted_action: {
          key: 'dispatch_agent_review',
          effect: 'audit_only',
          capture_route: {
            status: 'accepted',
            request_ref: `opsdiag:${created.session.id}:dispatch_agent_review`,
            routed: true,
            http_status: 202,
          },
        },
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
      expect(routedEnvelopes).toHaveLength(1)
      expect(routedEnvelopes[0]).toMatchObject({
        contract_version: '1.4.0',
        project_key: 'sitelayer',
        delivery_id: expect.stringContaining(`opsdiag:${created.session.id}:dispatch_agent_review:`),
        events: [
          expect.objectContaining({
            event_type: 'sitelayer.ops_diagnostic.dispatch_agent_review.requested',
            domain: 'workflow_event',
            outcome: 'requested',
            payload: {
              work_request: expect.objectContaining({
                request_ref: `opsdiag:${created.session.id}:dispatch_agent_review`,
                intent: 'review',
                entity_kind: 'ops_diagnostic_session',
                entity_id: created.session.id,
                payload: expect.objectContaining({
                  requested_action: 'dispatch_agent_review',
                  requested_by: 'user_99',
                  ops_diagnostic_session_id: created.session.id,
                }),
              }),
            },
          }),
        ],
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

  it('keeps the phone action accepted when capture-router delivery fails', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const routedEnvelopes: unknown[] = []
      const fetchImpl = routedFetch(routedEnvelopes, json({ error: 'router unavailable' }, { status: 503 }))
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({ intent: 'capture_desktop_context' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl,
        },
      )
      const created = createdResponses[0]?.body as { control_token: string; session: { id: string } }

      const actionResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => actionResponses.push({ status, body }),
          readBody: async () => ({
            control_token: created.control_token,
            action_key: 'capture_desktop_context',
          }),
          getCurrentUserId: () => 'user_99',
          fetchImpl,
        },
      )

      expect(actionResponses[0]?.status).toBe(202)
      expect(actionResponses[0]?.body).toMatchObject({
        accepted_action: {
          key: 'capture_desktop_context',
          effect: 'audit_only',
          capture_route: {
            status: 'failed',
            http_status: 503,
            error: 'router unavailable',
          },
        },
      })
      expect(routedEnvelopes).toHaveLength(1)
    })
  })

  it('stores operator-triggered desktop evidence as a tenant-scoped capture artifact', async () => {
    const storage = new MemoryStorage()
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      expect(url).toContain('http://screen.local/api/screen/clip/file')
      expect(url).toContain('since=20')
      expect(url).toContain('format=mp4')
      return new Response(Buffer.from('fake mp4 bytes'), { headers: { 'content-type': 'video/mp4' } })
    }
    const runTx = async <T>(companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      expect(companyId).toBe('company-1')
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params })
          if (sql.includes('insert into capture_artifacts')) return { rows: [{ id: 'artifact-1' }], rowCount: 1 }
          return { rows: [], rowCount: 1 }
        },
      } as unknown as PoolClient
      return fn(client)
    }

    const result = await __captureOnsiteDesktopEvidenceForTests(
      {
        requireCapability: async () => true,
        sendJson: () => undefined,
        company: { id: 'company-1' } as ActiveCompany,
        storage,
        buildSha: 'build-test',
        fetchImpl,
      },
      { screenCaptureUrl: 'http://screen.local', fetchImpl, timeoutMs: 250 },
      {
        session: {
          id: '11111111-1111-4111-8111-111111111111',
          state: 'active',
          created_at: '2026-06-12T12:00:00.000Z',
          expires_at: '2026-06-12T13:00:00.000Z',
          operator_user_id: 'user_42',
          label: null,
          intent: 'capture_desktop_context',
          plan: {
            status: 'ready',
            control_level: 'capture',
            recommended_entry: 'capture_desktop_context',
            can_capture_desktop: true,
            can_route_work: false,
            can_dispatch_agent_review: false,
            blockers: [],
            actions: [],
          },
          audit_events: [],
        },
        event: {
          id: '22222222-2222-4222-8222-222222222222',
          at: '2026-06-12T12:05:00.000Z',
          actor_user_id: 'user_99',
          type: 'action.requested',
          action_key: 'capture_desktop_context',
          effect: 'audit_only',
          summary: 'Requested Attach desktop evidence.',
        },
        actionKey: 'capture_desktop_context',
        actorUserId: 'user_99',
      },
      runTx,
    )

    expect(result).toMatchObject({
      status: 'attached',
      artifact_id: 'artifact-1',
      file_path: expect.stringMatching(/^\/api\/capture-sessions\/.+\/artifacts\/artifact-1\/file$/),
      content_type: 'video/mp4',
      byte_size: Buffer.byteLength('fake mp4 bytes'),
      error: null,
    })
    expect(result?.storage_key).toMatch(/^company-1\/capture-sessions\/.+\/ops-diagnostic-desktop-/)
    expect(storage.writes).toHaveLength(1)
    expect(storage.writes[0]).toMatchObject({
      key: result?.storage_key,
      contentType: 'video/mp4',
    })
    expect(storage.writes[0]?.contents.toString()).toBe('fake mp4 bytes')

    const sessionInsert = queries.find((query) => query.sql.includes('insert into capture_sessions'))
    const artifactInsert = queries.find((query) => query.sql.includes('insert into capture_artifacts'))
    const consentScope = JSON.parse(String(sessionInsert?.params?.[8] ?? '{}')) as Record<string, unknown>
    expect(sessionInsert?.params).toContain('ops-diagnostic-desktop-v1')
    expect(consentScope).toMatchObject({ mode: 'desktop', route_path: '/ops', screen_video: true })
    expect(artifactInsert?.params).toContain(result?.storage_key)
    expect(JSON.stringify(artifactInsert?.params)).toContain('ops_diagnostic_desktop_capture')
    expect(JSON.stringify(queries)).not.toContain('/tmp/')
    expect(JSON.stringify(queries)).not.toContain('/mnt/')
  })

  it('maps persisted desktop evidence rows back to reopenable session state', () => {
    const evidence = __desktopEvidenceFromRowForTests({
      capture_session_id: '33333333-3333-4333-8333-333333333333',
      artifact_id: '44444444-4444-4444-8444-444444444444',
      storage_key: 'company-1/capture-sessions/33333333-3333-4333-8333-333333333333/clip.mp4',
      content_type: 'video/mp4',
      byte_size: '1572864',
    })

    expect(evidence).toMatchObject({
      status: 'attached',
      capture_session_id: '33333333-3333-4333-8333-333333333333',
      artifact_id: '44444444-4444-4444-8444-444444444444',
      file_path:
        '/api/capture-sessions/33333333-3333-4333-8333-333333333333/artifacts/44444444-4444-4444-8444-444444444444/file',
      content_type: 'video/mp4',
      byte_size: 1572864,
      error: null,
    })
    expect(__desktopEvidenceFromRowForTests(null)).toBeNull()
  })

  it('maps onsite agent-feed delivery rows into phone-safe session state', () => {
    const delivery = __agentFeedDeliveryFromRowForTests(
      {
        id: 'feed-1',
        audience: 'onsite-diagnostics',
        concern_ref: 'opsdiag:11111111-1111-4111-8111-111111111111:dispatch_agent_review',
        status: 'claimed',
        callback: null,
        claimed_at: '2026-06-12T12:00:00.000Z',
        completed_at: null,
        created_at: '2026-06-12T11:59:00.000Z',
      },
      Date.parse('2026-06-12T12:20:01.000Z'),
    )

    expect(delivery).toMatchObject({
      action_key: 'dispatch_agent_review',
      audience: 'onsite-diagnostics',
      concern_ref: 'opsdiag:11111111-1111-4111-8111-111111111111:dispatch_agent_review',
      status: 'claimed',
      queued_at: '2026-06-12T11:59:00.000Z',
      claimed_at: '2026-06-12T12:00:00.000Z',
      completed_at: null,
      callback_status: null,
      callback_error: null,
      stale: true,
    })

    const failed = __agentFeedDeliveryFromRowForTests(
      {
        id: 'feed-2',
        audience: 'onsite-diagnostics',
        concern_ref: 'opsdiag:11111111-1111-4111-8111-111111111111:route_support_packet',
        status: 'failed',
        callback: { status: 'failed', error: 'executor timed out' },
        claimed_at: '2026-06-12T12:00:00.000Z',
        completed_at: '2026-06-12T12:01:00.000Z',
        created_at: '2026-06-12T11:59:00.000Z',
      },
      Date.parse('2026-06-12T12:20:01.000Z'),
    )

    expect(failed).toMatchObject({
      action_key: 'route_support_packet',
      status: 'failed',
      callback_status: 'failed',
      callback_error: 'executor timed out',
      stale: false,
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

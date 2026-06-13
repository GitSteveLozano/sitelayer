import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Readable } from 'node:stream'
import type { PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'
import {
  __buildOpsOnsiteDiagnosticManifestForTests,
  __captureOnsiteDesktopEvidenceForTests,
  __captureRouteOutboxStatusForTests,
  __agentFeedDeliveryFromRowForTests,
  __anchorPersistentOnsiteWorkLinkForTests,
  __cancelOnsiteDiagnosticAgentFeedForTests,
  __desktopEvidenceFromRowForTests,
  __enqueueOnsiteDiagnosticConcernForTests,
  __latestPersistentOnsiteWorkLinkForTests,
  __persistOnsiteDiagnosticActionResultForTests,
  __recordPersistentOnsiteDiagnosticActionForTests,
  __resetOpsDiagnosticSessionsForTests,
  buildOpsDiagnostics,
  handleOpsDiagnosticsRoutes,
  type OpsDiagnosticsRouteCtx,
  type OpsOnsiteDiagnosticAuditEvent,
  type OpsOnsiteDiagnosticSessionActionResponse,
  type StoredOnsiteDiagnosticSession,
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

function liveAgentFeedLiveness(overrides: Record<string, unknown> = {}) {
  return {
    audience: 'onsite-diagnostics',
    last_poll_at: '2026-06-12T12:00:00.000Z',
    last_poll_age_seconds: 10,
    live: true,
    ...overrides,
  }
}

function readyOpsRouteCtx(ctx: OpsDiagnosticsRouteCtx): OpsDiagnosticsRouteCtx {
  return { agentFeedLiveness: liveAgentFeedLiveness(), ...ctx }
}

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  writes: Array<{ key: string; contents: Buffer; contentType: string | undefined }> = []
  deletes: string[] = []

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

  async deleteObject(storagePath: string): Promise<void> {
    this.deletes.push(storagePath)
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions): Promise<string | null> {
    return null
  }
}

const OPS_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const OPS_EVENT_ID = '22222222-2222-4222-8222-222222222222'
const OPS_CAPTURE_SESSION_ID = '33333333-3333-4333-8333-333333333333'
const OPS_SUPPORT_PACKET_ID = '44444444-4444-4444-8444-444444444444'
const OPS_WORK_ITEM_ID = '55555555-5555-4555-8555-555555555555'
const OPS_FEED_ID = '66666666-6666-4666-8666-666666666666'
const OPS_WORKER_ISSUE_ID = '88888888-8888-4888-8888-888888888888'
const OPS_CAPTURE_ROUTE_OUTBOX_ID = '99999999-9999-4999-8999-999999999999'

function readyPlan() {
  return {
    status: 'ready' as const,
    control_level: 'route' as const,
    recommended_entry: 'dispatch_agent_review' as const,
    can_capture_desktop: true,
    can_route_work: true,
    can_dispatch_agent_review: true,
    blockers: [],
    actions: [
      { key: 'capture_field_context' as const, label: 'Capture field context', enabled: true, reason: 'Ready.' },
      { key: 'capture_desktop_context' as const, label: 'Attach desktop evidence', enabled: true, reason: 'Ready.' },
      { key: 'route_support_packet' as const, label: 'Route support packet', enabled: true, reason: 'Ready.' },
      { key: 'dispatch_agent_review' as const, label: 'Dispatch agent review', enabled: true, reason: 'Ready.' },
    ],
  }
}

function persistentSession(overrides: Partial<StoredOnsiteDiagnosticSession> = {}): StoredOnsiteDiagnosticSession {
  return {
    id: OPS_SESSION_ID,
    state: 'active',
    created_at: '2026-06-12T12:00:00.000Z',
    expires_at: '2026-06-12T13:00:00.000Z',
    operator_user_id: 'user_42',
    label: 'Plant walkdown',
    intent: 'dispatch_agent_review',
    plan: readyPlan(),
    audit_events: [],
    agent_feed_deliveries: [],
    desktop_evidence: {
      capture_session_id: OPS_CAPTURE_SESSION_ID,
      artifact_id: '77777777-7777-4777-8777-777777777777',
      storage_key: 'company-1/capture-sessions/33333333-3333-4333-8333-333333333333/clip.mp4',
      file_path:
        '/api/capture-sessions/33333333-3333-4333-8333-333333333333/artifacts/77777777-7777-4777-8777-777777777777/file',
      status: 'attached',
      content_type: 'video/mp4',
      byte_size: 1024,
      error: null,
    },
    ...overrides,
  }
}

function persistentEvent(overrides: Partial<OpsOnsiteDiagnosticAuditEvent> = {}): OpsOnsiteDiagnosticAuditEvent {
  return {
    id: OPS_EVENT_ID,
    at: '2026-06-12T12:05:00.000Z',
    actor_user_id: 'user_99',
    type: 'action.requested',
    action_key: 'dispatch_agent_review',
    effect: 'audit_only',
    summary: 'Requested Dispatch agent review.',
    ...overrides,
  }
}

function contextWorkItemRow(params: unknown[]) {
  return {
    id: OPS_WORK_ITEM_ID,
    company_id: params[0],
    support_packet_id: params[1],
    domain: params[2],
    title: params[3],
    summary: params[4],
    status: params[5],
    lane: params[6],
    severity: params[7],
    route: params[8],
    capture_session_id: params[9],
    entity_type: params[10],
    entity_id: params[11],
    assignee_user_id: params[12],
    created_by_user_id: params[13],
    created_at: '2026-06-12T12:05:00.000Z',
    updated_at: '2026-06-12T12:05:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: null,
    metadata: JSON.parse(String(params[14] ?? '{}')),
    dedup_key: null,
  }
}

function handoffEventRow(params: unknown[]) {
  return {
    id: `event-${String(params[2])}`,
    company_id: params[0],
    work_item_id: params[1],
    event_type: params[2],
    actor_kind: params[3],
    actor_user_id: params[4],
    actor_ref: params[5],
    source_system: params[6],
    payload: JSON.parse(String(params[7] ?? '{}')),
    metadata: JSON.parse(String(params[8] ?? '{}')),
    idempotency_key: params[9],
    causation_event_id: null,
    correlation_id: null,
    request_id: null,
    capture_session_id: params[13],
    sentry_trace: null,
    sentry_baggage: null,
    build_sha: null,
    redaction_version: 'context-handoff-v1',
    occurred_at: '2026-06-12T12:05:00.000Z',
    recorded_at: '2026-06-12T12:05:00.000Z',
  }
}

class PersistentOpsClient {
  calls: Array<{ sql: string; params: unknown[] }> = []
  mutationOutbox: Array<{
    id: string
    company_id: string
    entity_type: string
    entity_id: string
    mutation_type: string
    payload: unknown
    idempotency_key: string
    status: string
    attempt_count: number
    error: string | null
  }> = []
  sessionEvents: Array<{
    id: string
    actor_user_id: string | null
    event_type: string
    action_key: string | null
    effect: string
    summary: string
    created_at: string
    client_action_id: string | null
    result: unknown
  }> = []
  actionResults: Array<{
    company_id: string
    session_id: string
    event_id: string
    result_key: string
    result: unknown
  }> = []

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push({ sql: normalized, params })
    if (normalized.startsWith('update ops_diagnostic_sessions')) {
      return {
        rows: [
          {
            id: OPS_SESSION_ID,
            operator_user_id: 'user_42',
            label: 'Plant walkdown',
            intent: 'dispatch_agent_review',
            plan: readyPlan(),
            control_token_hash: 'hash',
            state: 'active',
            expires_at: '2026-06-12T13:00:00.000Z',
            created_at: '2026-06-12T12:00:00.000Z',
          },
        ],
        rowCount: 1,
      }
    }
    if (normalized.startsWith('insert into ops_diagnostic_session_events')) {
      const hasClientActionId = normalized.includes('client_action_id')
      const controlEvent = normalized.includes("'action.requested', null")
      this.sessionEvents.push({
        id: String(params[0]),
        actor_user_id: (params[3] as string | null) ?? null,
        event_type: controlEvent ? 'action.requested' : String(params[4]),
        action_key: hasClientActionId ? ((params[5] as string | null) ?? null) : null,
        effect: 'audit_only',
        summary: String(hasClientActionId ? params[6] : controlEvent ? params[4] : params[5]),
        created_at: String(hasClientActionId ? params[7] : controlEvent ? params[5] : params[6]),
        client_action_id: hasClientActionId ? ((params[8] as string | null) ?? null) : null,
        result: null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id, actor_user_id, event_type, action_key')) {
      if (normalized.includes('client_action_id = $4')) {
        const rows = this.sessionEvents.filter(
          (event) =>
            event.action_key === params[2] &&
            event.client_action_id === params[3] &&
            event.event_type === 'action.requested',
        )
        return { rows, rowCount: rows.length }
      }
      return { rows: this.sessionEvents, rowCount: this.sessionEvents.length }
    }
    if (normalized.startsWith('select event_id::text as event_id, result_key, result')) {
      const eventIds = new Set((params[2] as string[] | undefined) ?? [])
      const rows = this.actionResults
        .filter((row) => row.company_id === params[0] && row.session_id === params[1] && eventIds.has(row.event_id))
        .map((row) => ({
          event_id: row.event_id,
          result_key: row.result_key,
          result: row.result,
        }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('update ops_diagnostic_session_events set result')) {
      const event = this.sessionEvents.find(
        (candidate) => candidate.id === params[2] && candidate.client_action_id !== undefined,
      )
      if (event) event.result = JSON.parse(String(params[3] ?? 'null'))
      return { rows: [], rowCount: event ? 1 : 0 }
    }
    if (normalized.startsWith('insert into ops_diagnostic_action_results')) {
      const companyId = String(params[0])
      const sessionId = String(params[1])
      const eventId = String(params[2])
      const resultKey = String(params[3])
      const result = JSON.parse(String(params[4] ?? '{}'))
      const existing = this.actionResults.find(
        (row) => row.company_id === companyId && row.event_id === eventId && row.result_key === resultKey,
      )
      if (existing) {
        existing.result = result
      } else {
        this.actionResults.push({
          company_id: companyId,
          session_id: sessionId,
          event_id: eventId,
          result_key: resultKey,
          result,
        })
      }
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id, audience, concern_ref, status')) return { rows: [], rowCount: 0 }
    if (normalized.startsWith('select s.id::text as capture_session_id')) return { rows: [], rowCount: 0 }
    if (normalized.startsWith('select id::text as context_work_item_id')) return { rows: [], rowCount: 0 }
    if (normalized.startsWith('insert into support_debug_packets')) {
      return {
        rows: [{ id: OPS_SUPPORT_PACKET_ID, created_at: '2026-06-12T12:05:00.000Z', expires_at: params[9] }],
        rowCount: 1,
      }
    }
    if (normalized.startsWith('insert into context_work_items')) {
      return { rows: [contextWorkItemRow(params)], rowCount: 1 }
    }
    if (normalized.startsWith('update context_work_items')) return { rows: [{ metadata: {} }], rowCount: 1 }
    if (normalized.startsWith('insert into context_handoff_events')) {
      return { rows: [handoffEventRow(params)], rowCount: 1 }
    }
    if (normalized.startsWith('insert into agent_feed_concerns')) {
      return { rows: [{ id: OPS_FEED_ID }], rowCount: 1 }
    }
    if (normalized.startsWith('update agent_feed_concerns')) return { rows: [], rowCount: 2 }
    if (normalized.startsWith('insert into mutation_outbox')) {
      const companyId = String(params[0])
      const idempotencyKey = String(params[7])
      const existing = this.mutationOutbox.find(
        (row) => row.company_id === companyId && row.idempotency_key === idempotencyKey,
      )
      const payload = JSON.parse(String(params[6] ?? '{}'))
      if (existing) {
        existing.payload = payload
        existing.status = 'pending'
        existing.attempt_count += 1
        existing.error = null
      } else {
        this.mutationOutbox.push({
          id: OPS_CAPTURE_ROUTE_OUTBOX_ID,
          company_id: companyId,
          entity_type: String(params[3]),
          entity_id: String(params[4]),
          mutation_type: String(params[5]),
          payload,
          idempotency_key: idempotencyKey,
          status: 'pending',
          attempt_count: 0,
          error: null,
        })
      }
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id::text as id from mutation_outbox')) {
      const row = this.mutationOutbox.find(
        (candidate) => candidate.company_id === params[0] && candidate.idempotency_key === params[1],
      )
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('update mutation_outbox')) {
      const row = this.mutationOutbox.find(
        (candidate) => candidate.company_id === params[0] && candidate.idempotency_key === params[1],
      )
      if (row) {
        row.status = String(params[2])
        row.attempt_count += 1
        row.error = (params[3] as string | null) ?? null
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    throw new Error(`unexpected query: ${normalized}`)
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
  requestHeaders: Headers[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    if (url.endsWith('/ingest')) {
      requestHeaders.push(new Headers(init?.headers))
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
      agentFeedLiveness: liveAgentFeedLiveness(),
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
        audience_live: true,
        last_poll_at: '2026-06-12T12:00:00.000Z',
        last_poll_age_seconds: 10,
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

  it('blocks routed actions when the onsite agent feed audience has no recent poll', async () => {
    const response = await buildOpsDiagnostics({
      fetchImpl: greenFetch(),
      gatewayDiagnosticsUrl: 'http://gateway.local/api/diagnostics',
      screenCaptureUrl: 'http://screen.local',
      captureRouterUrl: 'http://router.local',
      timeoutMs: 500,
      ...READY_AGENT_FEED_OPTIONS,
      agentFeedLiveness: null,
    })

    expect(response.status).toBe('degraded')
    expect(response.components.find((c) => c.key === 'agent_feed')).toMatchObject({
      status: 'degraded',
      detail: 'Onsite diagnostic audience has a token, but no recent executor poll is visible.',
      facts: {
        audience_configured: true,
        tokens_configured: true,
        audience_has_token: true,
        audience_live: false,
        last_poll_at: null,
        last_poll_age_seconds: null,
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
        key: 'dispatch_agent_review',
        enabled: false,
        reason: 'Gateway, capture router, and agent feed are not all ready.',
      }),
    )
  })

  it('starts an expiring onsite diagnostic session without exposing the control token in later reads', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const responses: Array<{ status: number; body: unknown }> = []
      const capabilities: string[] = []
      const handled = await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async (capability) => {
            capabilities.push(capability)
            return true
          },
          sendJson: (status, body) => responses.push({ status, body }),
          readBody: async () => ({
            label: 'Plant walkdown',
            intent: 'dispatch_agent_review',
            worker_issue_id: OPS_WORKER_ISSUE_ID,
          }),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        }),
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
          worker_issue_id?: string | null
          plan?: { control_level?: string; recommended_entry?: string }
          audit_events?: Array<{ type: string; effect: string }>
          diagnostic_manifest?: {
            schema: string
            readiness: { work_evidence: string; agent_handoff: string }
            evidence: { refs: Array<{ type: string; id: string }> }
          }
        }
      }
      expect(created.control_token).toEqual(expect.any(String))
      expect(created.session).toMatchObject({
        operator_user_id: 'user_42',
        label: 'Plant walkdown',
        worker_issue_id: OPS_WORKER_ISSUE_ID,
        plan: { control_level: 'route', recommended_entry: 'dispatch_agent_review' },
      })
      expect(created.session?.audit_events).toEqual([
        expect.objectContaining({ type: 'session.started', effect: 'audit_only' }),
      ])
      expect(created.session?.diagnostic_manifest).toMatchObject({
        schema: 'sitelayer.ops_diagnostic_manifest.v1',
        worker_issue_id: OPS_WORKER_ISSUE_ID,
        readiness: {
          work_evidence: 'audit_only',
          agent_handoff: 'not_requested',
        },
      })
      expect(created.session?.diagnostic_manifest?.evidence.refs).toContainEqual(
        expect.objectContaining({ type: 'ops_diagnostic_session', id: created.session?.id }),
      )
      expect(created.session?.diagnostic_manifest?.evidence.refs).toContainEqual(
        expect.objectContaining({ type: 'worker_issue', id: OPS_WORKER_ISSUE_ID }),
      )
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

  it('rejects malformed worker issue links before starting an onsite diagnostic session', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const responses: Array<{ status: number; body: unknown }> = []
      const handled = await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => responses.push({ status, body }),
          readBody: async () => ({ worker_issue_id: 'not-a-uuid' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        }),
      )

      expect(handled).toBe(true)
      expect(responses[0]).toEqual({
        status: 400,
        body: { error: 'worker_issue_id must be a UUID' },
      })
    })
  })

  it('records token-gated onsite diagnostic actions and routes a capture WorkRequest', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const routedEnvelopes: unknown[] = []
      const routedHeaders: Headers[] = []
      const fetchImpl = routedFetch(routedEnvelopes, undefined, routedHeaders)
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({}),
          getCurrentUserId: () => 'user_42',
          fetchImpl,
        }),
      )
      const created = createdResponses[0]?.body as { control_token: string; session: { id: string } }
      const clientActionId = `tap:${created.session.id}:dispatch`

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
            client_action_id: clientActionId,
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
          diagnostic_manifest: expect.objectContaining({
            readiness: expect.objectContaining({
              work_evidence: 'audit_only',
              agent_handoff: 'not_requested',
            }),
            agent_handoff: expect.objectContaining({
              callback_expected: false,
            }),
          }),
        },
      })
      expect(routedEnvelopes).toHaveLength(1)
      const firstAction = actionResponses[0]?.body as OpsOnsiteDiagnosticSessionActionResponse
      const firstDeliveryId = firstAction.accepted_action.capture_route?.delivery_id

      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => actionResponses.push({ status, body }),
          readBody: async () => ({
            control_token: created.control_token,
            action_key: 'dispatch_agent_review',
            client_action_id: clientActionId,
          }),
          getCurrentUserId: () => 'user_99',
          fetchImpl,
        },
      )
      const replayedAction = actionResponses[1]?.body as OpsOnsiteDiagnosticSessionActionResponse
      expect(actionResponses[1]?.status).toBe(202)
      expect(replayedAction.accepted_action.capture_route?.delivery_id).toBe(firstDeliveryId)
      expect(routedEnvelopes).toHaveLength(1)
      expect(routedHeaders[0]?.get('idempotency-key')).toBe(firstDeliveryId)
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
                  agent_tool_manifest_path: '/api/agent-tools/manifest',
                  callback_expectation: expect.objectContaining({
                    expected: false,
                    terminal_statuses: ['succeeded', 'failed', 'cancelled'],
                  }),
                  diagnostic_manifest: expect.objectContaining({
                    schema: 'sitelayer.ops_diagnostic_manifest.v1',
                    readiness: expect.objectContaining({
                      work_evidence: 'audit_only',
                    }),
                  }),
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

  it('routes field-context capture actions through the capture router', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const routedEnvelopes: unknown[] = []
      const fetchImpl = routedFetch(routedEnvelopes)
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({ intent: 'capture_field_context' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl,
        }),
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
            action_key: 'capture_field_context',
          }),
          getCurrentUserId: () => 'user_99',
          fetchImpl,
        },
      )

      expect(actionResponses[0]?.status).toBe(202)
      expect(actionResponses[0]?.body).toMatchObject({
        accepted_action: {
          key: 'capture_field_context',
          capture_route: {
            status: 'accepted',
            request_ref: `opsdiag:${created.session.id}:capture_field_context`,
          },
        },
      })
      expect(routedEnvelopes).toHaveLength(1)
      expect(routedEnvelopes[0]).toMatchObject({
        events: [
          expect.objectContaining({
            event_type: 'sitelayer.ops_diagnostic.capture_field_context.requested',
            payload: {
              work_request: expect.objectContaining({
                request_ref: `opsdiag:${created.session.id}:capture_field_context`,
                intent: 'capture-followup',
              }),
            },
          }),
        ],
      })
    })
  })

  it('extends and cancels token-gated onsite diagnostic control windows', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({ label: 'Plant walkdown', intent: 'dispatch_agent_review' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        }),
      )
      const created = createdResponses[0]?.body as {
        control_token: string
        session: { id: string; expires_at: string }
      }
      const originalExpiry = Date.parse(created.session.expires_at)

      const deniedResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => deniedResponses.push({ status, body }),
          readBody: async () => ({ control_token: 'wrong', action: 'extend' }),
        },
      )
      expect(deniedResponses).toEqual([{ status: 403, body: { error: 'invalid control token' } }])

      const extendResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control`),
        {
          requireCapability: async (capability) => {
            expect(capability).toBe('app_issue.capture')
            return true
          },
          sendJson: (status, body) => extendResponses.push({ status, body }),
          readBody: async () => ({ control_token: created.control_token, action: 'extend' }),
          getCurrentUserId: () => 'user_99',
        },
      )
      const extended = extendResponses[0]?.body as {
        schema: string
        control: { action: string; expires_at: string }
        session: { state: string; expires_at: string; audit_events: Array<{ summary: string }> }
      }
      expect(extendResponses[0]?.status).toBe(200)
      expect(extended).toMatchObject({
        schema: 'sitelayer.ops_diagnostic_session_control.v1',
        control: { action: 'extend' },
        session: { state: 'active' },
      })
      expect(Date.parse(extended.session.expires_at)).toBeGreaterThanOrEqual(originalExpiry)
      expect(extended.session.audit_events.map((event) => event.summary)).toContain(
        'Extended onsite diagnostic control.',
      )

      const cancelResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => cancelResponses.push({ status, body }),
          readBody: async () => ({ control_token: created.control_token, action: 'cancel' }),
          getCurrentUserId: () => 'user_99',
        },
      )
      expect(cancelResponses[0]?.status).toBe(200)
      expect(cancelResponses[0]?.body).toMatchObject({
        control: { action: 'cancel' },
        session: { state: 'cancelled' },
      })

      const readAfterCancel: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'GET' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => readAfterCancel.push({ status, body }),
        },
      )
      expect(readAfterCancel).toEqual([{ status: 404, body: { error: 'diagnostic session not found' } }])
    })
  })

  it('transfers and revokes onsite diagnostic control tokens', async () => {
    await withReadyOpsAgentFeed(async () => {
      __resetOpsDiagnosticSessionsForTests()
      const createdResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL('http://localhost/api/ops/diagnostics/sessions'),
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({ label: 'Plant walkdown', intent: 'capture_field_context' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl: greenFetch(),
        }),
      )
      const created = createdResponses[0]?.body as {
        control_token: string
        session: { id: string }
      }

      const transferResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => transferResponses.push({ status, body }),
          readBody: async () => ({ control_token: created.control_token, action: 'transfer' }),
          getCurrentUserId: () => 'user_99',
        },
      )
      const transferred = transferResponses[0]?.body as {
        control: { action: string; transfer_token: string; control_token?: string }
        session: { audit_events: Array<{ summary: string }> }
      }
      expect(transferResponses[0]?.status).toBe(200)
      expect(transferred.control).toMatchObject({ action: 'transfer', transfer_token: expect.any(String) })
      expect(transferred.control.control_token).toBeUndefined()
      expect(transferred.control.transfer_token).not.toBe(created.control_token)
      expect(transferred.session.audit_events.map((event) => event.summary)).toContain(
        'Created onsite diagnostic control handoff.',
      )

      const oldTokenBeforeRedeemResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => oldTokenBeforeRedeemResponses.push({ status, body }),
          readBody: async () => ({
            control_token: created.control_token,
            action_key: 'capture_field_context',
          }),
        },
      )
      expect(oldTokenBeforeRedeemResponses[0]?.status).toBe(202)

      const redeemResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control/redeem`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => redeemResponses.push({ status, body }),
          readBody: async () => ({ transfer_token: transferred.control.transfer_token }),
          getCurrentUserId: () => 'user_100',
        },
      )
      const redeemed = redeemResponses[0]?.body as {
        control: { action: string; control_token: string }
        session: { audit_events: Array<{ summary: string }> }
      }
      expect(redeemResponses[0]?.status).toBe(200)
      expect(redeemed.control).toMatchObject({ action: 'redeem', control_token: expect.any(String) })
      expect(redeemed.control.control_token).not.toBe(created.control_token)
      expect(redeemed.control.control_token).not.toBe(transferred.control.transfer_token)
      expect(redeemed.session.audit_events.map((event) => event.summary)).toContain(
        'Redeemed onsite diagnostic control handoff.',
      )

      const transferReplayResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control/redeem`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => transferReplayResponses.push({ status, body }),
          readBody: async () => ({ transfer_token: transferred.control.transfer_token }),
        },
      )
      expect(transferReplayResponses).toEqual([{ status: 403, body: { error: 'invalid transfer token' } }])

      const oldTokenResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => oldTokenResponses.push({ status, body }),
          readBody: async () => ({
            control_token: created.control_token,
            action_key: 'capture_field_context',
          }),
        },
      )
      expect(oldTokenResponses).toEqual([{ status: 403, body: { error: 'invalid control token' } }])

      const newTokenResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => newTokenResponses.push({ status, body }),
          readBody: async () => ({
            control_token: redeemed.control.control_token,
            action_key: 'capture_field_context',
          }),
        },
      )
      expect(newTokenResponses[0]?.status).toBe(202)

      const revokeResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/control`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => revokeResponses.push({ status, body }),
          readBody: async () => ({ control_token: redeemed.control.control_token, action: 'revoke' }),
          getCurrentUserId: () => 'user_99',
        },
      )
      expect(revokeResponses[0]?.status).toBe(200)
      expect(revokeResponses[0]?.body).toMatchObject({
        control: { action: 'revoke' },
        session: { state: 'active' },
      })
      expect(JSON.stringify(revokeResponses[0]?.body)).not.toContain(redeemed.control.control_token)

      const revokedTokenResponses: Array<{ status: number; body: unknown }> = []
      await handleOpsDiagnosticsRoutes(
        { method: 'POST' } as http.IncomingMessage,
        new URL(`http://localhost/api/ops/diagnostics/sessions/${created.session.id}/actions`),
        {
          requireCapability: async () => true,
          sendJson: (status, body) => revokedTokenResponses.push({ status, body }),
          readBody: async () => ({
            control_token: redeemed.control.control_token,
            action_key: 'capture_field_context',
          }),
        },
      )
      expect(revokedTokenResponses).toEqual([{ status: 403, body: { error: 'invalid control token' } }])
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
        readyOpsRouteCtx({
          requireCapability: async () => true,
          sendJson: (status, body) => createdResponses.push({ status, body }),
          readBody: async () => ({ intent: 'capture_desktop_context' }),
          getCurrentUserId: () => 'user_42',
          fetchImpl,
        }),
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

  it('deletes uploaded desktop evidence when DB attachment fails', async () => {
    const storage = new MemoryStorage()
    const fetchImpl: typeof fetch = async () =>
      new Response(Buffer.from('orphan candidate'), { headers: { 'content-type': 'video/mp4' } })
    const runTx = async <T>(): Promise<T> => {
      throw new Error('capture artifact insert failed')
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
      status: 'failed',
      error: 'capture artifact insert failed',
      artifact_id: null,
      storage_key: null,
    })
    expect(storage.writes).toHaveLength(1)
    expect(storage.deletes).toEqual([storage.writes[0]!.key])
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

  it('links routed persistent onsite actions to a support packet and app issue', async () => {
    await withReadyOpsAgentFeed(async () => {
      const client = new PersistentOpsClient()
      const session = persistentSession({ worker_issue_id: OPS_WORKER_ISSUE_ID })
      const result = await __enqueueOnsiteDiagnosticConcernForTests(client as unknown as PoolClient, {
        companyId: 'company-1',
        session,
        event: persistentEvent(),
        actionKey: 'dispatch_agent_review',
        actionLabel: 'Dispatch agent review',
        actorUserId: 'user_99',
        requestedAt: '2026-06-12T12:05:00.000Z',
      })

      expect(result).toMatchObject({
        audience: 'onsite-diagnostics',
        concern_ref: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`,
        queued: true,
        id: OPS_FEED_ID,
        support_packet_id: OPS_SUPPORT_PACKET_ID,
        context_work_item_id: OPS_WORK_ITEM_ID,
      })

      const supportInsert = client.calls.find((call) => call.sql.startsWith('insert into support_debug_packets'))
      expect(supportInsert?.params.slice(0, 5)).toEqual([
        'company-1',
        'user_99',
        null,
        '/ops',
        OPS_CAPTURE_SESSION_ID,
      ])
      expect(JSON.stringify(supportInsert?.params)).toContain(OPS_SESSION_ID)
      expect(JSON.stringify(supportInsert?.params)).toContain(OPS_WORKER_ISSUE_ID)

      const workItemInsert = client.calls.find((call) => call.sql.startsWith('insert into context_work_items'))
      expect(workItemInsert?.params.slice(0, 4)).toEqual([
        'company-1',
        OPS_SUPPORT_PACKET_ID,
        'app_issue',
        'Dispatch agent review for onsite diagnostics',
      ])
      expect(workItemInsert?.params).toContain('ops_diagnostic_session')
      expect(workItemInsert?.params).toContain(OPS_SESSION_ID)
      expect(JSON.stringify(workItemInsert?.params[14])).toContain(OPS_WORKER_ISSUE_ID)

      const feedInsert = client.calls.find((call) => call.sql.startsWith('insert into agent_feed_concerns'))
      expect(feedInsert?.params[5]).toBe(OPS_WORK_ITEM_ID)
      expect(feedInsert?.params[6]).toBe(OPS_CAPTURE_SESSION_ID)
      const concern = JSON.parse(String(feedInsert?.params[4] ?? '{}')) as Record<string, unknown>
      expect(concern).toMatchObject({
        concern_ref: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`,
        audience: 'onsite-diagnostics',
        inputs: {
          work_item_id: OPS_WORK_ITEM_ID,
          support_packet_id: OPS_SUPPORT_PACKET_ID,
          capture_session_id: OPS_CAPTURE_SESSION_ID,
          worker_issue_id: OPS_WORKER_ISSUE_ID,
        },
      })
      expect(JSON.stringify(concern)).toContain('diagnostic_manifest')
      expect(JSON.stringify(concern)).toContain(OPS_WORK_ITEM_ID)

      const eventTypes = client.calls
        .filter((call) => call.sql.startsWith('insert into context_handoff_events'))
        .map((call) => call.params[2])
      expect(eventTypes).toEqual(['work_item.created', 'agent.dispatch_requested'])

      const manifest = __buildOpsOnsiteDiagnosticManifestForTests({
        ...persistentSession({
          worker_issue_id: OPS_WORKER_ISSUE_ID,
          support_packet_id: OPS_SUPPORT_PACKET_ID,
          context_work_item_id: OPS_WORK_ITEM_ID,
        }),
        audit_events: [persistentEvent()],
        agent_feed_deliveries: [
          {
            id: OPS_FEED_ID,
            action_key: 'dispatch_agent_review',
            audience: 'onsite-diagnostics',
            concern_ref: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`,
            status: 'pending',
            queued_at: '2026-06-12T12:05:00.000Z',
            claimed_at: null,
            completed_at: null,
            callback_status: null,
            callback_error: null,
            stale: false,
          },
        ],
      })
      expect(manifest).toMatchObject({
        support_packet_id: OPS_SUPPORT_PACKET_ID,
        context_work_item_id: OPS_WORK_ITEM_ID,
        readiness: {
          work_evidence: 'work_item_attached',
          agent_handoff: 'queued',
        },
      })
      expect(manifest.evidence.refs).toContainEqual(
        expect.objectContaining({ type: 'support_debug_packet', id: OPS_SUPPORT_PACKET_ID }),
      )
      expect(manifest.evidence.refs).toContainEqual(
        expect.objectContaining({ type: 'context_work_item', id: OPS_WORK_ITEM_ID }),
      )
      expect(manifest.evidence.refs).toContainEqual(
        expect.objectContaining({ type: 'worker_issue', id: OPS_WORKER_ISSUE_ID }),
      )
    })
  })

  it('surfaces newest onsite work while keeping routed agent work anchored', async () => {
    const latestClient = new PersistentOpsClient()
    await __latestPersistentOnsiteWorkLinkForTests(
      latestClient as unknown as PoolClient,
      'company-1',
      OPS_SESSION_ID,
    )
    const latestLookup = latestClient.calls.find((call) =>
      call.sql.startsWith('select id::text as context_work_item_id'),
    )
    expect(latestLookup?.sql).toContain('order by created_at desc, id desc')
    expect(latestLookup?.sql).not.toContain('for update')

    const anchorClient = new PersistentOpsClient()
    await __anchorPersistentOnsiteWorkLinkForTests(
      anchorClient as unknown as PoolClient,
      'company-1',
      OPS_SESSION_ID,
    )
    const anchorLookup = anchorClient.calls.find((call) =>
      call.sql.startsWith('select id::text as context_work_item_id'),
    )
    expect(anchorLookup?.sql).toContain('order by created_at asc, id asc')
    expect(anchorLookup?.sql).toContain('limit 1 for update')
  })

  it('creates routable work evidence for persistent field-context capture actions', async () => {
    const client = new PersistentOpsClient()
    const result = await __recordPersistentOnsiteDiagnosticActionForTests(
      {
        companyId: 'company-1',
        session: persistentSession(),
        actionKey: 'capture_field_context',
        actionLabel: 'Capture field context',
        actorUserId: 'user_99',
      },
      async (companyId, fn) => {
        expect(companyId).toBe('company-1')
        return fn(client as unknown as PoolClient)
      },
    )

    expect(result).toMatchObject({
      agentFeed: null,
      captureRouteOutbox: {
        id: OPS_CAPTURE_ROUTE_OUTBOX_ID,
        request_ref: `opsdiag:${OPS_SESSION_ID}:capture_field_context`,
        delivery_id: expect.stringContaining(`opsdiag:${OPS_SESSION_ID}:capture_field_context:`),
      },
      session: {
        support_packet_id: OPS_SUPPORT_PACKET_ID,
        context_work_item_id: OPS_WORK_ITEM_ID,
      },
    })
    expect(__buildOpsOnsiteDiagnosticManifestForTests(result!.session)).toMatchObject({
      support_packet_id: OPS_SUPPORT_PACKET_ID,
      context_work_item_id: OPS_WORK_ITEM_ID,
      readiness: { work_evidence: 'work_item_attached' },
    })

    const supportInsert = client.calls.find((call) => call.sql.startsWith('insert into support_debug_packets'))
    const workItemInsert = client.calls.find((call) => call.sql.startsWith('insert into context_work_items'))
    const feedInsert = client.calls.find((call) => call.sql.startsWith('insert into agent_feed_concerns'))
    const handoffEventTypes = client.calls
      .filter((call) => call.sql.startsWith('insert into context_handoff_events'))
      .map((call) => call.params[2])
    const routeOutbox = client.mutationOutbox[0]

    expect(supportInsert?.params[6]).toBe('Operator requested Capture field context from Mobile Ops.')
    expect(JSON.parse(String(workItemInsert?.params[14] ?? '{}'))).toMatchObject({
      requested_action: 'capture_field_context',
    })
    expect(feedInsert).toBeUndefined()
    expect(handoffEventTypes).toEqual(['work_item.created'])
    expect(routeOutbox).toMatchObject({
      entity_type: 'ops_diagnostic_session',
      entity_id: OPS_SESSION_ID,
      mutation_type: 'ops_diagnostic_capture_route',
      idempotency_key: expect.stringContaining(`opsdiag:${OPS_SESSION_ID}:capture_field_context:`),
      status: 'pending',
    })
    expect(routeOutbox?.payload).toMatchObject({
      schema: 'sitelayer.ops_diagnostic_capture_route.v1',
      ops_diagnostic_session_id: OPS_SESSION_ID,
      action_key: 'capture_field_context',
      request_ref: `opsdiag:${OPS_SESSION_ID}:capture_field_context`,
    })
  })

  it('replays persistent onsite action retries without duplicating work evidence', async () => {
    const client = new PersistentOpsClient()
    const runTx = async <T,>(companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      expect(companyId).toBe('company-1')
      return fn(client as unknown as PoolClient)
    }
    const first = await __recordPersistentOnsiteDiagnosticActionForTests(
      {
        companyId: 'company-1',
        session: persistentSession(),
        actionKey: 'capture_field_context',
        actionLabel: 'Capture field context',
        actorUserId: 'user_99',
        clientActionId: 'tap-1',
      },
      runTx,
    )
    const second = await __recordPersistentOnsiteDiagnosticActionForTests(
      {
        companyId: 'company-1',
        session: first!.session,
        actionKey: 'capture_field_context',
        actionLabel: 'Capture field context',
        actorUserId: 'user_99',
        clientActionId: 'tap-1',
      },
      runTx,
    )

    expect(second).toMatchObject({
      replayed: true,
      event: { id: first!.event.id, client_action_id: 'tap-1' },
      session: {
        support_packet_id: OPS_SUPPORT_PACKET_ID,
        context_work_item_id: OPS_WORK_ITEM_ID,
      },
    })
    expect(client.calls.filter((call) => call.sql.startsWith('insert into ops_diagnostic_session_events'))).toHaveLength(
      1,
    )
    expect(client.calls.filter((call) => call.sql.startsWith('insert into support_debug_packets'))).toHaveLength(1)
    expect(client.calls.filter((call) => call.sql.startsWith('insert into context_work_items'))).toHaveLength(1)
    expect(client.calls.filter((call) => call.sql.startsWith('insert into context_handoff_events'))).toHaveLength(1)
    expect(client.mutationOutbox).toHaveLength(1)
  })

  it('hydrates persistent action replays from durable child results when the parent result is missing', async () => {
    const client = new PersistentOpsClient()
    const runTx = async <T,>(companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      expect(companyId).toBe('company-1')
      return fn(client as unknown as PoolClient)
    }
    const first = await __recordPersistentOnsiteDiagnosticActionForTests(
      {
        companyId: 'company-1',
        session: persistentSession(),
        actionKey: 'dispatch_agent_review',
        actionLabel: 'Dispatch agent review',
        actorUserId: 'user_99',
        clientActionId: 'tap-child-results',
      },
      runTx,
    )
    const acceptedAction: OpsOnsiteDiagnosticSessionActionResponse['accepted_action'] = {
      key: 'dispatch_agent_review',
      effect: 'audit_only',
      capture_route: {
        request_ref: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`,
        delivery_id: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review:${first!.event.id}`,
        outbox_id: OPS_CAPTURE_ROUTE_OUTBOX_ID,
        status: 'accepted',
        http_status: 202,
        routed: true,
        accepted: 1,
        error: null,
      },
      agent_feed: {
        audience: 'onsite-diagnostics',
        concern_ref: `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`,
        queued: true,
        id: OPS_FEED_ID,
        support_packet_id: null,
        context_work_item_id: null,
      },
    }
    await __persistOnsiteDiagnosticActionResultForTests(
      {
        companyId: 'company-1',
        sessionId: OPS_SESSION_ID,
        eventId: first!.event.id,
        acceptedAction,
      },
      runTx,
    )
    expect(client.actionResults.map((row) => row.result_key).sort()).toEqual(['agent_feed', 'capture_route'])

    client.sessionEvents[0]!.result = null
    const replayed = await __recordPersistentOnsiteDiagnosticActionForTests(
      {
        companyId: 'company-1',
        session: first!.session,
        actionKey: 'dispatch_agent_review',
        actionLabel: 'Dispatch agent review',
        actorUserId: 'user_99',
        clientActionId: 'tap-child-results',
      },
      runTx,
    )

    expect(replayed).toMatchObject({
      replayed: true,
      acceptedAction: {
        key: 'dispatch_agent_review',
        capture_route: {
          outbox_id: OPS_CAPTURE_ROUTE_OUTBOX_ID,
          status: 'accepted',
          http_status: 202,
        },
        agent_feed: {
          audience: 'onsite-diagnostics',
          queued: true,
          id: OPS_FEED_ID,
        },
      },
    })
    expect(client.calls.filter((call) => call.sql.startsWith('insert into ops_diagnostic_session_events'))).toHaveLength(
      1,
    )
    expect(client.mutationOutbox).toHaveLength(1)
  })

  it('keeps retryable capture-router delivery failures pending for the worker drain', () => {
    expect(
      __captureRouteOutboxStatusForTests({
        request_ref: 'opsdiag:session:dispatch_agent_review',
        delivery_id: 'opsdiag:session:dispatch_agent_review:event',
        status: 'accepted',
        http_status: 202,
        routed: true,
        accepted: 1,
        error: null,
      }),
    ).toBe('applied')
    expect(
      __captureRouteOutboxStatusForTests({
        request_ref: 'opsdiag:session:dispatch_agent_review',
        delivery_id: 'opsdiag:session:dispatch_agent_review:event',
        status: 'failed',
        http_status: 503,
        routed: false,
        accepted: null,
        error: 'router unavailable',
      }),
    ).toBe('pending')
    expect(
      __captureRouteOutboxStatusForTests({
        request_ref: 'opsdiag:session:dispatch_agent_review',
        delivery_id: 'opsdiag:session:dispatch_agent_review:event',
        status: 'failed',
        http_status: 400,
        routed: false,
        accepted: null,
        error: 'bad envelope',
      }),
    ).toBe('failed')
  })

  it('cancels pending and claimed routed agent-feed work when onsite control is cancelled', async () => {
    const client = new PersistentOpsClient()
    const cancelled = await __cancelOnsiteDiagnosticAgentFeedForTests(
      client as unknown as PoolClient,
      'company-1',
      OPS_SESSION_ID,
      '2026-06-12T12:15:00.000Z',
    )

    expect(cancelled).toBe(2)
    const cancelUpdate = client.calls.find((call) => call.sql.startsWith('update agent_feed_concerns'))
    expect(cancelUpdate?.params).toEqual([
      'company-1',
      [`opsdiag:${OPS_SESSION_ID}:route_support_packet`, `opsdiag:${OPS_SESSION_ID}:dispatch_agent_review`],
      '2026-06-12T12:15:00.000Z',
    ])
    expect(cancelUpdate?.sql).toContain("status in ('pending', 'claimed')")
    expect(cancelUpdate?.sql).toContain("status = 'cancelled'")
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

import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import {
  buildSupportServerContext,
  collectEntityRefs,
  collectRequestIds,
  handleSupportPacketRoutes,
  sanitizeSupportJson,
  type JsonRecord,
  type SupportPacketRouteCtx,
  type SupportPacketRow,
} from './support-packets.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

type SupportPacketAccessLog = {
  id: string
  support_packet_id: string
  actor_user_id: string
  access_type: string
  route: string | null
  request_id: string | null
  created_at: string
  metadata: JsonRecord
}

class FakeSupportPacketPool {
  accessLog: SupportPacketAccessLog[] = []
  auditRows: JsonRecord[] = []
  workflowRows: JsonRecord[] = []
  outboxRows: JsonRecord[] = []
  syncEventRows: JsonRecord[] = []
  workItemRows: JsonRecord[] = []
  workItemEventRows: JsonRecord[] = []
  captureSessionRows: JsonRecord[] = []
  captureEventRows: JsonRecord[] = []
  captureArtifactRows: JsonRecord[] = []
  supportPacket: SupportPacketRow = {
    id: '00000000-0000-4000-8000-000000000101',
    company_id: COMPANY_ID,
    actor_user_id: 'creator-1',
    request_id: 'request-1',
    route: '/projects/p/estimate',
    build_sha: 'test-build',
    problem: 'Estimate failed',
    client: {},
    server_context: { request_ids: ['request-1'], trace_ids: ['trace-1'] },
    created_at: '2026-05-21T12:00:00.000Z',
    expires_at: '2026-05-22T12:00:00.000Z',
    redaction_version: 'support-packet-v1',
  }

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private async dispatch(sqlRaw: string, params: unknown[] = []) {
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from support_debug_packets') && normalized.includes('limit 1')) {
      const [id, companyId] = params as [string, string]
      const row = id === this.supportPacket.id && companyId === COMPANY_ID ? this.supportPacket : null
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('insert into support_packet_access_log')) {
      const row: SupportPacketAccessLog = {
        id: `access-${this.accessLog.length + 1}`,
        support_packet_id: params[1] as string,
        actor_user_id: params[2] as string,
        access_type: params[3] as string,
        route: (params[4] as string | null) ?? null,
        request_id: (params[5] as string | null) ?? null,
        created_at: '2026-05-21T12:01:00.000Z',
        metadata: JSON.parse(params[6] as string) as JsonRecord,
      }
      this.accessLog.push(row)
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('from support_packet_access_log')) {
      const [, supportPacketId] = params as [string, string, number]
      const rows = this.accessLog.filter((row) => row.support_packet_id === supportPacketId)
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from audit_events')) {
      return { rows: this.auditRows, rowCount: this.auditRows.length }
    }
    if (normalized.includes('from workflow_event_log')) {
      return { rows: this.workflowRows, rowCount: this.workflowRows.length }
    }
    if (normalized.includes('from mutation_outbox') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: String(this.outboxRows.length) }], rowCount: 1 }
    }
    if (normalized.includes('from sync_events') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: String(this.syncEventRows.length) }], rowCount: 1 }
    }
    if (normalized.includes('from mutation_outbox')) {
      return { rows: this.outboxRows, rowCount: this.outboxRows.length }
    }
    if (normalized.includes('from sync_events')) {
      return { rows: this.syncEventRows, rowCount: this.syncEventRows.length }
    }
    if (normalized.includes('from context_work_items') && normalized.includes('left join support_debug_packets')) {
      return { rows: this.workItemRows, rowCount: this.workItemRows.length }
    }
    if (normalized.includes('from context_handoff_events')) {
      return { rows: this.workItemEventRows, rowCount: this.workItemEventRows.length }
    }
    if (normalized.includes('from capture_sessions')) {
      const [, captureSessionId] = params as [string, string]
      const rows = this.captureSessionRows.filter((row) => row.id === captureSessionId)
      return { rows: rows.slice(0, 1), rowCount: rows.length ? 1 : 0 }
    }
    if (normalized.includes('from capture_session_events')) {
      const [, captureSessionId] = params as [string, string]
      const rows = this.captureEventRows.filter((row) => row.capture_session_id === captureSessionId)
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from capture_artifacts')) {
      const [, captureSessionId] = params as [string, string]
      const rows = this.captureArtifactRows
        .filter((row) => row.capture_session_id === captureSessionId && !row.deleted_at)
        .map(
          ({
            storage_key: _storageKey,
            uri: _uri,
            capture_session_id: _captureSessionId,
            deleted_at: _deletedAt,
            ...row
          }) => row,
        )
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method, headers: {} } as http.IncomingMessage
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(pool: FakeSupportPacketPool): {
  ctx: SupportPacketRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' }
  const identity: Identity = { userId: 'admin-1', source: 'default' }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      identity,
      tier: 'local',
      buildSha: 'test-build',
      // app_issue.view gates the read paths. The fixture caller holds it.
      requireCapability: async () => true,
      readBody: async () => ({}),
      sendJson: (status, body) => responses.push({ status, body }),
    },
  }
}

describe('support packet sanitization', () => {
  it('redacts obvious secrets and contact details', () => {
    expect(
      sanitizeSupportJson({
        authorization: 'Bearer abc',
        nested: {
          email: 'person@example.com',
          phone: '204-555-1212',
        },
      }),
    ).toEqual({
      authorization: '[redacted]',
      nested: {
        email: '[email]',
        phone: '[phone]',
      },
    })
  })

  it('collects client and server request ids', () => {
    expect(
      collectRequestIds(
        {
          requests: [{ request_id: 'web-one', response_request_id: 'api-one' }, { requestId: 'web-two' }],
        },
        'api-current',
      ),
    ).toEqual(['api-current', 'web-one', 'api-one', 'web-two'])
  })

  it('collects entity refs from Probe path payloads', () => {
    expect(
      collectEntityRefs({
        path: {
          route: '/financial/estimate-pushes/11111111-1111-4111-8111-111111111111',
          entity_type: 'estimate_push',
          entity_id: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).toEqual([
      {
        entity_type: 'estimate_push',
        entity_id: '11111111-1111-4111-8111-111111111111',
      },
    ])
  })

  it('records support packet prompt reads in the access log', async () => {
    const pool = new FakeSupportPacketPool()
    const read = makeCtx(pool)

    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}`),
      read.ctx,
    )

    expect(read.responses[0]?.status).toBe(200)
    expect(pool.accessLog).toMatchObject([
      {
        support_packet_id: pool.supportPacket.id,
        actor_user_id: 'admin-1',
        access_type: 'agent_prompt',
      },
    ])
    const listed = makeCtx(pool)
    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}/access-log`),
      listed.ctx,
    )
    expect(listed.responses[0]?.status).toBe(200)
    expect(listed.responses[0]?.body).toMatchObject({
      access_log: [
        {
          support_packet_id: pool.supportPacket.id,
          access_type: 'agent_prompt',
        },
      ],
    })
  })

  it('renders statechart anchors + replay divergence into the agent_prompt', async () => {
    const pool = new FakeSupportPacketPool()
    pool.supportPacket = {
      ...pool.supportPacket,
      server_context: {
        request_ids: ['request-1'],
        trace_ids: ['trace-1'],
        anchors: [
          {
            event_ref: 'workflow_event:rental_billing_run:c83aab21680dc2bb:0',
            workflow_name: 'rental_billing_run',
            entity_type: 'rental_billing_run',
            entity_id: '11111111-2222-3333-4444-555555555555',
            state_version: 0,
            event_type: 'APPROVE',
            from_state: 'generated',
            to_state: 'approved',
            applied_at: '2026-06-06T00:00:01.000Z',
            sentry_trace: 'abc-1',
            replay_ok: false,
            replay_available: true,
            first_divergence: {
              state_version: 1,
              event_type: 'POST_REQUESTED',
              reason: 'snapshot_divergence',
              detail: 'state mismatch',
            },
          },
        ],
      },
    }
    const read = makeCtx(pool)
    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}`),
      read.ctx,
    )
    expect(read.responses[0]?.status).toBe(200)
    const prompt = (read.responses[0]?.body as { agent_prompt: string }).agent_prompt
    expect(prompt).toContain('Statechart transition anchors')
    expect(prompt).toContain('rental_billing_run generated -> approved via APPROVE')
    expect(prompt).toContain('replay DIVERGED at state_version 1: snapshot_divergence (state mismatch)')
  })

  it('omits the anchors section when no statechart anchors were captured', async () => {
    const pool = new FakeSupportPacketPool()
    const read = makeCtx(pool)
    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}`),
      read.ctx,
    )
    expect(read.responses[0]?.status).toBe(200)
    const prompt = (read.responses[0]?.body as { agent_prompt: string }).agent_prompt
    expect(prompt).not.toContain('Statechart transition anchors')
  })

  it('includes related work-request context and handoff traces in server context', async () => {
    const pool = new FakeSupportPacketPool()
    const captureSessionId = '55555555-5555-4555-8555-555555555555'
    pool.attach()
    pool.workItemRows = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        support_packet_id: pool.supportPacket.id,
        title: 'Estimate push failed',
        summary: 'The user could not send the estimate.',
        status: 'agent_running',
        lane: 'agent',
        severity: 'high',
        route: '/financial/estimate-pushes/33333333-3333-4333-8333-333333333333',
        entity_type: 'estimate_push',
        entity_id: '33333333-3333-4333-8333-333333333333',
        assignee_user_id: null,
        created_by_user_id: 'creator-1',
        created_at: '2026-05-21T12:00:00.000Z',
        updated_at: '2026-05-21T12:02:00.000Z',
        resolved_at: null,
        metadata: { client_request_id: 'request-1' },
        support_request_id: 'request-1',
      },
    ]
    pool.workItemEventRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        work_item_id: '22222222-2222-4222-8222-222222222222',
        event_type: 'agent.dispatch_requested',
        actor_kind: 'user',
        actor_user_id: 'creator-1',
        actor_ref: null,
        source_system: 'sitelayer',
        payload: { note: 'dispatch requested' },
        metadata: {},
        request_id: 'request-1',
        sentry_trace: '0123456789abcdef0123456789abcdef-0123456789abcdef-1',
        build_sha: 'test-build',
        occurred_at: '2026-05-21T12:01:00.000Z',
        recorded_at: '2026-05-21T12:01:00.000Z',
      },
    ]
    pool.captureSessionRows = [
      {
        id: captureSessionId,
        mode: 'feedback',
        status: 'stopped',
        route_path: '/financial/estimate-pushes/33333333-3333-4333-8333-333333333333',
        device_kind: 'desktop',
        platform: 'web',
        viewport: '1440x900',
        app_build_sha: 'test-build',
        consent_version: 'pilot-v1',
        redaction_version: 'capture-session-v1',
        started_at: '2026-05-21T12:00:00.000Z',
        last_seen_at: '2026-05-21T12:02:00.000Z',
        stopped_at: '2026-05-21T12:02:00.000Z',
        discarded_at: null,
        retention_expires_at: '2026-06-20T12:00:00.000Z',
      },
    ]
    pool.captureEventRows = [
      {
        id: 'capture-event-1',
        capture_session_id: captureSessionId,
        seq: '1',
        event_type: 'ui.click',
        event_class: 'dead_control',
        route_path: '/financial/estimate-pushes/33333333-3333-4333-8333-333333333333',
        workflow_id: 'estimate_push',
        entity_type: 'estimate_push',
        entity_id: '33333333-3333-4333-8333-333333333333',
        request_id: 'request-1',
        payload: { control: 'send_to_client' },
        redaction_version: 'capture-session-v1',
        occurred_at: '2026-05-21T12:01:30.000Z',
        received_at: '2026-05-21T12:01:31.000Z',
      },
    ]
    pool.captureArtifactRows = [
      {
        id: 'capture-artifact-1',
        capture_session_id: captureSessionId,
        kind: 'transcript',
        storage_key: 'co/capture/raw-transcript.txt',
        uri: 's3://private/raw-transcript.txt',
        content_type: 'text/plain',
        byte_size: '120',
        content_hash: 'sha256:test',
        duration_ms: 30000,
        pii_level: 'private',
        access_policy: 'support_only',
        redaction_version: 'capture-session-v1',
        metadata: { analyzer: 'voice-to-log' },
        created_at: '2026-05-21T12:02:00.000Z',
        retention_expires_at: '2026-06-20T12:00:00.000Z',
        deleted_at: null,
      },
    ]

    const context = await buildSupportServerContext({
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' },
      identity: { userId: 'creator-1', source: 'default' },
      tier: 'local',
      buildSha: 'test-build',
      client: {
        request_id: 'request-1',
        capture_session_id: captureSessionId,
        path: {
          route: '/financial/estimate-pushes/33333333-3333-4333-8333-333333333333',
          entity_type: 'estimate_push',
          entity_id: '33333333-3333-4333-8333-333333333333',
        },
      },
    })

    expect(context.work_items).toMatchObject([
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Estimate push failed',
        status: 'agent_running',
      },
    ])
    expect(context.work_item_events).toMatchObject([
      {
        event_type: 'agent.dispatch_requested',
        request_id: 'request-1',
      },
    ])
    expect(context.trace_ids).toContain('0123456789abcdef0123456789abcdef')
    expect(context.capture_session_id).toBe(captureSessionId)
    expect(context.capture_session).toMatchObject({
      summary: { id: captureSessionId, mode: 'feedback', status: 'stopped' },
      recent_events: [{ event_type: 'ui.click', event_class: 'dead_control' }],
      artifacts: [{ kind: 'transcript', content_type: 'text/plain', redaction_version: 'capture-session-v1' }],
    })
    expect(JSON.stringify(context.capture_session)).not.toContain('storage_key')
    expect(JSON.stringify(context.capture_session)).not.toContain('s3://private')
  })
})

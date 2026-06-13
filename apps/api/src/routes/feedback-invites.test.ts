import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import { captureConsentAllowsArtifactKind } from '../capture-consent-policy.js'
import { attachMutationTx } from '../mutation-tx.js'
import {
  feedbackInviteCaptureMetadata,
  handleFeedbackInviteRoutes,
  type FeedbackInviteRouteCtx,
} from './feedback-invites.js'
import { __portalActorWorkItemBindingForTests } from './portal-capture-sessions.js'

type Response = { status: number; body: unknown }

class FakePool {
  queries: Array<{ sql: string; params: unknown[] }> = []
  invites: Array<Record<string, unknown>> = []
  captureSessions: Array<Record<string, unknown>> = []
  captureEvents: Array<Record<string, unknown>> = []
  captureArtifacts: Array<Record<string, unknown>> = []
  supportPackets: Array<Record<string, unknown>> = []
  workItems: Array<Record<string, unknown>> = []
  handoffEvents: Array<Record<string, unknown>> = []
  auditRows: unknown[][] = []
  admin = true

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as never,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('select cm.clerk_user_id')) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from company_memberships')) {
      return { rows: this.admin ? [{ role: 'admin' }] : [], rowCount: this.admin ? 1 : 0 }
    }
    if (normalized.includes('from companies') && normalized.includes('where id = $1')) {
      return { rows: [{ id: params[0], slug: 'la-ops', name: 'LA Ops' }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into feedback_invites')) {
      const row = {
        id: '00000000-0000-4000-8000-000000000501',
        company_id: params[0],
        token_id: params[1],
        token_kid: params[2],
        reviewer_ref: params[3],
        source: params[4],
        target_route: params[5],
        allowed_capture_modes: params[6],
        expires_at: '2026-06-18T12:00:00.000Z',
        revoked_at: null,
        created_by_user_id: params[8],
        created_at: '2026-06-04T12:00:00.000Z',
        last_used_at: null,
        last_accessed_at: null,
        access_count: 0,
        metadata: JSON.parse(String(params[9] ?? '{}')) as Record<string, unknown>,
      }
      this.invites.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('select id, company_id') && normalized.includes('from feedback_invites')) {
      return { rows: this.invites, rowCount: this.invites.length }
    }
    if (normalized.includes('from feedback_invites fi') && normalized.includes('join companies c')) {
      const row = this.invites.find((invite) => invite.token_id === params[0] && invite.token_kid === params[1])
      return {
        rows: row ? [{ ...row, company_slug: 'la-ops', company_name: 'LA Ops' }] : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (normalized.startsWith('update feedback_invites set last_used_at')) {
      // Access-audit bump: `set last_used_at = now(), last_accessed_at = now(),
      // access_count = access_count + 1 where company_id = $1 and id = $2`.
      const row = this.invites.find((invite) => invite.company_id === params[0] && invite.id === params[1])
      if (row) {
        row.last_used_at = '2026-06-04T12:05:00.000Z'
        row.last_accessed_at = '2026-06-04T12:05:00.000Z'
        row.access_count = (Number(row.access_count) || 0) + 1
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('update feedback_invites') && normalized.includes('set revoked_at')) {
      const row = this.invites.find((invite) => invite.company_id === params[0] && invite.id === params[1])
      if (row) row.revoked_at = '2026-06-04T12:10:00.000Z'
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('insert into capture_sessions')) {
      const [
        id,
        companyId,
        mode,
        routePath,
        deviceKind,
        platform,
        viewport,
        appBuildSha,
        consentVersion,
        actorRef,
        authority,
        consentScope,
        consentedAt,
        metadata,
        retentionExpiresAt,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ]
      const row = {
        id,
        company_id: companyId,
        actor_user_id: null,
        mode,
        status: 'open',
        route_path: routePath,
        device_kind: deviceKind,
        platform,
        viewport,
        app_build_sha: appBuildSha,
        consent_version: consentVersion,
        consent_actor_kind: 'portal_guest',
        consent_actor_ref: actorRef,
        consent_authority: authority,
        consent_scope: JSON.parse(consentScope),
        consented_at: consentedAt,
        redaction_version: 'capture-session-v1',
        metadata: JSON.parse(metadata),
        started_at: '2026-06-04T12:05:00.000Z',
        last_seen_at: '2026-06-04T12:05:00.000Z',
        stopped_at: null,
        discarded_at: null,
        retention_expires_at: retentionExpiresAt,
      }
      this.captureSessions.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('select id from context_work_items') && normalized.includes("metadata ->> 'source'")) {
      const [companyId, captureSessionId] = params as [string, string]
      const row = this.workItems.find(
        (item) =>
          item.company_id === companyId &&
          item.capture_session_id === captureSessionId &&
          (item.metadata as Record<string, unknown>).source === 'capture_session_finalize',
      )
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('select * from capture_sessions')) {
      const [companyId, captureSessionId, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (session) =>
          session.company_id === companyId &&
          session.id === captureSessionId &&
          session.consent_actor_kind === 'portal_guest' &&
          session.consent_actor_ref === actorRef,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from capture_session_events') && normalized.includes('count(*)::text')) {
      const [companyId, captureSessionId] = params as [string, string]
      const count = this.captureEvents.filter(
        (event) => event.company_id === companyId && event.capture_session_id === captureSessionId,
      ).length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into capture_session_events')) {
      const row = {
        id: `capture-event-${this.captureEvents.length + 1}`,
        company_id: params[0],
        capture_session_id: params[1],
        seq: params[2],
        client_event_id: params[3],
        event_type: params[4],
        event_class: params[5],
        route_path: params[6],
        workflow_id: params[7],
        entity_type: params[8],
        entity_id: params[9],
        request_id: params[10],
        payload: JSON.parse(String(params[11] ?? '{}')),
        occurred_at: params[12] ?? '2026-06-04T12:06:00.000Z',
      }
      this.captureEvents.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (normalized.includes('from capture_artifacts') && normalized.includes('private_artifact_count')) {
      const [companyId, captureSessionId] = params as [string, string]
      const rows = this.captureArtifacts.filter(
        (artifact) => artifact.company_id === companyId && artifact.capture_session_id === captureSessionId,
      )
      return {
        rows: [
          {
            artifact_count: String(rows.length),
            private_artifact_count: String(
              rows.filter((artifact) => artifact.pii_level === 'private' || artifact.pii_level === 'restricted')
                .length,
            ),
          },
        ],
        rowCount: 1,
      }
    }
    if (normalized.startsWith('select id::text, mode') && normalized.includes('from capture_sessions')) {
      const [companyId, captureSessionId] = params as [string, string]
      const row = this.captureSessions.find(
        (session) => session.company_id === companyId && session.id === captureSessionId,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from capture_session_events')) return { rows: [], rowCount: 0 }
    if (normalized.includes('from capture_artifacts')) return { rows: [], rowCount: 0 }
    if (normalized.includes('from audit_events')) return { rows: [], rowCount: 0 }
    if (normalized.includes('from workflow_event_log')) return { rows: [], rowCount: 0 }
    if (normalized.includes('from mutation_outbox') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (normalized.includes('from sync_events') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (normalized.includes('from mutation_outbox') || normalized.includes('from sync_events')) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('insert into support_debug_packets')) {
      const row = {
        id: `support-${this.supportPackets.length + 1}`,
        company_id: params[0],
        actor_user_id: params[1],
        request_id: params[2],
        route: params[3],
        capture_session_id: params[4],
        build_sha: params[5],
        problem: params[6],
        client: JSON.parse(String(params[7] ?? '{}')),
        server_context: JSON.parse(String(params[8] ?? '{}')),
        expires_at: params[9],
        redaction_version: params[10],
        created_at: '2026-06-04T12:06:00.000Z',
      }
      this.supportPackets.push(row)
      return { rows: [{ id: row.id, created_at: row.created_at, expires_at: row.expires_at }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into context_work_items')) {
      const row = {
        id: `work-item-${this.workItems.length + 1}`,
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
        metadata: JSON.parse(String(params[14] ?? '{}')),
        reversibility_window_seconds: params[15],
        created_at: '2026-06-04T12:06:00.000Z',
        updated_at: '2026-06-04T12:06:00.000Z',
        resolved_at: null,
        reversed_at: null,
        expires_at: null,
      }
      this.workItems.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('insert into context_handoff_events')) {
      const row = {
        id: `handoff-${this.handoffEvents.length + 1}`,
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
        causation_event_id: params[10],
        correlation_id: params[11],
        request_id: params[12],
        capture_session_id: params[13],
        sentry_trace: params[14],
        sentry_baggage: params[15],
        build_sha: params[16],
        redaction_version: params[17],
        occurred_at: '2026-06-04T12:06:00.000Z',
        recorded_at: '2026-06-04T12:06:00.000Z',
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('left join support_debug_packets')) {
      const [companyId, workItemId] = params as [string, string]
      const item = this.workItems.find((workItem) => workItem.company_id === companyId && workItem.id === workItemId)
      if (!item) return { rows: [], rowCount: 0 }
      const packet = this.supportPackets.find(
        (supportPacket) => supportPacket.company_id === companyId && supportPacket.id === item.support_packet_id,
      )
      return {
        rows: [
          {
            ...item,
            support_packet: packet
              ? {
                  id: packet.id,
                  route: packet.route,
                  problem: packet.problem,
                  request_id: packet.request_id,
                  capture_session_id: packet.capture_session_id,
                  build_sha: packet.build_sha,
                  created_at: packet.created_at,
                  expires_at: packet.expires_at,
                  redaction_version: packet.redaction_version,
                }
              : null,
          },
        ],
        rowCount: 1,
      }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: String(this.handoffEvents.length) }], rowCount: 1 }
    }
    if (normalized.includes('from context_handoff_events')) return { rows: this.handoffEvents, rowCount: this.handoffEvents.length }
    if (normalized.startsWith('update capture_sessions set status = case')) {
      const [captureSessionId, companyId, metadataRaw, actorRef] = params as [string, string, string, string]
      const row = this.captureSessions.find(
        (session) =>
          session.id === captureSessionId && session.company_id === companyId && session.consent_actor_ref === actorRef,
      )
      if (!row) return { rows: [], rowCount: 0 }
      if (row.status === 'open') {
        row.status = 'stopped'
        row.stopped_at = '2026-06-04T12:06:00.000Z'
      }
      row.last_seen_at = '2026-06-04T12:06:00.000Z'
      row.metadata = { ...(row.metadata as Record<string, unknown>), ...JSON.parse(metadataRaw) }
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('insert into audit_events')) {
      this.auditRows.push(params)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method, headers: {} } as http.IncomingMessage
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(pool: FakePool, body: Record<string, unknown> = {}) {
  pool.attach()
  const responses: Response[] = []
  const ctx: FeedbackInviteRouteCtx = {
    pool: pool as never,
    userId: 'admin-1',
    identitySource: 'clerk',
    isAnonymous: false,
    feedbackInviteSecret: 'feedback-secret',
    portalBaseUrl: 'https://sitelayer.example',
    sendJson: (status, responseBody) => responses.push({ status, body: responseBody }),
    readBody: async () => body,
  }
  return { ctx, responses }
}

describe('handleFeedbackInviteRoutes', () => {
  it('allowlists onsite correlation metadata for portal capture actors', () => {
    const metadata = feedbackInviteCaptureMetadata({
      id: 'invite-1',
      reviewer_ref: 'onsite-worker',
      source: 'mobile_ops_leavebehind',
      target_route: '/ops',
      allowed_capture_modes: ['text', 'state', 'screen'],
      metadata: {
        created_from: 'mobile_ops',
        company_slug: 'la-ops',
        ops_diagnostic_session_id: 'diag-session-9',
        ops_diagnostic_control_level: 'route',
        ops_diagnostic_state: 'active',
        control_token: 'do-not-copy',
        arbitrary_note: 'do-not-route',
      },
    })

    expect(metadata).toMatchObject({
      feedback_invite_id: 'invite-1',
      reviewer_ref: 'onsite-worker',
      source: 'mobile_ops_leavebehind',
      target_route: '/ops',
      allowed_capture_modes: ['text', 'state', 'screen'],
      created_from: 'mobile_ops',
      company_slug: 'la-ops',
      ops_diagnostic_session_id: 'diag-session-9',
      ops_diagnostic_control_level: 'route',
      ops_diagnostic_state: 'active',
    })
    expect(metadata).not.toHaveProperty('control_token')
    expect(metadata).not.toHaveProperty('arbitrary_note')
  })

  it('binds leave-behind feedback work items back to the onsite diagnostic session', () => {
    expect(
      __portalActorWorkItemBindingForTests({
        companyId: 'company-1',
        actorRef: 'invite-1',
        authority: 'signed_feedback_invite_token',
        surface: 'feedback_invite',
        metadata: {
          ops_diagnostic_session_id: 'diag-session-9',
          source: 'mobile_ops_leavebehind',
        },
      }),
    ).toEqual({
      entityType: 'ops_diagnostic_session',
      entityId: 'diag-session-9',
    })

    expect(
      __portalActorWorkItemBindingForTests({
        companyId: 'company-1',
        actorRef: 'invite-2',
        authority: 'signed_feedback_invite_token',
        surface: 'feedback_invite',
        metadata: { source: 'manual' },
      }),
    ).toEqual({})
  })

  it('finalizes leave-behind feedback captures as app issues linked to the onsite session', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, {
      reviewer_ref: 'onsite-worker',
      source: 'mobile_ops_leavebehind',
      target_route: '/ops',
      allowed_capture_modes: ['text', 'state'],
      metadata: {
        created_from: 'mobile_ops',
        company_slug: 'la-ops',
        ops_diagnostic_session_id: 'diag-session-9',
        ops_diagnostic_control_level: 'route',
        ops_diagnostic_state: 'active',
      },
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites'),
      create.ctx,
    )
    const token = (create.responses[0]?.body as { token: string }).token
    const captureSessionId = '99999999-9999-4999-8999-999999999999'

    const start = makeCtx(pool, {
      token,
      capture_session_id: captureSessionId,
      mode: 'feedback',
      consent_version: 'feedback-invite-v1',
      route_path: '/ops',
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/portal/feedback-invites/capture-sessions'),
      start.ctx,
    )

    const finalize = makeCtx(pool, {
      token,
      title: 'The onsite workflow stalled',
      summary: 'The worker submitted a follow-up through the leave-behind link.',
      severity: 'normal',
      category: 'feedback_invite',
      client_request_id: `feedback_invite:00000000-0000-4000-8000-000000000501:${captureSessionId}`,
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl(`/api/portal/feedback-invites/capture-sessions/${captureSessionId}/finalize`),
      finalize.ctx,
    )

    expect(finalize.responses[0]).toMatchObject({
      status: 201,
      body: {
        work_item: {
          domain: 'app_issue',
          capture_session_id: captureSessionId,
          entity_type: 'ops_diagnostic_session',
          entity_id: 'diag-session-9',
        },
        support_packet: { id: 'support-1' },
      },
    })
    expect(pool.workItems[0]).toMatchObject({
      domain: 'app_issue',
      capture_session_id: captureSessionId,
      entity_type: 'ops_diagnostic_session',
      entity_id: 'diag-session-9',
      metadata: {
        source: 'capture_session_finalize',
        ops_diagnostic_session_id: '[redacted]',
        portal_actor_source: 'mobile_ops_leavebehind',
      },
    })
    expect(pool.handoffEvents[0]).toMatchObject({
      payload: {
        entity_type: 'ops_diagnostic_session',
        entity_id: 'diag-session-9',
      },
    })
  })

  it('enforces feedback invite capture modes on portal capture sessions', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, {
      reviewer_ref: 'onsite-worker',
      source: 'mobile_ops_leavebehind',
      target_route: '/ops',
      allowed_capture_modes: ['text', 'state'],
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites'),
      create.ctx,
    )
    const token = (create.responses[0]?.body as { token: string }).token

    const start = makeCtx(pool, {
      token,
      capture_session_id: '99999999-9999-4999-8999-999999999999',
      mode: 'feedback',
      consent_version: 'feedback-invite-v1',
      route_path: '/ops',
      consent_scope: {
        streams: ['audio', 'screen_video', 'registered_artifacts', 'text_note'],
        artifacts: { audio: true, video: true, state_snapshot: true, text_note: true },
        event_classes: ['feedback_invite'],
        audio: true,
        screen_video: true,
        text_note: true,
        registered_artifacts: true,
      },
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/portal/feedback-invites/capture-sessions'),
      start.ctx,
    )

    expect(start.responses[0]?.status).toBe(200)
    expect(pool.captureSessions).toHaveLength(1)
    const consentScope = pool.captureSessions[0]?.consent_scope as Record<string, unknown>
    expect(consentScope).toMatchObject({
      allowed_capture_modes: ['text', 'state'],
      streams: ['text_note', 'registered_artifacts'],
      artifacts: {
        audio: false,
        transcript: false,
        text_note: true,
        video: false,
        video_clip_manifest: false,
        state_snapshot: true,
        screen_context: true,
      },
      event_classes: ['feedback_invite'],
      audio: false,
      screen_video: false,
      text_note: true,
      registered_artifacts: true,
    })
    expect(captureConsentAllowsArtifactKind(consentScope, 'audio')).toBe(false)
    expect(captureConsentAllowsArtifactKind(consentScope, 'video')).toBe(false)
    expect(captureConsentAllowsArtifactKind(consentScope, 'state_snapshot')).toBe(true)

    const denied = makeCtx(pool, {
      token,
      capture_session_id: '99999999-9999-4999-8999-999999999998',
      mode: 'desktop',
      consent_version: 'feedback-invite-v1',
      route_path: '/ops',
    })
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/portal/feedback-invites/capture-sessions'),
      denied.ctx,
    )

    expect(denied.responses[0]).toEqual({
      status: 403,
      body: { error: 'feedback invite does not allow desktop capture sessions' },
    })
    expect(pool.captureSessions).toHaveLength(1)
  })

  it('ignores unrelated routes', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleFeedbackInviteRoutes(buildReq(), buildUrl('/api/work-requests'), ctx)

    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
    expect(pool.queries).toHaveLength(0)
  })

  it('requires signing config before creating or resolving invites', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    ctx.feedbackInviteSecret = null

    await handleFeedbackInviteRoutes(buildReq('POST'), buildUrl('/api/portal/feedback-invites/resolve'), ctx)

    expect(responses[0]).toEqual({ status: 503, body: { error: 'feedback invite signing is not configured' } })
  })

  it('requires a token before feedback capture session routes run', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      capture_session_id: '99999999-9999-4999-8999-999999999999',
      mode: 'feedback',
      consent_version: 'feedback-invite-v1',
    })

    await handleFeedbackInviteRoutes(buildReq('POST'), buildUrl('/api/portal/feedback-invites/capture-sessions'), ctx)

    expect(responses[0]).toEqual({ status: 401, body: { error: 'feedback invite token is required' } })
    expect(pool.queries).toHaveLength(0)
  })

  it('requires a token header before feedback invite multipart artifact uploads run', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/portal/feedback-invites/capture-sessions/99999999-9999-4999-8999-999999999999/artifacts/upload'),
      ctx,
    )

    expect(responses[0]).toEqual({ status: 401, body: { error: 'feedback invite token is required' } })
    expect(pool.queries).toHaveLength(0)
  })

  it('creates a one-time visible token and resolves it publicly without leaking token internals', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, {
      reviewer_ref: 'steve',
      source: 'discord',
      target_route: '/takeoff/demo',
      allowed_capture_modes: ['text', 'audio', 'state'],
      metadata: { cohort: 'pilot' },
    })

    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites'),
      create.ctx,
    )

    expect(create.responses[0]?.status).toBe(201)
    const createBody = create.responses[0]?.body as {
      invite: Record<string, unknown>
      token: string
      invite_url: string
    }
    expect(createBody.token).toMatch(/^fbiv1\.default\./)
    expect(createBody.invite_url).toContain('/feedback?token=')
    expect(createBody.invite).not.toHaveProperty('token_id')
    expect(createBody.invite).not.toHaveProperty('token_kid')
    expect(createBody.invite.allowed_capture_modes).toEqual(['text', 'audio', 'state'])
    expect(pool.auditRows).toHaveLength(1)

    const resolve = makeCtx(pool, { token: createBody.token })
    await handleFeedbackInviteRoutes(buildReq('POST'), buildUrl('/api/portal/feedback-invites/resolve'), resolve.ctx)

    expect(resolve.responses[0]?.status).toBe(200)
    expect(resolve.responses[0]?.body).toMatchObject({
      invite: {
        id: '00000000-0000-4000-8000-000000000501',
        company_slug: 'la-ops',
        company_name: 'LA Ops',
        reviewer_ref: 'steve',
        allowed_capture_modes: ['text', 'audio', 'state'],
      },
    })
    expect((resolve.responses[0]?.body as { invite: Record<string, unknown> }).invite).not.toHaveProperty('token_id')
    expect(pool.invites[0]?.last_used_at).toBe('2026-06-04T12:05:00.000Z')
  })

  it('lists and revokes admin invites without returning the signed token', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, {})
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl('/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites'),
      create.ctx,
    )
    const token = (create.responses[0]?.body as { token: string }).token

    const list = makeCtx(pool)
    await handleFeedbackInviteRoutes(
      buildReq('GET'),
      buildUrl('/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites'),
      list.ctx,
    )

    expect(list.responses[0]?.status).toBe(200)
    const listBody = list.responses[0]?.body as { invites: Array<Record<string, unknown>> }
    expect(listBody.invites[0]).not.toHaveProperty('token_id')
    expect(listBody.invites[0]).not.toHaveProperty('token_kid')

    const revoke = makeCtx(pool)
    await handleFeedbackInviteRoutes(
      buildReq('POST'),
      buildUrl(
        '/api/companies/11111111-1111-4111-8111-111111111111/feedback-invites/00000000-0000-4000-8000-000000000501/revoke',
      ),
      revoke.ctx,
    )

    expect(revoke.responses[0]?.status).toBe(200)
    expect(revoke.responses[0]?.body).toMatchObject({
      invite: { id: '00000000-0000-4000-8000-000000000501', revoked_at: '2026-06-04T12:10:00.000Z' },
    })

    const resolve = makeCtx(pool, { token })
    await handleFeedbackInviteRoutes(buildReq('POST'), buildUrl('/api/portal/feedback-invites/resolve'), resolve.ctx)

    expect(resolve.responses[0]).toEqual({ status: 410, body: { error: 'feedback invite revoked' } })
  })
})

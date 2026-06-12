import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import type { BlueprintStorage } from '../storage.js'
import { handleAdminWorkRequestRoutes } from './admin-work-requests.js'
import { handleAgentFeedRoutes, type AgentFeedRouteDeps } from './agent-feed.js'
import { handleIssueRoutes, type IssueRouteCtx } from './issues.js'

/**
 * The FULL agent-feed return-leg loop, end to end across the three surfaces:
 *
 *   1. operator dispatch  POST /api/admin/work-requests/:id/dispatch-to-agent
 *        -> concern pending + agent.dispatch_requested (status unchanged)
 *   2. executor claim     POST /api/agent-feed/callbacks {status: accepted}
 *        -> concern claimed + agent.dispatch_acknowledged + agent_running
 *   3. terminal Callback  POST /api/agent-feed/callbacks {status: succeeded}
 *        -> concern succeeded + agent.completed + review_ready
 *   4. human resolve      POST /api/issues/:id/events {action: resolve}
 *        -> resolution.accepted + resolved (the doc-promised "human accepts
 *           to resolve" leg — agents can only ever reach review_ready)
 *
 * One shared in-memory store plays Postgres for all three route modules so
 * the loop exercises the REAL handler SQL shapes against one work item.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ITEM_ID = '00000000-0000-4000-9000-000000000001'
const SUPPORT_PACKET_ID = '00000000-0000-4000-8000-000000000301'
const CONCERN_REF = `wi:${WORK_ITEM_ID}:steve`
const TOKENS_ENV = JSON.stringify({ steve: 'tok-steve' })

type JsonRecord = Record<string, unknown>

class LoopPool {
  workItem: JsonRecord = {
    id: WORK_ITEM_ID,
    company_id: COMPANY_ID,
    support_packet_id: SUPPORT_PACKET_ID,
    domain: 'app_issue',
    title: 'Verify scale button failed',
    summary: 'The recorded user could not verify scale.',
    status: 'new',
    lane: 'triage',
    severity: 'high',
    route: '/desktop/takeoff',
    capture_session_id: null,
    entity_type: null,
    entity_id: null,
    assignee_user_id: null,
    created_by_user_id: 'user-1',
    created_at: '2026-06-09T11:00:00.000Z',
    updated_at: '2026-06-09T11:00:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: null,
    metadata: {},
    dedup_key: null,
  }
  supportPacket: JsonRecord = {
    id: SUPPORT_PACKET_ID,
    company_id: COMPANY_ID,
    actor_user_id: 'user-1',
    request_id: 'req-1',
    route: '/desktop/takeoff',
    capture_session_id: null,
    build_sha: 'build-test',
    problem: 'The recorded user could not verify scale.',
    client: {},
    server_context: { request_ids: ['req-1'], trace_ids: [] },
    created_at: '2026-06-09T10:00:00.000Z',
    expires_at: null,
    redaction_version: 'support-packet-v1',
  }
  concerns: JsonRecord[] = []
  handoffEvents: JsonRecord[] = []

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

  eventTypes(): string[] {
    return this.handoffEvents.map((e) => e.event_type as string)
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
    if (normalized.includes('from platform_admins')) {
      const ok = params[0] === 'admin-1'
      return { rows: ok ? [{ '?column?': 1 }] : [], rowCount: ok ? 1 : 0 }
    }

    // --- context_work_items -------------------------------------------------
    if (normalized.startsWith('select status, lane from context_work_items')) {
      return params[1] === this.workItem.id
        ? { rows: [{ status: this.workItem.status, lane: this.workItem.lane }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('select status from context_work_items')) {
      return params[1] === this.workItem.id
        ? { rows: [{ status: this.workItem.status }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (
      normalized.startsWith('select id, company_id, support_packet_id, domain') &&
      normalized.includes('for update')
    ) {
      return params[1] === this.workItem.id ? { rows: [{ ...this.workItem }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('left join support_debug_packets')) {
      // getContextWorkItemWithEvents (issues triage domain check).
      return params[1] === this.workItem.id
        ? { rows: [{ ...this.workItem, support_packet: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('w.id = $1::uuid')) {
      // Admin dispatch work-item read.
      return params[0] === this.workItem.id ? { rows: [{ ...this.workItem }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('update context_work_items') && normalized.includes('set status = $3')) {
      if (params[1] !== this.workItem.id) return { rows: [], rowCount: 0 }
      this.workItem.status = params[2]
      this.workItem.lane = params[3]
      this.workItem.assignee_user_id = params[4] ?? null
      this.workItem.resolved_at = params[5] ?? null
      this.workItem.reversed_at = params[6] ?? null
      this.workItem.updated_at = '2026-06-09T12:30:00.000Z'
      return { rows: [{ ...this.workItem }], rowCount: 1 }
    }

    // --- support_debug_packets ----------------------------------------------
    if (normalized.includes('from support_debug_packets')) {
      const ok = params[0] === COMPANY_ID && params[1] === SUPPORT_PACKET_ID
      return { rows: ok ? [{ ...this.supportPacket }] : [], rowCount: ok ? 1 : 0 }
    }

    // --- agent_feed_concerns ------------------------------------------------
    if (normalized.startsWith('insert into agent_feed_concerns')) {
      const [companyId, audience, projectKey, concernRef, concernRaw, workItemId, captureSessionId] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
      ]
      const existing = this.concerns.find((r) => r.project_key === projectKey && r.concern_ref === concernRef)
      if (existing) return { rows: [], rowCount: 0 }
      const row = {
        id: `00000000-0000-4000-c000-${String(this.concerns.length + 1).padStart(12, '0')}`,
        company_id: companyId,
        audience,
        project_key: projectKey,
        concern_ref: concernRef,
        concern: JSON.parse(concernRaw) as JsonRecord,
        status: 'pending',
        callback: null,
        work_item_id: workItemId,
        capture_session_id: captureSessionId,
        claimed_at: null,
        completed_at: null,
        created_at: '2026-06-09T12:00:00.000Z',
        updated_at: '2026-06-09T12:00:00.000Z',
      }
      this.concerns.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (normalized.startsWith('update agent_feed_concerns') && normalized.includes("status = 'claimed'")) {
      const row = this.concerns.find((r) => r.id === params[0] && r.status === 'pending')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'claimed'
      row.claimed_at = '2026-06-09T12:01:00.000Z'
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (normalized.startsWith('update agent_feed_concerns') && normalized.includes('callback = $4::jsonb')) {
      const row = this.concerns.find((r) => r.id === params[0] && (r.status === 'pending' || r.status === 'claimed'))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = params[2]
      row.callback = JSON.parse(params[3] as string) as JsonRecord
      row.completed_at = (params[4] as string | null) ?? '2026-06-09T12:02:00.000Z'
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (normalized.includes('from agent_feed_concerns') && normalized.includes("project_key = 'sitelayer'")) {
      // Admin dispatch response read.
      const row = this.concerns.find((r) => r.company_id === params[0] && r.concern_ref === params[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('select id, company_id, audience, project_key, concern_ref, status')) {
      // Feed callback lookup by concern_ref.
      const row = this.concerns.find((r) => r.concern_ref === params[0])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    // --- context_handoff_events ---------------------------------------------
    if (normalized.startsWith('insert into context_handoff_events')) {
      const idempotencyKey = (params[9] as string | null) ?? null
      const existing = idempotencyKey
        ? this.handoffEvents.find((e) => e.company_id === params[0] && e.idempotency_key === idempotencyKey)
        : null
      if (existing) return { rows: [], rowCount: 0 }
      const row = {
        id: `00000000-0000-4000-a000-${String(this.handoffEvents.length + 1).padStart(12, '0')}`,
        company_id: params[0] as string,
        work_item_id: params[1] as string,
        event_type: params[2] as string,
        actor_kind: params[3] as string,
        actor_user_id: (params[4] as string | null) ?? null,
        actor_ref: (params[5] as string | null) ?? null,
        source_system: params[6] as string,
        payload: JSON.parse(params[7] as string) as JsonRecord,
        metadata: JSON.parse(params[8] as string) as JsonRecord,
        idempotency_key: idempotencyKey,
        capture_session_id: (params[13] as string | null) ?? null,
        redaction_version: params[17] as string,
        occurred_at: '2026-06-09T12:05:00.000Z',
        recorded_at: '2026-06-09T12:05:00.000Z',
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('idempotency_key = $2')) {
      const row = this.handoffEvents.find((e) => e.company_id === params[0] && e.idempotency_key === params[1])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('count(*)')) {
      const count = this.handoffEvents.filter((e) => e.work_item_id === params[1]).length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('order by recorded_at')) {
      const rows = this.handoffEvents.filter((e) => e.work_item_id === params[1])
      return { rows, rowCount: rows.length }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

const noopStorage = {
  backend: 'local-fs',
  bucket: null,
  put: async () => undefined,
  putStream: async () => undefined,
  get: async () => Buffer.alloc(0),
  copy: async () => undefined,
  deleteObject: async () => undefined,
  getDownloadUrl: async () => null,
} as unknown as BlueprintStorage

function feedDeps(pool: LoopPool, body: Record<string, unknown>) {
  const responses: Array<{ status: number; body: unknown }> = []
  const deps: AgentFeedRouteDeps = {
    pool: pool as unknown as Pool,
    storage: noopStorage,
    sendJson: (status, responseBody) => responses.push({ status, body: responseBody }),
    readBody: async () => body,
    sendFileContent: () => undefined,
    tokensEnv: TOKENS_ENV,
  }
  return { deps, responses }
}

function feedReq(): http.IncomingMessage {
  return { method: 'POST', headers: { authorization: 'Bearer tok-steve' } } as http.IncomingMessage
}

function issueCtx(pool: LoopPool, body: Record<string, unknown>) {
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' }
  const ctx: IssueRouteCtx = {
    pool: pool as unknown as Pool,
    company,
    identity: { userId: 'admin-1', source: 'clerk' } as Identity,
    buildSha: 'test-sha',
    requireCapability: async () => true,
    readBody: async () => body,
    sendJson: (status, responseBody) => responses.push({ status, body: responseBody }),
  }
  return { ctx, responses }
}

describe('agent-feed return leg — full loop', () => {
  it('dispatch -> claim (acknowledged, agent_running) -> terminal Callback (review_ready) -> human resolve', async () => {
    const pool = new LoopPool()
    pool.attach()
    const identity: Identity = { userId: 'admin-1', source: 'clerk' }

    // 1. Operator dispatches the work item to the 'steve' executor lane.
    const dispatch = { responses: [] as Array<{ status: number; body: unknown }> }
    await handleAdminWorkRequestRoutes(
      { method: 'POST' } as http.IncomingMessage,
      new URL(`http://localhost/api/admin/work-requests/${WORK_ITEM_ID}/dispatch-to-agent`),
      {
        pool: pool as unknown as Pool,
        identity,
        sendJson: (status, body) => dispatch.responses.push({ status, body }),
        readBody: async () => ({ audience: 'steve' }),
        envIds: new Set<string>(),
      },
    )
    expect(dispatch.responses[0]?.status).toBe(201)
    expect(pool.concerns[0]).toMatchObject({ concern_ref: CONCERN_REF, status: 'pending' })
    expect(pool.eventTypes()).toEqual(['agent.dispatch_requested'])
    // Dispatch alone does NOT move the item — the executor has not claimed it.
    expect(pool.workItem.status).toBe('new')

    // 2. The executor claims the concern: acknowledged + agent_running.
    const claim = feedDeps(pool, { schema_version: '1.4.0', concern_ref: CONCERN_REF, status: 'accepted' })
    await handleAgentFeedRoutes(feedReq(), new URL('http://localhost/api/agent-feed/callbacks'), claim.deps)
    expect(claim.responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('claimed')
    expect(pool.workItem.status).toBe('agent_running')
    expect(pool.workItem.lane).toBe('agent')
    expect(pool.eventTypes()).toEqual(['agent.dispatch_requested', 'agent.dispatch_acknowledged'])

    // 3. The executor reports a succeeded terminal Callback: review_ready.
    const terminal = feedDeps(pool, {
      schema_version: '1.4.0',
      concern_ref: CONCERN_REF,
      status: 'succeeded',
      completed_at: '2026-06-09T12:02:00.000Z',
      outputs: { stdout: 'Fixed the scale verification flow.' },
    })
    await handleAgentFeedRoutes(feedReq(), new URL('http://localhost/api/agent-feed/callbacks'), terminal.deps)
    expect(terminal.responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('succeeded')
    expect(pool.workItem.status).toBe('review_ready')
    expect(pool.workItem.lane).toBe('both')
    expect(pool.eventTypes()).toEqual(['agent.dispatch_requested', 'agent.dispatch_acknowledged', 'agent.completed'])

    // 4. A human accepts the agent output via the app_issue triage surface.
    const resolve = issueCtx(pool, { action: 'resolve', message: 'verified the fix' })
    await handleIssueRoutes(
      { method: 'POST', headers: {} } as http.IncomingMessage,
      new URL(`http://localhost/api/issues/${WORK_ITEM_ID}/events`),
      resolve.ctx,
    )
    expect(resolve.responses[0]?.status).toBe(201)
    const resolved = resolve.responses[0]?.body as { issue: JsonRecord; event: JsonRecord }
    expect(resolved.issue).toMatchObject({ status: 'resolved', lane: 'done' })
    expect(resolved.issue.resolved_at).not.toBeNull()
    expect(pool.workItem.status).toBe('resolved')
    expect(pool.eventTypes()).toEqual([
      'agent.dispatch_requested',
      'agent.dispatch_acknowledged',
      'agent.completed',
      'resolution.accepted',
    ])
  })
})

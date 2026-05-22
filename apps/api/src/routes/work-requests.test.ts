import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import { handleWorkRequestRoutes, type WorkRequestRouteCtx } from './work-requests.js'

type JsonRecord = Record<string, unknown>

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const TEST_MESH_DISPATCH_URL = 'https://mesh.example.test/api/orchestrate/tasks'
const ORIGINAL_MESH_DISPATCH_URL = process.env.MESH_WORK_REQUEST_DISPATCH_URL
const ORIGINAL_MESH_DISPATCH_TOKEN = process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
const ORIGINAL_MESH_API_URL = process.env.MESH_API_URL
const ORIGINAL_DISPATCH_MAX_PENDING = process.env.WORK_REQUEST_DISPATCH_MAX_PENDING
const ORIGINAL_DISPATCH_MAX_FAILED = process.env.WORK_REQUEST_DISPATCH_MAX_FAILED
const ORIGINAL_FETCH = globalThis.fetch

type SupportPacket = {
  id: string
  company_id: string
  actor_user_id: string
  request_id: string | null
  route: string | null
  build_sha: string | null
  problem: string | null
  client: JsonRecord
  server_context: JsonRecord
  created_at: string
  expires_at: string | null
  redaction_version: string
}

type WorkItem = {
  id: string
  company_id: string
  support_packet_id: string
  title: string
  summary: string | null
  status: string
  lane: string
  severity: string | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  reversed_at: string | null
  reversibility_window_seconds: number
  metadata: JsonRecord
  agent_callback_token_hash: string | null
  agent_callback_token_issued_at: string | null
}

function expiresAtFor(row: { created_at: string; reversibility_window_seconds: number }): string {
  return new Date(Date.parse(row.created_at) + row.reversibility_window_seconds * 1000).toISOString()
}

type HandoffEvent = {
  id: string
  company_id: string
  work_item_id: string
  event_type: string
  actor_kind: string
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  payload: JsonRecord
  metadata: JsonRecord
  idempotency_key: string | null
  causation_event_id: string | null
  correlation_id: string | null
  request_id: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  build_sha: string | null
  redaction_version: string
  occurred_at: string
  recorded_at: string
}

type MutationOutbox = {
  id: string
  company_id: string
  device_id: string
  actor_user_id: string | null
  entity_type: string
  entity_id: string
  mutation_type: string
  payload: JsonRecord
  idempotency_key: string
  status: string
  attempt_count: number
  next_attempt_at: string | null
  applied_at: string | null
  error: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
}

class FakePool {
  supportPackets: SupportPacket[] = []
  workItems: WorkItem[] = []
  handoffEvents: HandoffEvent[] = []
  mutationOutbox: MutationOutbox[] = []
  private supportPacketCounter = 0
  private workItemCounter = 0
  private eventCounter = 0
  private outboxCounter = 0

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

    if (normalized.startsWith('insert into support_debug_packets')) {
      this.supportPacketCounter += 1
      const row: SupportPacket = {
        id: uuid(100 + this.supportPacketCounter),
        company_id: params[0] as string,
        actor_user_id: params[1] as string,
        request_id: (params[2] as string | null) ?? null,
        route: (params[3] as string | null) ?? null,
        build_sha: (params[4] as string | null) ?? null,
        problem: (params[5] as string | null) ?? null,
        client: JSON.parse(params[6] as string) as JsonRecord,
        server_context: JSON.parse(params[7] as string) as JsonRecord,
        expires_at: (params[8] as string | null) ?? null,
        redaction_version: params[9] as string,
        created_at: '2026-05-21T12:00:00.000Z',
      }
      this.supportPackets.push(row)
      return { rows: [{ id: row.id, created_at: row.created_at, expires_at: row.expires_at }], rowCount: 1 }
    }

    if (normalized.startsWith('insert into context_work_items')) {
      this.workItemCounter += 1
      const createdAt = '2026-05-21T12:00:01.000Z'
      const reversibilityWindowSeconds =
        typeof params[13] === 'number' ? (params[13] as number) : params[13] != null ? Number(params[13]) : 86400
      const row: WorkItem = {
        id: uuid(200 + this.workItemCounter),
        company_id: params[0] as string,
        support_packet_id: params[1] as string,
        title: params[2] as string,
        summary: (params[3] as string | null) ?? null,
        status: params[4] as string,
        lane: params[5] as string,
        severity: (params[6] as string | null) ?? null,
        route: (params[7] as string | null) ?? null,
        entity_type: (params[8] as string | null) ?? null,
        entity_id: (params[9] as string | null) ?? null,
        assignee_user_id: (params[10] as string | null) ?? null,
        created_by_user_id: (params[11] as string | null) ?? null,
        metadata: JSON.parse(params[12] as string) as JsonRecord,
        reversibility_window_seconds: reversibilityWindowSeconds,
        created_at: createdAt,
        updated_at: createdAt,
        resolved_at: null,
        reversed_at: null,
        agent_callback_token_hash: null,
        agent_callback_token_issued_at: null,
      }
      this.workItems.push(row)
      return { rows: [{ ...row, expires_at: expiresAtFor(row) }], rowCount: 1 }
    }

    if (normalized.startsWith('insert into context_handoff_events')) {
      const idempotencyKey = (params[9] as string | null) ?? null
      if (idempotencyKey) {
        const existing = this.handoffEvents.find(
          (event) => event.company_id === params[0] && event.idempotency_key === idempotencyKey,
        )
        if (existing) return { rows: [], rowCount: 0 }
      }
      this.eventCounter += 1
      const row: HandoffEvent = {
        id: uuid(300 + this.eventCounter),
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
        causation_event_id: (params[10] as string | null) ?? null,
        correlation_id: (params[11] as string | null) ?? null,
        request_id: (params[12] as string | null) ?? null,
        sentry_trace: (params[13] as string | null) ?? null,
        sentry_baggage: (params[14] as string | null) ?? null,
        build_sha: (params[15] as string | null) ?? null,
        redaction_version: params[16] as string,
        occurred_at: '2026-05-21T12:00:02.000Z',
        recorded_at: '2026-05-21T12:00:02.000Z',
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('insert into mutation_outbox')) {
      const directDispatchInsert = normalized.includes("'context_work_item'")
      const idempotencyKey = (directDispatchInsert ? params[5] : params[7]) as string
      const existing = this.mutationOutbox.find(
        (row) => row.company_id === params[0] && row.idempotency_key === idempotencyKey,
      )
      if (existing && normalized.includes('do nothing')) return { rows: [], rowCount: 0 }
      this.outboxCounter += 1
      const next: MutationOutbox = {
        id: existing?.id ?? uuid(400 + this.outboxCounter),
        company_id: params[0] as string,
        device_id: directDispatchInsert ? 'server' : (params[1] as string),
        actor_user_id: directDispatchInsert
          ? ((params[1] as string | null) ?? null)
          : ((params[2] as string | null) ?? null),
        entity_type: directDispatchInsert ? 'context_work_item' : (params[3] as string),
        entity_id: directDispatchInsert ? (params[2] as string) : (params[4] as string),
        mutation_type: directDispatchInsert ? (params[3] as string) : (params[5] as string),
        payload: JSON.parse((directDispatchInsert ? params[4] : params[6]) as string) as JsonRecord,
        idempotency_key: idempotencyKey,
        status: 'pending',
        attempt_count: existing?.attempt_count ?? 0,
        next_attempt_at: existing?.next_attempt_at ?? '2026-05-21T12:00:04.000Z',
        applied_at: existing?.applied_at ?? null,
        error: existing?.error ?? null,
        sentry_trace: (directDispatchInsert ? params[6] : params[8]) as string | null,
        sentry_baggage: (directDispatchInsert ? params[7] : params[9]) as string | null,
        request_id: (directDispatchInsert ? params[8] : params[10]) as string | null,
      }
      if (existing) Object.assign(existing, next)
      else this.mutationOutbox.push(next)
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('update mutation_outbox') && normalized.includes("status in ('failed', 'dead')")) {
      const [companyId, idempotencyKey, mutationType, payload, actorUserId, sentryTrace, sentryBaggage, requestId] =
        params as [string, string, string, string, string | null, string | null, string | null, string | null]
      const row = this.mutationOutbox.find(
        (outbox) =>
          outbox.company_id === companyId &&
          outbox.idempotency_key === idempotencyKey &&
          outbox.mutation_type === mutationType &&
          (outbox.status === 'failed' || outbox.status === 'dead'),
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'pending'
      row.attempt_count = 0
      row.next_attempt_at = '2026-05-21T12:00:05.000Z'
      row.applied_at = null
      row.error = null
      row.payload = JSON.parse(payload) as JsonRecord
      row.actor_user_id = actorUserId
      row.sentry_trace = sentryTrace
      row.sentry_baggage = sentryBaggage
      row.request_id = requestId
      return { rows: [row], rowCount: 1 }
    }

    if (
      normalized.includes('from mutation_outbox') &&
      normalized.includes('pending_count') &&
      normalized.includes('failed_count')
    ) {
      const [companyId, mutationType] = params as [string, string]
      const pendingCount = this.mutationOutbox.filter(
        (outbox) =>
          outbox.company_id === companyId &&
          outbox.mutation_type === mutationType &&
          (outbox.status === 'pending' || outbox.status === 'processing'),
      ).length
      const failedCount = this.mutationOutbox.filter(
        (outbox) =>
          outbox.company_id === companyId &&
          outbox.mutation_type === mutationType &&
          (outbox.status === 'failed' || outbox.status === 'dead'),
      ).length
      return {
        rows: [
          {
            pending_count: pendingCount,
            failed_count: failedCount,
            oldest_pending_age_seconds: pendingCount > 0 ? 900 : null,
          },
        ],
        rowCount: 1,
      }
    }

    if (
      normalized.includes('from mutation_outbox') &&
      normalized.includes('idempotency_key') &&
      normalized.includes('mutation_type = $3')
    ) {
      const [companyId, idempotencyKey, mutationType] = params as [string, string, string]
      const row = this.mutationOutbox.find(
        (outbox) =>
          outbox.company_id === companyId &&
          outbox.idempotency_key === idempotencyKey &&
          outbox.mutation_type === mutationType,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.includes('from mutation_outbox') && normalized.includes('group by status')) {
      const [companyId, mutationType, statuses] = params as [string, string, string[]]
      const rows = statuses
        .map((status) => ({
          status,
          count: this.mutationOutbox.filter(
            (outbox) =>
              outbox.company_id === companyId && outbox.mutation_type === mutationType && outbox.status === status,
          ).length,
        }))
        .filter((row) => row.count > 0)
      return { rows, rowCount: rows.length }
    }

    if (normalized.includes('from mutation_outbox') && normalized.includes('oldest_pending_age_seconds')) {
      const [companyId, mutationType] = params as [string, string]
      const hasPending = this.mutationOutbox.some(
        (outbox) =>
          outbox.company_id === companyId &&
          outbox.mutation_type === mutationType &&
          (outbox.status === 'pending' || outbox.status === 'processing'),
      )
      return {
        rows: [{ oldest_pending_age_seconds: hasPending ? 900 : null }],
        rowCount: 1,
      }
    }

    if (
      normalized.includes('from context_handoff_events') &&
      normalized.includes('where company_id = $1 and idempotency_key = $2')
    ) {
      const [companyId, idempotencyKey] = params as [string, string]
      const row = this.handoffEvents.find(
        (event) => event.company_id === companyId && event.idempotency_key === idempotencyKey,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.includes('from context_work_items') && normalized.includes("metadata ->> 'client_request_id'")) {
      const [companyId, actorUserId, clientRequestId] = params as [string, string, string]
      const row = this.workItems.find(
        (item) =>
          item.company_id === companyId &&
          item.created_by_user_id === actorUserId &&
          item.metadata.client_request_id === clientRequestId,
      )
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.includes('from context_work_items') && normalized.includes('group by status')) {
      const [companyId, statuses] = params as [string, string[]]
      const rows = statuses
        .map((status) => ({
          status,
          count: this.workItems.filter((item) => item.company_id === companyId && item.status === status).length,
        }))
        .filter((row) => row.count > 0)
      return { rows, rowCount: rows.length }
    }

    if (normalized.includes('from context_work_items w left join')) {
      const [companyId, workItemId] = params as [string, string]
      const row = this.workItems.find((item) => item.company_id === companyId && item.id === workItemId)
      if (!row) return { rows: [], rowCount: 0 }
      const packet = this.supportPackets.find((support) => support.id === row.support_packet_id)
      return {
        rows: [
          {
            ...row,
            expires_at: expiresAtFor(row),
            support_packet: packet
              ? {
                  id: packet.id,
                  route: packet.route,
                  problem: packet.problem,
                  request_id: packet.request_id,
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

    if (
      normalized.startsWith('select count(*)') &&
      normalized.includes('from context_handoff_events') &&
      normalized.includes('work_item_id')
    ) {
      const [companyId, workItemId] = params as [string, string]
      const count = this.handoffEvents.filter(
        (event) => event.company_id === companyId && event.work_item_id === workItemId,
      ).length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }

    if (normalized.includes('from context_handoff_events') && normalized.includes('work_item_id')) {
      const [companyId, workItemId] = params as [string, string]
      const rows = this.handoffEvents.filter(
        (event) => event.company_id === companyId && event.work_item_id === workItemId,
      )
      const limit = typeof params[2] === 'number' ? params[2] : rows.length
      const offset = typeof params[3] === 'number' ? params[3] : 0
      return { rows: rows.slice(offset, offset + limit), rowCount: rows.length }
    }

    if (normalized.includes('from context_work_items') && normalized.includes('for update')) {
      const [companyId, workItemId] = params as [string, string]
      const row = this.workItems.find((item) => item.company_id === companyId && item.id === workItemId)
      return {
        rows: row ? [{ ...row, expires_at: expiresAtFor(row) }] : [],
        rowCount: row ? 1 : 0,
      }
    }

    if (normalized.startsWith('update context_work_items')) {
      if (normalized.includes('agent_callback_token_hash')) {
        const [companyId, workItemId, tokenHash] = params as [string, string, string]
        const row = this.workItems.find((item) => item.company_id === companyId && item.id === workItemId)
        if (!row) return { rows: [], rowCount: 0 }
        row.agent_callback_token_hash = tokenHash
        row.agent_callback_token_issued_at = '2026-05-21T12:00:04.000Z'
        row.updated_at = '2026-05-21T12:00:04.000Z'
        return { rows: [], rowCount: 1 }
      }
      const [companyId, workItemId, status, lane, assigneeUserId, resolvedAt, reversedAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
      const row = this.workItems.find((item) => item.company_id === companyId && item.id === workItemId)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.lane = lane
      row.assignee_user_id = assigneeUserId
      row.resolved_at = resolvedAt
      if (reversedAt !== undefined) row.reversed_at = reversedAt
      row.updated_at = '2026-05-21T12:00:03.000Z'
      return { rows: [{ ...row, expires_at: expiresAtFor(row) }], rowCount: 1 }
    }

    if (normalized.includes('select agent_callback_token_hash') && normalized.includes('from context_work_items')) {
      const [companyId, workItemId] = params as [string, string]
      const row = this.workItems.find((item) => item.company_id === companyId && item.id === workItemId)
      return {
        rows: row
          ? [
              {
                agent_callback_token_hash: row.agent_callback_token_hash,
                agent_callback_token_issued_at: row.agent_callback_token_issued_at,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
      }
    }

    if (normalized.includes('from context_work_items')) {
      const companyId = params[0] as string
      let rows = this.workItems.filter((item) => item.company_id === companyId)
      if (normalized.includes('created_by_user_id =') && normalized.includes('or assignee_user_id =')) {
        const visibleTo = params[1] as string | undefined
        if (visibleTo) {
          rows = rows.filter((item) => item.created_by_user_id === visibleTo || item.assignee_user_id === visibleTo)
        }
      } else if (normalized.includes('created_by_user_id =')) {
        const createdBy = params[1] as string | undefined
        if (createdBy) rows = rows.filter((item) => item.created_by_user_id === createdBy)
      }
      const enriched = rows.map((row) => ({ ...row, expires_at: expiresAtFor(row) }))
      return { rows: enriched, rowCount: enriched.length }
    }

    if (
      normalized.includes('from audit_events') ||
      normalized.includes('from mutation_outbox') ||
      normalized.includes('from sync_events') ||
      normalized.includes('from workflow_event_log')
    ) {
      if (normalized.includes('count(*)')) return { rows: [{ count: '0' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`
}

function buildReq(method = 'POST', headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, headers } as http.IncomingMessage
}

function buildUrl(path = '/api/work-requests'): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(
  pool: FakePool,
  body: unknown,
  role: CompanyRole = 'admin',
  userId = 'user-1',
): { ctx: WorkRequestRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = {
    id: role === 'member' ? COMPANY_ID : COMPANY_ID,
    slug: 'co',
    name: 'Co',
    created_at: '',
    role,
  }
  const identity: Identity = { userId, source: 'default' }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      identity,
      tier: 'local',
      buildSha: 'test-build',
      requireRole: (allowed) => {
        const ok = allowed.includes(role)
        if (!ok) responses.push({ status: 403, body: { error: 'forbidden' } })
        return ok
      },
      readBody: async () => body as Record<string, unknown>,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
    },
  }
}

const clientContext = {
  path: {
    route: '/projects/p-1/estimate-push/push-1',
    entity_type: 'estimate_push',
    entity_id: '33333333-3333-4333-8333-333333333333',
  },
  authorization: 'Bearer secret',
}

describe('handleWorkRequestRoutes', () => {
  beforeEach(() => {
    process.env.MESH_WORK_REQUEST_DISPATCH_URL = TEST_MESH_DISPATCH_URL
    delete process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
    delete process.env.MESH_API_URL
    delete process.env.WORK_REQUEST_DISPATCH_MAX_PENDING
    delete process.env.WORK_REQUEST_DISPATCH_MAX_FAILED
    globalThis.fetch = ORIGINAL_FETCH
  })

  afterEach(() => {
    if (ORIGINAL_MESH_DISPATCH_URL === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    else process.env.MESH_WORK_REQUEST_DISPATCH_URL = ORIGINAL_MESH_DISPATCH_URL
    if (ORIGINAL_MESH_DISPATCH_TOKEN === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
    else process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = ORIGINAL_MESH_DISPATCH_TOKEN
    if (ORIGINAL_MESH_API_URL === undefined) delete process.env.MESH_API_URL
    else process.env.MESH_API_URL = ORIGINAL_MESH_API_URL
    if (ORIGINAL_DISPATCH_MAX_PENDING === undefined) delete process.env.WORK_REQUEST_DISPATCH_MAX_PENDING
    else process.env.WORK_REQUEST_DISPATCH_MAX_PENDING = ORIGINAL_DISPATCH_MAX_PENDING
    if (ORIGINAL_DISPATCH_MAX_FAILED === undefined) delete process.env.WORK_REQUEST_DISPATCH_MAX_FAILED
    else process.env.WORK_REQUEST_DISPATCH_MAX_FAILED = ORIGINAL_DISPATCH_MAX_FAILED
    globalThis.fetch = ORIGINAL_FETCH
    vi.restoreAllMocks()
  })

  it('creates a support packet, work item, and first handoff event in one route call', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      title: 'Estimate push looks wrong',
      summary: 'The total changed after sync.',
      severity: 'high',
      lane: 'triage',
      category: 'bug',
      client: clientContext,
    })

    const handled = await handleWorkRequestRoutes(buildReq(), buildUrl(), ctx)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(201)
    expect(pool.supportPackets).toHaveLength(1)
    expect(pool.workItems).toHaveLength(1)
    expect(pool.handoffEvents).toHaveLength(1)
    expect(pool.supportPackets[0]?.client.authorization).toBe('[redacted]')
    expect(pool.workItems[0]).toMatchObject({
      title: 'Estimate push looks wrong',
      status: 'new',
      severity: 'high',
      entity_type: 'estimate_push',
    })
    expect(pool.handoffEvents[0]).toMatchObject({
      event_type: 'work_item.created',
      actor_kind: 'user',
      actor_user_id: 'user-1',
    })
  })

  it('replays create response for a repeated client request id', async () => {
    const pool = new FakePool()
    const body = {
      title: 'Retry-safe create',
      summary: 'The first response was lost.',
      client_request_id: 'client-create-1',
      client: clientContext,
    }
    const first = makeCtx(pool, body)
    await handleWorkRequestRoutes(buildReq(), buildUrl(), first.ctx)
    const second = makeCtx(pool, body)

    await handleWorkRequestRoutes(buildReq(), buildUrl(), second.ctx)

    expect(first.responses[0]?.status).toBe(201)
    expect(second.responses[0]?.status).toBe(200)
    expect(second.responses[0]?.body).toMatchObject({
      idempotent_replay: true,
      work_item: { id: pool.workItems[0]!.id },
    })
    expect(pool.supportPackets).toHaveLength(1)
    expect(pool.workItems).toHaveLength(1)
    expect(pool.handoffEvents).toHaveLength(1)
  })

  it('scopes create idempotency to the actor user', async () => {
    const pool = new FakePool()
    const body = {
      title: 'Per-user idempotency',
      client_request_id: 'same-client-id',
      client: clientContext,
    }
    await handleWorkRequestRoutes(buildReq(), buildUrl(), makeCtx(pool, body, 'admin', 'user-1').ctx)
    const secondUser = makeCtx(pool, body, 'admin', 'user-2')

    await handleWorkRequestRoutes(buildReq(), buildUrl(), secondUser.ctx)

    expect(secondUser.responses[0]?.status).toBe(201)
    expect(pool.workItems.map((item) => item.created_by_user_id)).toEqual(['user-1', 'user-2'])
  })

  it('lists member-visible work items as created or assigned rows', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Mine', client: clientContext }, 'member', 'member-1')
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    expect(pool.workItems.map((item) => item.created_by_user_id)).toEqual(['member-1'])
    pool.workItems.push({
      ...pool.workItems[0]!,
      id: uuid(999),
      created_by_user_id: 'other-user',
    })
    pool.workItems.push({
      ...pool.workItems[0]!,
      id: uuid(998),
      title: 'Assigned to me',
      created_by_user_id: 'other-user',
      assignee_user_id: 'member-1',
    })
    const listed = makeCtx(pool, {}, 'member', 'member-1')

    await handleWorkRequestRoutes(buildReq('GET'), buildUrl('/api/work-requests'), listed.ctx)

    expect(listed.responses[0]?.status).toBe(200)
    const body = listed.responses[0]?.body as { work_items: WorkItem[] }
    expect(body.work_items.map((item) => item.id)).toEqual([pool.workItems[0]!.id, uuid(998)])
  })

  it('appends a resolution event and updates status transactionally', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Resolve me', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    const append = makeCtx(pool, { event_type: 'resolution.accepted', message: 'Handled.' })

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/events`), append.ctx)

    expect(append.responses[0]?.status).toBe(201)
    expect(pool.workItems[0]).toMatchObject({ status: 'resolved', lane: 'done' })
    expect(pool.handoffEvents.map((event) => event.event_type)).toEqual(['work_item.created', 'resolution.accepted'])
  })

  it('rejects cross-role triage actions for members', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Needs assignment', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const append = makeCtx(pool, { event_type: 'human.assigned', assignee_user_id: 'member-2' }, 'member', 'member-1')

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${pool.workItems[0]!.id}/events`),
      append.ctx,
    )

    expect(append.responses[0]?.status).toBe(403)
    expect(pool.handoffEvents).toHaveLength(1)
  })

  it('rejects GitHub linking for members even when they can read the item', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Member item', client: clientContext }, 'member', 'member-1')
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const append = makeCtx(
      pool,
      { event_type: 'external.github_linked', url: 'https://github.com/GitSteveLozano/sitelayer/issues/1' },
      'member',
      'member-1',
    )

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${pool.workItems[0]!.id}/events`),
      append.ctx,
    )

    expect(append.responses[0]?.status).toBe(403)
    expect(pool.handoffEvents).toHaveLength(1)
  })

  it('dispatches a work request through mutation_outbox with a stable handoff event', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Agent task', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    const dispatch = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('POST', { host: 'sitelayer.test', 'x-forwarded-proto': 'https' }),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      dispatch.ctx,
    )

    expect(dispatch.responses[0]?.status).toBe(202)
    expect(dispatch.responses[0]?.body).toMatchObject({
      outbox: {
        status: 'pending',
        attempt_count: 0,
        idempotency_key: `context_work_item:dispatch_mesh:${workItemId}`,
      },
      dispatch_queued: true,
    })
    expect(pool.workItems[0]).toMatchObject({ status: 'agent_running', lane: 'agent' })
    expect(pool.mutationOutbox[0]).toMatchObject({
      entity_type: 'context_work_item',
      entity_id: workItemId,
      mutation_type: 'dispatch_mesh_work_request',
      idempotency_key: `context_work_item:dispatch_mesh:${workItemId}`,
    })
    expect((pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.token_type).toBe('scoped_bearer')
    expect((pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.path).toBe(
      `/api/work-requests/${workItemId}/agent-callback`,
    )
    expect((pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.url).toBe(
      `https://sitelayer.test/api/work-requests/${workItemId}/agent-callback`,
    )
    expect(typeof (pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.expires_at).toBe('string')
    expect(typeof (pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.token).toBe('string')
    expect(pool.workItems[0]?.agent_callback_token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(pool.handoffEvents.map((event) => event.event_type)).toContain('agent.dispatch_requested')
  })

  it('rejects Mesh dispatch when dispatch is not configured without mutating the work item', async () => {
    delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Unavailable dispatch', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    const dispatch = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      dispatch.ctx,
    )

    expect(dispatch.responses[0]).toEqual({ status: 503, body: { error: 'mesh dispatch is not configured' } })
    expect(pool.workItems[0]).toMatchObject({ status: 'new', lane: 'triage' })
    expect(pool.mutationOutbox).toHaveLength(0)
    expect(pool.handoffEvents.map((event) => event.event_type)).toEqual(['work_item.created'])
  })

  it('prefers configured public base when building callback URLs', async () => {
    const previous = process.env.SITELAYER_PUBLIC_BASE
    process.env.SITELAYER_PUBLIC_BASE = 'https://sitelayer.sandolab.xyz/'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Public callback', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItemId = pool.workItems[0]!.id

      await handleWorkRequestRoutes(
        buildReq('POST', { host: 'internal.local' }),
        buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
        makeCtx(pool, {}).ctx,
      )

      expect((pool.mutationOutbox[0]?.payload.callback as JsonRecord | undefined)?.url).toBe(
        `https://sitelayer.sandolab.xyz/api/work-requests/${workItemId}/agent-callback`,
      )
    } finally {
      if (previous === undefined) delete process.env.SITELAYER_PUBLIC_BASE
      else process.env.SITELAYER_PUBLIC_BASE = previous
    }
  })

  it('rejects new Mesh dispatch when the pending dispatch backlog is full', async () => {
    process.env.WORK_REQUEST_DISPATCH_MAX_PENDING = '1'
    const pool = new FakePool()
    await handleWorkRequestRoutes(
      buildReq(),
      buildUrl(),
      makeCtx(pool, { title: 'First task', client: clientContext }).ctx,
    )
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${pool.workItems[0]!.id}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    await handleWorkRequestRoutes(
      buildReq(),
      buildUrl(),
      makeCtx(pool, { title: 'Second task', client: { ...clientContext, request_id: 'second-request' } }).ctx,
    )
    const secondWorkItemId = pool.workItems[1]!.id
    const dispatch = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${secondWorkItemId}/dispatch/mesh`),
      dispatch.ctx,
    )

    expect(dispatch.responses[0]?.status).toBe(429)
    expect(dispatch.responses[0]?.body).toMatchObject({
      error: 'mesh dispatch backlog is full',
      dispatch_outbox: {
        pending_count: 1,
        pending_limit: 1,
      },
    })
    expect(pool.workItems[1]).toMatchObject({ status: 'new', lane: 'triage' })
    expect(pool.mutationOutbox).toHaveLength(1)
    expect(
      pool.handoffEvents.filter(
        (event) => event.work_item_id === secondWorkItemId && event.event_type === 'agent.dispatch_requested',
      ),
    ).toHaveLength(0)
  })

  it('does not reset dispatch outbox backoff when dispatch is repeated', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Repeated agent task', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    pool.mutationOutbox[0]!.attempt_count = 3
    pool.mutationOutbox[0]!.next_attempt_at = '2026-05-21T12:30:00.000Z'
    pool.mutationOutbox[0]!.error = 'mesh unavailable'
    const duplicate = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      duplicate.ctx,
    )

    expect(duplicate.responses[0]?.status).toBe(202)
    expect(duplicate.responses[0]?.body).toMatchObject({
      outbox: {
        status: 'pending',
        attempt_count: 3,
        next_attempt_at: '2026-05-21T12:30:00.000Z',
        error: 'mesh unavailable',
      },
      dispatch_queued: false,
    })
    expect(pool.mutationOutbox).toHaveLength(1)
    expect(pool.mutationOutbox[0]).toMatchObject({
      attempt_count: 3,
      next_attempt_at: '2026-05-21T12:30:00.000Z',
      error: 'mesh unavailable',
    })
    expect(pool.handoffEvents.filter((event) => event.event_type === 'agent.dispatch_requested')).toHaveLength(1)
  })

  it('retries a failed dispatch outbox row explicitly', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Retry failed dispatch', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    pool.mutationOutbox[0]!.status = 'failed'
    pool.mutationOutbox[0]!.attempt_count = 5
    pool.mutationOutbox[0]!.next_attempt_at = '2026-05-21T13:00:00.000Z'
    pool.mutationOutbox[0]!.error = 'mesh unavailable'
    const retry = makeCtx(pool, { reason: 'mesh recovered', idempotency_key: 'retry-1' })

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh/retry`),
      retry.ctx,
    )

    expect(retry.responses[0]?.status).toBe(202)
    expect(retry.responses[0]?.body).toMatchObject({
      outbox: {
        status: 'pending',
        attempt_count: 0,
        error: null,
      },
      dispatch_queued: true,
    })
    expect(pool.mutationOutbox).toHaveLength(1)
    expect(pool.mutationOutbox[0]).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      error: null,
    })
    expect(pool.workItems[0]).toMatchObject({ status: 'agent_running', lane: 'agent' })
    expect(pool.handoffEvents.map((event) => event.event_type)).toEqual([
      'work_item.created',
      'agent.dispatch_requested',
      'agent.dispatch_retried',
    ])
  })

  it('rejects Mesh dispatch retries when dispatch is not configured without resetting backoff', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Retry config missing', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    pool.mutationOutbox[0]!.status = 'failed'
    pool.mutationOutbox[0]!.attempt_count = 5
    pool.mutationOutbox[0]!.next_attempt_at = '2026-05-21T13:00:00.000Z'
    pool.mutationOutbox[0]!.error = 'mesh unavailable'
    delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
    const retry = makeCtx(pool, { idempotency_key: 'retry-no-config' })

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh/retry`),
      retry.ctx,
    )

    expect(retry.responses[0]).toEqual({ status: 503, body: { error: 'mesh dispatch is not configured' } })
    expect(pool.mutationOutbox[0]).toMatchObject({
      status: 'failed',
      attempt_count: 5,
      next_attempt_at: '2026-05-21T13:00:00.000Z',
      error: 'mesh unavailable',
    })
    expect(pool.handoffEvents.filter((event) => event.event_type === 'agent.dispatch_retried')).toHaveLength(0)
  })

  it('does not reset active dispatch rows through the retry endpoint', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Pending dispatch retry ignored', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    pool.mutationOutbox[0]!.attempt_count = 3
    pool.mutationOutbox[0]!.next_attempt_at = '2026-05-21T13:00:00.000Z'
    const retry = makeCtx(pool, { idempotency_key: 'retry-pending' })

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh/retry`),
      retry.ctx,
    )

    expect(retry.responses[0]?.status).toBe(202)
    expect(retry.responses[0]?.body).toMatchObject({
      outbox: {
        status: 'pending',
        attempt_count: 3,
        next_attempt_at: '2026-05-21T13:00:00.000Z',
      },
      dispatch_queued: false,
    })
    expect(pool.mutationOutbox[0]).toMatchObject({
      attempt_count: 3,
      next_attempt_at: '2026-05-21T13:00:00.000Z',
    })
    expect(pool.handoffEvents.filter((event) => event.event_type === 'agent.dispatch_retried')).toHaveLength(0)
  })

  it('shows dispatch outbox state on the work item detail response', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Detail queue state', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )
    pool.mutationOutbox[0]!.attempt_count = 2
    pool.mutationOutbox[0]!.status = 'failed'
    pool.mutationOutbox[0]!.error = 'mesh unavailable'
    const detail = makeCtx(pool, {})

    await handleWorkRequestRoutes(buildReq('GET'), buildUrl(`/api/work-requests/${workItemId}`), detail.ctx)

    expect(detail.responses[0]?.status).toBe(200)
    expect(detail.responses[0]?.body).toMatchObject({
      dispatch_outbox: {
        status: 'failed',
        attempt_count: 2,
        error: 'mesh unavailable',
      },
    })
  })

  it('paginates long work item timelines on detail responses', async () => {
    const pool = new FakePool()
    await handleWorkRequestRoutes(
      buildReq(),
      buildUrl(),
      makeCtx(pool, { title: 'Long timeline', client: clientContext }).ctx,
    )
    const workItemId = pool.workItems[0]!.id
    for (const key of ['a', 'b', 'c']) {
      await handleWorkRequestRoutes(
        buildReq('POST'),
        buildUrl(`/api/work-requests/${workItemId}/events`),
        makeCtx(pool, { event_type: 'message.added', message: `message ${key}`, idempotency_key: key }).ctx,
      )
    }
    const detail = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('GET'),
      buildUrl(`/api/work-requests/${workItemId}?limit=2&offset=1`),
      detail.ctx,
    )

    expect(detail.responses[0]?.status).toBe(200)
    expect(detail.responses[0]?.body).toMatchObject({
      events_pagination: {
        limit: 2,
        offset: 1,
        total: 4,
        has_more: true,
      },
    })
    const body = detail.responses[0]?.body as { events: HandoffEvent[] }
    expect(body.events.map((event) => event.payload.message)).toEqual(['message a', 'message b'])
  })

  it('reports work queue health counts for the inbox', async () => {
    const previousDispatchUrl = process.env.MESH_WORK_REQUEST_DISPATCH_URL
    const previousWebhookToken = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
    process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = 'callback-secret'
    const pool = new FakePool()
    try {
      await handleWorkRequestRoutes(
        buildReq(),
        buildUrl(),
        makeCtx(pool, { title: 'Running', client: clientContext }).ctx,
      )
      await handleWorkRequestRoutes(
        buildReq(),
        buildUrl(),
        makeCtx(pool, { title: 'Review', client: clientContext }).ctx,
      )
      pool.workItems[0]!.status = 'agent_running'
      pool.workItems[1]!.status = 'review_ready'
      await handleWorkRequestRoutes(
        buildReq('POST'),
        buildUrl(`/api/work-requests/${pool.workItems[0]!.id}/dispatch/mesh`),
        makeCtx(pool, {}).ctx,
      )
      pool.mutationOutbox[0]!.status = 'failed'
      delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
      const health = makeCtx(pool, {})

      await handleWorkRequestRoutes(buildReq('GET'), buildUrl('/api/work-requests/queue-health'), health.ctx)

      expect(health.responses[0]?.status).toBe(200)
      expect(health.responses[0]?.body).toMatchObject({
        config: {
          mesh_dispatch_configured: false,
          callback_configured: true,
          scoped_callbacks_enabled: true,
          callback_fallback_configured: true,
        },
        work_items: {
          agent_running: 1,
          review_ready: 1,
          review_stale: 0,
          proposal_expired: 0,
        },
        dispatch_outbox: {
          pending: 0,
          processing: 0,
          failed: 1,
          dead: 0,
          oldest_pending_age_seconds: null,
        },
      })
    } finally {
      if (previousDispatchUrl === undefined) delete process.env.MESH_WORK_REQUEST_DISPATCH_URL
      else process.env.MESH_WORK_REQUEST_DISPATCH_URL = previousDispatchUrl
      if (previousWebhookToken === undefined) delete process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
      else process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = previousWebhookToken
    }
  })

  it('keeps member users out of company-wide work queue health', async () => {
    const pool = new FakePool()
    const health = makeCtx(pool, {}, 'member')

    await handleWorkRequestRoutes(buildReq('GET'), buildUrl('/api/work-requests/queue-health'), health.ctx)

    expect(health.responses[0]).toEqual({ status: 403, body: { error: 'forbidden' } })
  })

  it('accepts agent callbacks and moves proposals to review', async () => {
    const previous = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
    process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = 'callback-secret'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Agent callback', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItemId = pool.workItems[0]!.id
      const callback = makeCtx(pool, {
        event_type: 'agent.proposal_ready',
        message: 'Patch ready for review.',
        agent_ref: 'mesh-agent-1',
        idempotency_key: 'agent-callback-1',
      })

      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: 'Bearer callback-secret' }),
        buildUrl(`/api/work-requests/${workItemId}/agent-callback`),
        callback.ctx,
      )

      expect(callback.responses[0]?.status).toBe(202)
      expect(pool.workItems[0]).toMatchObject({ status: 'review_ready', lane: 'both' })
      expect(pool.handoffEvents.at(-1)).toMatchObject({
        event_type: 'agent.proposal_ready',
        actor_kind: 'agent',
        actor_ref: 'mesh-agent-1',
      })
    } finally {
      if (previous === undefined) delete process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
      else process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = previous
    }
  })

  it('rejects agent callbacks that try to set reversed status', async () => {
    const previous = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
    process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = 'callback-secret'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Agent callback reversed bypass', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItemId = pool.workItems[0]!.id
      const callback = makeCtx(pool, {
        event_type: 'agent.proposal_ready',
        status: 'reversed',
        idempotency_key: 'agent-callback-reversed',
      })

      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: 'Bearer callback-secret' }),
        buildUrl(`/api/work-requests/${workItemId}/agent-callback`),
        callback.ctx,
      )

      expect(callback.responses[0]).toEqual({
        status: 400,
        body: { error: 'status reversed must use the reverse endpoint' },
      })
      expect(pool.workItems[0]?.status).toBe('new')
    } finally {
      if (previous === undefined) delete process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
      else process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = previous
    }
  })

  it('rejects agent callbacks after a work item has been reversed', async () => {
    const previous = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
    process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = 'callback-secret'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Reversed callback race', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItem = pool.workItems[0]!
      workItem.status = 'reversed'
      workItem.lane = 'done'
      workItem.reversed_at = new Date().toISOString()
      const callback = makeCtx(pool, { event_type: 'agent.proposal_ready', idempotency_key: 'callback-after-reverse' })

      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: 'Bearer callback-secret' }),
        buildUrl(`/api/work-requests/${workItem.id}/agent-callback`),
        callback.ctx,
      )

      expect(callback.responses[0]).toEqual({
        status: 409,
        body: { error: 'work item is reversed and cannot accept agent callbacks' },
      })
      expect(pool.workItems[0]).toMatchObject({ status: 'reversed', lane: 'done' })
    } finally {
      if (previous === undefined) delete process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
      else process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = previous
    }
  })

  it('requires the scoped dispatch callback token once one has been issued', async () => {
    const previous = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
    process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = 'global-callback-secret'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Scoped callback', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItemId = pool.workItems[0]!.id
      await handleWorkRequestRoutes(
        buildReq('POST'),
        buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
        makeCtx(pool, {}).ctx,
      )
      const callbackToken = (pool.mutationOutbox[0]!.payload.callback as JsonRecord).token as string
      const rejected = makeCtx(pool, { event_type: 'agent.proposal_ready', idempotency_key: 'scoped-callback-1' })

      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: 'Bearer global-callback-secret' }),
        buildUrl(`/api/work-requests/${workItemId}/agent-callback`),
        rejected.ctx,
      )

      expect(rejected.responses[0]?.status).toBe(401)
      const accepted = makeCtx(pool, { event_type: 'agent.proposal_ready', idempotency_key: 'scoped-callback-1' })
      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: `Bearer ${callbackToken}` }),
        buildUrl(`/api/work-requests/${workItemId}/agent-callback`),
        accepted.ctx,
      )

      expect(accepted.responses[0]?.status).toBe(202)
      expect(pool.workItems[0]).toMatchObject({ status: 'review_ready', lane: 'both' })
      expect(pool.handoffEvents.map((event) => event.event_type)).toContain('agent.proposal_ready')
    } finally {
      if (previous === undefined) delete process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
      else process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN = previous
    }
  })

  it('rejects expired scoped callback tokens', async () => {
    const previousTtl = process.env.WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS
    process.env.WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS = '1'
    try {
      const pool = new FakePool()
      const created = makeCtx(pool, { title: 'Expired callback', client: clientContext })
      await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
      const workItemId = pool.workItems[0]!.id
      await handleWorkRequestRoutes(
        buildReq('POST'),
        buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
        makeCtx(pool, {}).ctx,
      )
      const callbackToken = (pool.mutationOutbox[0]!.payload.callback as JsonRecord).token as string
      pool.workItems[0]!.agent_callback_token_issued_at = '2026-05-20T12:00:00.000Z'
      const callback = makeCtx(pool, { event_type: 'agent.proposal_ready', idempotency_key: 'expired-callback-1' })

      await handleWorkRequestRoutes(
        buildReq('POST', { authorization: `Bearer ${callbackToken}` }),
        buildUrl(`/api/work-requests/${workItemId}/agent-callback`),
        callback.ctx,
      )

      expect(callback.responses[0]).toEqual({ status: 410, body: { error: 'callback token expired' } })
      expect(pool.handoffEvents.map((event) => event.event_type)).not.toContain('agent.proposal_ready')
    } finally {
      if (previousTtl === undefined) delete process.env.WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS
      else process.env.WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS = previousTtl
    }
  })

  it('generates a redacted GitHub export without raw support packet JSON', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, {
      title: 'Export me',
      summary: 'Observed failure.',
      client: clientContext,
    })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    const github = makeCtx(pool, {})

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/github-export`),
      github.ctx,
    )

    expect(github.responses[0]?.status).toBe(200)
    const body = github.responses[0]?.body as { title: string; body: string; labels: string[] }
    expect(body.title).toBe('Export me')
    expect(body.body).toContain('Internal work item')
    expect(body.body).not.toContain('Bearer secret')
    expect(body.labels).toContain('context-handoff')
    expect(pool.handoffEvents.at(-1)).toMatchObject({
      event_type: 'external.github_export_prepared',
      actor_kind: 'user',
      actor_user_id: 'user-1',
    })
    expect(pool.handoffEvents.at(-1)?.payload).toMatchObject({
      labels: ['sitelayer', 'context-handoff'],
    })
    expect(pool.handoffEvents.at(-1)?.payload.body_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('populates reversibility_window_seconds from severity at creation time', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, {
      title: 'Urgent reversibility',
      severity: 'urgent',
      client: clientContext,
    })

    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)

    expect(create.responses[0]?.status).toBe(201)
    expect(pool.workItems[0]?.reversibility_window_seconds).toBe(3600)
    const body = create.responses[0]?.body as {
      work_item: { reversibility_window_seconds: number; expires_at: string }
    }
    expect(body.work_item.reversibility_window_seconds).toBe(3600)
    expect(typeof body.work_item.expires_at).toBe('string')
    // expires_at = created_at + 1h => 2026-05-21T13:00:01.000Z
    expect(body.work_item.expires_at).toBe('2026-05-21T13:00:01.000Z')
  })

  it('reverses a work item, records an event with previous status, and returns the updated row', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Reverse me', severity: 'normal', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItem = pool.workItems[0]!
    // Bump created_at to "now" so the 24h normal window has not expired
    workItem.created_at = new Date().toISOString()
    const workItemId = workItem.id
    const reverse = makeCtx(pool, { reason: 'wrong action, recall before agent runs' })

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/reverse`), reverse.ctx)

    expect(reverse.responses[0]?.status).toBe(200)
    const body = reverse.responses[0]?.body as {
      work_item: { status: string; lane: string; reversed_at: string | null }
      event: { event_type: string; payload: Record<string, unknown> }
    }
    expect(body.work_item.status).toBe('reversed')
    expect(body.work_item.lane).toBe('done')
    expect(typeof body.work_item.reversed_at).toBe('string')
    expect(body.event.event_type).toBe('work_item.reversed')
    expect(body.event.payload).toMatchObject({
      reason: 'wrong action, recall before agent runs',
      previous_status: 'new',
      previous_lane: 'triage',
    })
    expect(typeof (body.event.payload as { reversed_within_seconds?: unknown }).reversed_within_seconds).toBe('number')
    expect(pool.workItems[0]).toMatchObject({ status: 'reversed', lane: 'done' })
    expect(pool.workItems[0]?.reversed_at).not.toBeNull()
  })

  it('commits reversal before best-effort Mesh cancellation and records the cancel attempt', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = 'mesh-secret'
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 202 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Reverse dispatched task', severity: 'normal', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItem = pool.workItems[0]!
    workItem.created_at = new Date().toISOString()
    pool.handoffEvents.push({
      id: uuid(900),
      company_id: COMPANY_ID,
      work_item_id: workItem.id,
      event_type: 'agent.dispatch_acknowledged',
      actor_kind: 'system',
      actor_user_id: null,
      actor_ref: 'sitelayer-worker',
      source_system: 'mesh',
      payload: { mesh_task_id: 123 },
      metadata: {},
      idempotency_key: 'ack',
      causation_event_id: null,
      correlation_id: null,
      request_id: null,
      sentry_trace: null,
      sentry_baggage: null,
      build_sha: null,
      redaction_version: 'context-handoff-v1',
      occurred_at: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
    })

    const reverse = makeCtx(pool, { reason: 'recall delegated task' })
    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItem.id}/reverse`), reverse.ctx)

    expect(reverse.responses[0]?.status).toBe(200)
    expect(pool.workItems[0]).toMatchObject({ status: 'reversed', lane: 'done' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mesh.example.test/api/orchestrate/tasks/123')
    expect(init.method).toBe('DELETE')
    expect(init.headers).toMatchObject({ authorization: 'Bearer mesh-secret' })
    const cancelEvent = pool.handoffEvents.find((event) => event.event_type === 'agent.dispatch_cancel_requested')
    expect(cancelEvent?.payload).toMatchObject({
      mesh_task_id: '123',
      reason: 'work_item.reversed',
      ok: true,
      status: 202,
    })
  })

  it('keeps the reversal when best-effort Mesh cancellation fails', async () => {
    process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN = 'mesh-secret'
    const fetchSpy = vi.fn(async () => new Response('unavailable', { status: 503 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Reverse despite Mesh failure', severity: 'normal', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItem = pool.workItems[0]!
    workItem.created_at = new Date().toISOString()
    pool.handoffEvents.push({
      id: uuid(901),
      company_id: COMPANY_ID,
      work_item_id: workItem.id,
      event_type: 'agent.dispatch_acknowledged',
      actor_kind: 'system',
      actor_user_id: null,
      actor_ref: 'sitelayer-worker',
      source_system: 'mesh',
      payload: { mesh_task_id: 'mesh-456' },
      metadata: {},
      idempotency_key: 'ack-failed-cancel',
      causation_event_id: null,
      correlation_id: null,
      request_id: null,
      sentry_trace: null,
      sentry_baggage: null,
      build_sha: null,
      redaction_version: 'context-handoff-v1',
      occurred_at: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
    })

    const reverse = makeCtx(pool, { reason: 'mesh can fail independently' })
    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItem.id}/reverse`), reverse.ctx)

    expect(reverse.responses[0]?.status).toBe(200)
    expect(pool.workItems[0]?.status).toBe('reversed')
    const body = reverse.responses[0]?.body as { mesh_cancel: { ok: boolean; status?: number; error?: string } }
    expect(body.mesh_cancel).toMatchObject({ ok: false, status: 503, error: 'unavailable' })
    const cancelEvent = pool.handoffEvents.find((event) => event.event_type === 'agent.dispatch_cancel_requested')
    expect(cancelEvent?.payload).toMatchObject({
      mesh_task_id: 'mesh-456',
      ok: false,
      status: 503,
      error: 'unavailable',
    })
  })

  it('returns 400 when the reverse reason is missing or blank', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Need reason', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItemId = pool.workItems[0]!.id
    const reverse = makeCtx(pool, { reason: '   ' })

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/reverse`), reverse.ctx)

    expect(reverse.responses[0]).toEqual({ status: 400, body: { error: 'reason is required' } })
    expect(pool.workItems[0]).toMatchObject({ status: 'new' })
    expect(pool.handoffEvents.filter((event) => event.event_type === 'work_item.reversed')).toHaveLength(0)
  })

  it('rejects generic attempts to set reversed status', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Bypass reverse', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItemId = pool.workItems[0]!.id
    const statusChanged = makeCtx(pool, {
      event_type: 'work_item.status_changed',
      status: 'reversed',
      message: 'try to bypass the reverse endpoint',
    })

    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/events`),
      statusChanged.ctx,
    )

    expect(statusChanged.responses[0]).toEqual({
      status: 400,
      body: { error: 'status reversed must use the reverse endpoint' },
    })
    expect(pool.workItems[0]?.status).toBe('new')
    const directReverse = makeCtx(pool, { event_type: 'work_item.reversed', reason: 'not through endpoint' })
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/events`),
      directReverse.ctx,
    )
    expect(directReverse.responses[0]).toEqual({
      status: 400,
      body: { error: 'use the reverse endpoint for work_item.reversed' },
    })
  })

  it('returns 409 when reversing a resolved work item', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Already done', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItemId = pool.workItems[0]!.id
    // Mark resolved first via the resolution event path
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/events`),
      makeCtx(pool, { event_type: 'resolution.accepted' }).ctx,
    )

    const reverse = makeCtx(pool, { reason: 'too late' })
    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/reverse`), reverse.ctx)

    expect(reverse.responses[0]?.status).toBe(409)
    expect(pool.workItems[0]?.status).toBe('resolved')
  })

  it('returns 410 when the reversibility window has closed', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Expired window', severity: 'urgent', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItem = pool.workItems[0]!
    // Backdate created_at so the 1h urgent window is fully expired
    workItem.created_at = new Date(Date.now() - 7200_000).toISOString()
    const reverse = makeCtx(pool, { reason: 'too late' })

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItem.id}/reverse`), reverse.ctx)

    expect(reverse.responses[0]).toEqual({ status: 410, body: { error: 'reversibility window closed' } })
    expect(workItem.status).toBe('new')
  })

  it('returns the existing reversed row on idempotent re-reverse', async () => {
    const pool = new FakePool()
    const create = makeCtx(pool, { title: 'Idempotent reverse', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), create.ctx)
    const workItem = pool.workItems[0]!
    workItem.created_at = new Date().toISOString()
    const workItemId = workItem.id
    await handleWorkRequestRoutes(
      buildReq('POST'),
      buildUrl(`/api/work-requests/${workItemId}/reverse`),
      makeCtx(pool, { reason: 'first call' }).ctx,
    )
    const reverseCount = pool.handoffEvents.filter((event) => event.event_type === 'work_item.reversed').length
    const second = makeCtx(pool, { reason: 'retry' })

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/reverse`), second.ctx)

    expect(second.responses[0]?.status).toBe(200)
    expect((second.responses[0]?.body as { idempotent_replay?: boolean }).idempotent_replay).toBe(true)
    expect(pool.handoffEvents.filter((event) => event.event_type === 'work_item.reversed').length).toBe(reverseCount)
  })

  it('rejects reverse for members (TRIAGE_ROLES gate)', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Member tries reverse', client: clientContext }, 'member', 'member-1')
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id
    const reverse = makeCtx(pool, { reason: 'I want this back' }, 'member', 'member-1')

    await handleWorkRequestRoutes(buildReq('POST'), buildUrl(`/api/work-requests/${workItemId}/reverse`), reverse.ctx)

    expect(reverse.responses[0]?.status).toBe(403)
    expect(pool.workItems[0]?.status).toBe('new')
  })

  it('includes reversibility_window_seconds in the outbound dispatch payload', async () => {
    const pool = new FakePool()
    const created = makeCtx(pool, { title: 'Dispatch echoes window', severity: 'high', client: clientContext })
    await handleWorkRequestRoutes(buildReq(), buildUrl(), created.ctx)
    const workItemId = pool.workItems[0]!.id

    await handleWorkRequestRoutes(
      buildReq('POST', { host: 'sitelayer.test', 'x-forwarded-proto': 'https' }),
      buildUrl(`/api/work-requests/${workItemId}/dispatch/mesh`),
      makeCtx(pool, {}).ctx,
    )

    const outboxPayload = pool.mutationOutbox[0]?.payload as JsonRecord | undefined
    expect(outboxPayload?.reversibility_window_seconds).toBe(21600)
  })
})

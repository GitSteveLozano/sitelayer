import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { attachMutationTx } from '../mutation-tx.js'
import { handleAiChatRoutes, type AiChatRouteCtx } from './ai-chat.js'

type JsonRecord = Record<string, unknown>

class FakePool {
  auditEvents: Array<{
    id: string
    companyId: string
    actorUserId: string
    after: JsonRecord
  }> = []

  syncEvents: Array<{
    companyId: string
    entityType: string
    entityId: string
    payload: JsonRecord
    status: string
  }> = []

  mutationOutbox: Array<{
    companyId: string
    actorUserId: string | null
    entityType: string
    entityId: string
    mutationType: string
    payload: JsonRecord
    idempotencyKey: string
  }> = []

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

  private async dispatch(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (normalized.startsWith('insert into audit_events')) {
      const id = `audit-${this.auditEvents.length + 1}`
      this.auditEvents.push({
        id,
        companyId: params[0] as string,
        actorUserId: params[1] as string,
        after: JSON.parse(params[2] as string) as JsonRecord,
      })
      return { rows: [{ id }], rowCount: 1 }
    }

    if (normalized.startsWith('insert into sync_events')) {
      this.syncEvents.push({
        companyId: params[0] as string,
        entityType: params[2] as string,
        entityId: params[3] as string,
        payload: JSON.parse(params[4] as string) as JsonRecord,
        status: params[5] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('insert into mutation_outbox')) {
      this.mutationOutbox.push({
        companyId: params[0] as string,
        actorUserId: params[2] as string | null,
        entityType: params[3] as string,
        entityId: params[4] as string,
        mutationType: params[5] as string,
        payload: JSON.parse(params[6] as string) as JsonRecord,
        idempotencyKey: params[7] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('select id from audit_events')) {
      // Poll endpoint's first query: confirm the staged message exists
      // for this company.
      const [companyId, auditId] = params as [string, string]
      const hit = this.auditEvents.find((a) => a.id === auditId && a.companyId === companyId)
      return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 }
    }

    if (normalized.startsWith('select id, after, created_at from audit_events')) {
      // Poll endpoint's second query: find a sibling response row.
      const [companyId, parentId] = params as [string, string]
      const hit = [...this.responseRows]
        .reverse()
        .find(
          (r) => r.companyId === companyId && (r.after as Record<string, unknown>)?.parent_audit_event_id === parentId,
        )
      return {
        rows: hit ? [{ id: hit.id, after: hit.after, created_at: hit.createdAt }] : [],
        rowCount: hit ? 1 : 0,
      }
    }

    if (normalized.startsWith('select id, company_id from audit_events')) {
      // Webhook's audit-row resolution query (cross-tenant: looks up
      // the staged row by audit_event_id alone, returns company_id).
      const [auditId] = params as [string]
      const hit = this.auditEvents.find((a) => a.id === auditId)
      return {
        rows: hit ? [{ id: hit.id, company_id: hit.companyId }] : [],
        rowCount: hit ? 1 : 0,
      }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 200)}`)
  }

  /** Test helper: seed a response row for the poll endpoint to find. */
  seedResponse(input: { id: string; companyId: string; parentAuditEventId: string; body: string; createdAt?: Date }) {
    this.responseRows.push({
      id: input.id,
      companyId: input.companyId,
      after: { parent_audit_event_id: input.parentAuditEventId, body: input.body },
      createdAt: input.createdAt ?? new Date(),
    })
  }

  private responseRows: Array<{
    id: string
    companyId: string
    after: JsonRecord
    createdAt: Date
  }> = []
}

function buildReq(method = 'POST'): http.IncomingMessage {
  return { method } as http.IncomingMessage
}

function buildUrl(path = '/api/ai/chat'): URL {
  return new URL(`http://localhost${path}`)
}

const validBody = {
  messages: [
    { id: 'assistant-1', role: 'assistant', body: 'Ready.' },
    { id: 'operator-1', role: 'operator', body: 'Summarize the current project.' },
  ],
  operatorContext: {
    subject: 'operator',
    generated_at: '2026-05-21T01:00:00.000Z',
    origin: 'sitelayer.sandolab.xyz',
    current_focus: { label: 'Sitelayer rollout', confidence: 0.91 },
    origin_context: {
      project: 'sitelayer',
      label: 'Sitelayer',
      repo_branch: 'agent/claude_work/operator-context-chat-widget',
    },
  },
}

function makeCtx(
  pool: FakePool,
  body: unknown = validBody,
  role: CompanyRole = 'admin',
): { ctx: AiChatRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = {
    id: 'co-1',
    slug: 'co',
    name: 'Co',
    created_at: '',
    role,
  }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      currentUserId: 'user-1',
      requireRole: (allowed) => {
        const allowedRole = allowed.includes(role)
        if (!allowedRole) responses.push({ status: 403, body: { error: 'forbidden' } })
        return allowedRole
      },
      readBody: async () => body as Record<string, unknown>,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
    },
  }
}

describe('handleAiChatRoutes — operator-context chat staging', () => {
  it('ignores non-chat routes', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleAiChatRoutes(buildReq(), buildUrl('/api/projects'), ctx)

    expect(handled).toBe(false)
    expect(responses).toEqual([])
    expect(pool.auditEvents).toEqual([])
  })

  it('requires admin role', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, validBody, 'member')
    const handled = await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(handled).toBe(true)
    expect(responses).toEqual([{ status: 403, body: { error: 'forbidden' } }])
    expect(pool.auditEvents).toEqual([])
  })

  it('rejects missing message history', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { ...validBody, messages: [] })
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]).toEqual({
      status: 400,
      body: { error: 'messages array is required and non-empty' },
    })
    expect(pool.auditEvents).toEqual([])
  })

  it('rejects unregistered operator-context origins', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      ...validBody,
      operatorContext: { ...validBody.operatorContext, origin: 'evil.example' },
    })
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]).toEqual({
      status: 400,
      body: { error: 'operatorContext.origin missing or not in the registered allowlist' },
    })
    expect(pool.auditEvents).toEqual([])
  })

  it('rejects message arrays larger than the per-request cap', async () => {
    // MAX_MESSAGES_PER_REQUEST = 8. Pad to 9 operator-role entries; the
    // route should refuse before any audit_events write.
    const pool = new FakePool()
    const oversized = Array.from({ length: 9 }, (_, i) => ({
      id: `m-${i}`,
      role: 'operator' as const,
      body: `msg ${i}`,
    }))
    const { ctx, responses } = makeCtx(pool, { ...validBody, messages: oversized })
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]).toEqual({
      status: 400,
      body: {
        error: 'messages capped at 8; trim history before sending',
      },
    })
    expect(pool.auditEvents).toEqual([])
  })

  it('rejects bodies larger than the per-message byte cap', async () => {
    // MAX_BODY_BYTES = 4000. A 4001-char body must 413.
    const pool = new FakePool()
    const huge = 'x'.repeat(4001)
    const { ctx, responses } = makeCtx(pool, {
      ...validBody,
      messages: [{ id: 'operator-huge', role: 'operator', body: huge }],
    })
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]).toEqual({
      status: 413,
      body: {
        error: 'message body exceeds 4000 chars; trim before sending',
      },
    })
    expect(pool.auditEvents).toEqual([])
  })

  it('picks the latest operator-role message when history contains agent replies', async () => {
    // The route should walk the array backward and skip non-operator
    // roles + empty bodies. Crafted history: [operator stale, agent
    // reply, operator empty, operator latest].
    const pool = new FakePool()
    const history = [
      { id: 'op-stale', role: 'operator' as const, body: 'stale question' },
      { id: 'agent-1', role: 'agent' as const, body: 'agent reply' },
      { id: 'op-empty', role: 'operator' as const, body: '   ' },
      { id: 'op-latest', role: 'operator' as const, body: 'real latest question' },
    ]
    const { ctx, responses } = makeCtx(pool, { ...validBody, messages: history })
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]?.status).toBe(202)
    expect(pool.auditEvents).toHaveLength(1)
    expect(pool.auditEvents[0]?.after?.chat_message).toMatchObject({
      message_id: 'op-latest',
      body: 'real latest question',
    })
  })

  it('persists the latest operator message to audit_events and mutation ledgers', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]?.status).toBe(202)
    const stagedBody = responses[0]?.body as Record<string, unknown>
    expect(stagedBody.status).toBe('staged')
    expect(stagedBody.audit_event_id).toBe('audit-1')
    expect(stagedBody.response_pending).toBe(true)
    // Mesh dispatch is best-effort — without MESH_API_URL configured in
    // the test env, the dispatcher returns ok=false and the response
    // surfaces dispatch_error + null mesh_task_id. Production wiring
    // sets MESH_API_URL on sitelayer's prod env.
    expect(stagedBody.mesh_task_id).toBeNull()
    expect(typeof stagedBody.dispatch_error).toBe('string')
    expect(stagedBody.followup_hint).toMatch(/Subscription-CLI dispatch enqueued/)
    expect(pool.auditEvents).toHaveLength(1)
    expect(pool.auditEvents[0]?.companyId).toBe('co-1')
    expect(pool.auditEvents[0]?.actorUserId).toBe('user-1')
    expect(pool.auditEvents[0]?.after).toMatchObject({
      chat_message: {
        role: 'operator',
        body: 'Summarize the current project.',
        message_id: 'operator-1',
      },
      operator_context: {
        origin: 'sitelayer.sandolab.xyz',
        project: 'sitelayer',
        focus_label: 'Sitelayer rollout',
        focus_confidence: 0.91,
        repo_branch: 'agent/claude_work/operator-context-chat-widget',
      },
    })
    expect(pool.syncEvents[0]).toMatchObject({
      companyId: 'co-1',
      entityType: 'ai_chat',
      entityId: 'audit-1',
      status: 'pending',
    })
    expect(pool.mutationOutbox[0]).toMatchObject({
      companyId: 'co-1',
      actorUserId: 'user-1',
      entityType: 'ai_chat',
      entityId: 'audit-1',
      mutationType: 'stage_message',
      idempotencyKey: 'ai_chat:stage_message:audit-1',
    })
  })
})

describe('handleAiChatRoutes — GET /api/ai/chat/:id/response (poll)', () => {
  const validUuid = '00000000-0000-4000-8000-000000000001'

  it('rejects non-UUID audit_event_id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/not-a-uuid/response`), ctx)
    expect(responses[0]).toEqual({
      status: 400,
      body: { error: 'audit_event_id must be a valid uuid' },
    })
  })

  it('returns 404 when the staged message does not exist for this company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/${validUuid}/response`), ctx)
    expect(responses[0]).toEqual({
      status: 404,
      body: { error: 'staged chat message not found for this company' },
    })
  })

  it('returns 202 staged when message exists but no response yet', async () => {
    const pool = new FakePool()
    pool.auditEvents.push({
      id: validUuid,
      companyId: 'co-1',
      actorUserId: 'user-1',
      after: { chat_message: { body: 'hi' } },
    })
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/${validUuid}/response`), ctx)
    expect(responses[0]?.status).toBe(202)
    const body = responses[0]?.body as Record<string, unknown>
    expect(body.status).toBe('staged')
    expect(body.response_pending).toBe(true)
    expect(body.audit_event_id).toBe(validUuid)
  })

  it('returns 200 responded when a sibling respond_message row exists', async () => {
    const pool = new FakePool()
    pool.auditEvents.push({
      id: validUuid,
      companyId: 'co-1',
      actorUserId: 'user-1',
      after: { chat_message: { body: 'hi' } },
    })
    const respondAt = new Date('2026-05-21T03:14:15.000Z')
    pool.seedResponse({
      id: 'audit-resp-1',
      companyId: 'co-1',
      parentAuditEventId: validUuid,
      body: 'Hello back, operator.',
      createdAt: respondAt,
    })
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/${validUuid}/response`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as Record<string, unknown>
    expect(body.status).toBe('responded')
    expect(body.audit_event_id).toBe(validUuid)
    expect(body.response_audit_event_id).toBe('audit-resp-1')
    expect(body.body).toBe('Hello back, operator.')
    expect(body.created_at).toBe(respondAt.toISOString())
  })

  it('isolates poll lookups by company', async () => {
    const pool = new FakePool()
    // Seed a staged + response row under a DIFFERENT company; this
    // operator (co-1) must NOT see them.
    pool.auditEvents.push({
      id: validUuid,
      companyId: 'co-other',
      actorUserId: 'user-other',
      after: {},
    })
    pool.seedResponse({
      id: 'audit-resp-other',
      companyId: 'co-other',
      parentAuditEventId: validUuid,
      body: 'should not surface',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/${validUuid}/response`), ctx)
    expect(responses[0]).toEqual({
      status: 404,
      body: { error: 'staged chat message not found for this company' },
    })
  })

  it('requires admin role to poll', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, validBody, 'member')
    await handleAiChatRoutes(buildReq('GET'), buildUrl(`/api/ai/chat/${validUuid}/response`), ctx)
    expect(responses[0]).toEqual({ status: 403, body: { error: 'forbidden' } })
  })
})

describe('handleAiChatRoutes — POST /api/ai/chat/:id/respond (webhook)', () => {
  const validUuid = '00000000-0000-4000-8000-000000000001'
  const webhookToken = 'test-webhook-token-abc123'
  const validRespondBody = { body: 'Hello back, operator.', model: 'claude-sonnet-4-6' }

  function buildWebhookReq(authHeader?: string): http.IncomingMessage {
    return {
      method: 'POST',
      headers: authHeader ? { authorization: authHeader } : {},
    } as unknown as http.IncomingMessage
  }

  it('rejects when SITELAYER_CHAT_WEBHOOK_TOKEN not configured', async () => {
    const prev = process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(buildWebhookReq(`Bearer ${webhookToken}`), buildUrl(`/api/ai/chat/${validUuid}/respond`), ctx)
      expect(responses[0]?.status).toBe(503)
    } finally {
      if (prev) process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = prev
    }
  })

  it('rejects missing bearer token', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(buildWebhookReq(), buildUrl(`/api/ai/chat/${validUuid}/respond`), ctx)
      expect(responses[0]).toEqual({ status: 401, body: { error: 'missing bearer token' } })
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('rejects invalid bearer token (timing-safe compare)', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(buildWebhookReq('Bearer wrong-token-zzz'), buildUrl(`/api/ai/chat/${validUuid}/respond`), ctx)
      expect(responses[0]).toEqual({ status: 401, body: { error: 'invalid bearer token' } })
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('rejects when audit_event_id is not a valid UUID', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(
        buildWebhookReq(`Bearer ${webhookToken}`),
        buildUrl(`/api/ai/chat/not-a-uuid/respond`),
        ctx,
      )
      expect(responses[0]).toEqual({
        status: 400,
        body: { error: 'audit_event_id must be a valid uuid' },
      })
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('rejects empty response body', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, { body: '   ', model: 'x' })
      await handleAiChatRoutes(
        buildWebhookReq(`Bearer ${webhookToken}`),
        buildUrl(`/api/ai/chat/${validUuid}/respond`),
        ctx,
      )
      expect(responses[0]).toEqual({
        status: 400,
        body: { error: 'body field is required and non-empty' },
      })
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('rejects oversize response body', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, { body: 'x'.repeat(8001), model: 'x' })
      await handleAiChatRoutes(
        buildWebhookReq(`Bearer ${webhookToken}`),
        buildUrl(`/api/ai/chat/${validUuid}/respond`),
        ctx,
      )
      expect(responses[0]?.status).toBe(413)
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('rejects when staged audit row does not exist', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(
        buildWebhookReq(`Bearer ${webhookToken}`),
        buildUrl(`/api/ai/chat/${validUuid}/respond`),
        ctx,
      )
      expect(responses[0]).toEqual({
        status: 404,
        body: { error: 'staged chat message not found for this audit_event_id' },
      })
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })

  it('writes respond_message audit row and returns 201', async () => {
    process.env.SITELAYER_CHAT_WEBHOOK_TOKEN = webhookToken
    try {
      const pool = new FakePool()
      pool.auditEvents.push({
        id: validUuid,
        companyId: 'co-1',
        actorUserId: 'user-1',
        after: { chat_message: { body: 'staged' } },
      })
      const { ctx, responses } = makeCtx(pool, validRespondBody)
      await handleAiChatRoutes(
        buildWebhookReq(`Bearer ${webhookToken}`),
        buildUrl(`/api/ai/chat/${validUuid}/respond`),
        ctx,
      )
      expect(responses[0]?.status).toBe(201)
      const body = responses[0]?.body as Record<string, unknown>
      expect(body.status).toBe('recorded')
      expect(body.parent_audit_event_id).toBe(validUuid)
      expect(typeof body.response_audit_event_id).toBe('string')
      // Second audit_events row was inserted (the response).
      expect(pool.auditEvents.length).toBe(2)
      const respondRow = pool.auditEvents[1]!
      expect(respondRow.after).toMatchObject({
        body: 'Hello back, operator.',
        model: 'claude-sonnet-4-6',
        parent_audit_event_id: validUuid,
      })
      // Mutation ledger logged the write.
      expect(pool.mutationOutbox.some((m) => m.mutationType === 'respond_message')).toBe(true)
    } finally {
      delete process.env.SITELAYER_CHAT_WEBHOOK_TOKEN
    }
  })
})

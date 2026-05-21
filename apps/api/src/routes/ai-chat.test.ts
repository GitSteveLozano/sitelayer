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

    throw new Error(`unexpected SQL: ${normalized.slice(0, 200)}`)
  }
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

  it('persists the latest operator message to audit_events and mutation ledgers', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleAiChatRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]).toEqual({
      status: 202,
      body: {
        status: 'staged',
        audit_event_id: 'audit-1',
        response_pending: true,
        followup_hint: 'v0 stages the message; LLM response will land via a future audit_events row.',
      },
    })
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

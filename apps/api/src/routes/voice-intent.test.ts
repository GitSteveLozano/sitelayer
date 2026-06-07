import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { attachMutationTx } from '../mutation-tx.js'
import { handleVoiceIntentRoutes, parseProposedFields, type VoiceIntentRouteCtx } from './voice-intent.js'

type JsonRecord = Record<string, unknown>

class FakePool {
  auditEvents: Array<{
    id: string
    companyId: string
    actorUserId: string | null
    action: string
    after: JsonRecord
  }> = []

  syncEvents: Array<{ companyId: string; entityType: string; entityId: string; status: string }> = []
  mutationOutbox: Array<{ companyId: string; entityType: string; entityId: string; mutationType: string }> = []
  customers: string[] = []

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

    if (normalized.startsWith('select name from customers')) {
      return { rows: this.customers.map((name) => ({ name })), rowCount: this.customers.length }
    }

    if (normalized.startsWith('insert into audit_events')) {
      const id = `voice-${this.auditEvents.length + 1}`
      // values ($1 company, $2 actor, $3 role|'agent', 'voice_project_intent', null, action, null, $payload)
      // stage: actor=$2 role=$3 action='stage_transcript' payload=$4
      // result: actor=null role='agent' action='parse_result' payload=$3
      const isStage = normalized.includes("'stage_transcript'")
      const companyId = params[0] as string
      const actorUserId = isStage ? (params[1] as string) : null
      const action = isStage ? 'stage_transcript' : 'parse_result'
      const payloadParam = isStage ? params[3] : params[2]
      this.auditEvents.push({
        id,
        companyId,
        actorUserId,
        action,
        after: JSON.parse(payloadParam as string) as JsonRecord,
      })
      return { rows: [{ id }], rowCount: 1 }
    }

    if (normalized.startsWith('insert into sync_events')) {
      this.syncEvents.push({
        companyId: params[0] as string,
        entityType: params[2] as string,
        entityId: params[3] as string,
        status: params[5] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('insert into mutation_outbox')) {
      this.mutationOutbox.push({
        companyId: params[0] as string,
        entityType: params[3] as string,
        entityId: params[4] as string,
        mutationType: params[5] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('select id from audit_events')) {
      const [companyId, intentId] = params as [string, string]
      const hit = this.auditEvents.find(
        (a) => a.id === intentId && a.companyId === companyId && a.action === 'stage_transcript',
      )
      return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 }
    }

    if (normalized.startsWith('select id, after, created_at from audit_events')) {
      const [companyId, parentId] = params as [string, string]
      const hit = [...this.auditEvents]
        .reverse()
        .find(
          (a) =>
            a.companyId === companyId &&
            a.action === 'parse_result' &&
            (a.after as Record<string, unknown>)?.parent_intent_id === parentId,
        )
      return {
        rows: hit ? [{ id: hit.id, after: hit.after, created_at: new Date('2026-06-07T00:00:00.000Z') }] : [],
        rowCount: hit ? 1 : 0,
      }
    }

    if (normalized.startsWith('select id, company_id from audit_events')) {
      const [intentId] = params as [string]
      const hit = this.auditEvents.find((a) => a.id === intentId && a.action === 'stage_transcript')
      return {
        rows: hit ? [{ id: hit.id, company_id: hit.companyId }] : [],
        rowCount: hit ? 1 : 0,
      }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 200)}`)
  }
}

function buildReq(method = 'POST', headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, headers } as unknown as http.IncomingMessage
}
function buildUrl(path = '/api/projects/voice-intent'): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(
  pool: FakePool,
  body: unknown = { transcript: 'new project called Maple Ridge for Acme, scaffold and concrete divisions' },
  role: CompanyRole = 'admin',
): { ctx: VoiceIntentRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      currentUserId: 'user-1',
      requireRole: (allowed) => {
        const ok = (allowed as readonly string[]).includes(role)
        if (!ok) responses.push({ status: 403, body: { error: 'forbidden' } })
        return ok
      },
      requirePermission: () => true,
      readBody: async () => body as Record<string, unknown>,
      sendJson: (status, response) => responses.push({ status, body: response }),
    },
  }
}

describe('parseProposedFields — model JSON → proposed fields contract', () => {
  it('shapes a well-formed parse', () => {
    const out = parseProposedFields({
      name: '  Maple Ridge  ',
      customer: { match: 'new', name: 'Acme' },
      divisions: ['Scaffold', 'concrete', 'SCAFFOLD'],
      extra: 'ignored',
    })
    expect(out).toEqual({
      name: 'Maple Ridge',
      customer: { match: 'new', name: 'Acme' },
      divisions: ['Scaffold', 'concrete'],
      division_code: 'D3', // scaffold keyword → D3
    })
  })

  it('defends against garbage / missing fields', () => {
    expect(parseProposedFields(null)).toEqual({
      name: null,
      customer: { match: 'new', name: null },
      divisions: [],
      division_code: null,
    })
    expect(parseProposedFields({ name: 42, customer: 'nope', divisions: 'nope' })).toEqual({
      name: null,
      customer: { match: 'new', name: null },
      divisions: [],
      division_code: null,
    })
  })

  it('maps concrete to D2 and respects an existing-customer match', () => {
    const out = parseProposedFields({
      name: 'Job',
      customer: { match: 'existing', name: 'Foxridge' },
      divisions: ['concrete'],
    })
    expect(out.customer).toEqual({ match: 'existing', name: 'Foxridge' })
    expect(out.division_code).toBe('D2')
  })
})

describe('handleVoiceIntentRoutes — POST /api/projects/voice-intent (disabled gate)', () => {
  let prevMesh: string | undefined
  let prevFlag: string | undefined
  beforeEach(() => {
    prevMesh = process.env.MESH_API_URL
    prevFlag = process.env.AI_CHAT_ENABLED
    delete process.env.MESH_API_URL
    delete process.env.AI_CHAT_ENABLED
  })
  afterEach(() => {
    if (prevMesh === undefined) delete process.env.MESH_API_URL
    else process.env.MESH_API_URL = prevMesh
    if (prevFlag === undefined) delete process.env.AI_CHAT_ENABLED
    else process.env.AI_CHAT_ENABLED = prevFlag
  })

  it('returns a calm 200 disabled with no audit row when AI is unconfigured', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)
    expect(handled).toBe(true)
    expect(responses[0]).toEqual({
      status: 200,
      body: {
        status: 'disabled',
        ai_chat_enabled: false,
        reason: 'Voice project setup is not configured on this deployment.',
      },
    })
    expect(pool.auditEvents).toEqual([])
    expect(pool.mutationOutbox).toEqual([])
  })

  it('AI_CHAT_ENABLED=0 forces disabled even with MESH_API_URL set', async () => {
    process.env.MESH_API_URL = 'http://mesh-test.invalid:8713'
    process.env.AI_CHAT_ENABLED = '0'
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as JsonRecord).status).toBe('disabled')
    expect(pool.auditEvents).toEqual([])
  })

  it('requires admin/office role before reporting disabled', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { transcript: 'x' }, 'member')
    await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)
    expect(responses[0]).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(pool.auditEvents).toEqual([])
  })

  it('ignores unrelated routes', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    const handled = await handleVoiceIntentRoutes(buildReq(), buildUrl('/api/projects'), ctx)
    expect(handled).toBe(false)
    expect(responses).toEqual([])
  })
})

describe('handleVoiceIntentRoutes — POST /api/projects/voice-intent (enabled stage path)', () => {
  let prevMesh: string | undefined
  let prevFlag: string | undefined
  beforeEach(() => {
    prevMesh = process.env.MESH_API_URL
    prevFlag = process.env.AI_CHAT_ENABLED
    // Enabled via MESH_API_URL; SITELAYER_PUBLIC_BASE stays unset so the mesh
    // dispatch best-effort-fails (dispatch_error surfaced) but the transcript
    // is durably STAGED — and crucially NO project is created.
    process.env.MESH_API_URL = 'http://mesh-test.invalid:8713'
    delete process.env.AI_CHAT_ENABLED
  })
  afterEach(() => {
    if (prevMesh === undefined) delete process.env.MESH_API_URL
    else process.env.MESH_API_URL = prevMesh
    if (prevFlag === undefined) delete process.env.AI_CHAT_ENABLED
    else process.env.AI_CHAT_ENABLED = prevFlag
  })

  it('stages the transcript and never inserts a project (confirm-gate)', async () => {
    const pool = new FakePool()
    pool.customers = ['Acme Builders', 'Foxridge Homes']
    const { ctx, responses } = makeCtx(pool)
    await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)

    expect(responses[0]?.status).toBe(202)
    const body = responses[0]?.body as JsonRecord
    expect(body.status).toBe('staged')
    expect(typeof body.voice_intent_id).toBe('string')
    expect(body.response_pending).toBe(true)
    // Exactly ONE audit row, and it is the staged transcript — NOT a project.
    expect(pool.auditEvents).toHaveLength(1)
    expect(pool.auditEvents[0]?.action).toBe('stage_transcript')
    expect(pool.auditEvents[0]?.after).toMatchObject({
      voice_intent: { transcript: expect.stringContaining('Maple Ridge'), origin: 'project-new' },
    })
    // No projects insert happened at all (FakePool would throw on it).
    expect(pool.mutationOutbox.some((m) => m.entityType === 'project')).toBe(false)
    expect(pool.mutationOutbox[0]?.entityType).toBe('voice_project_intent')
  })

  it('rejects an empty transcript', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { transcript: '   ' })
    await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)
    expect(responses[0]).toEqual({ status: 400, body: { error: 'transcript is required and non-empty' } })
    expect(pool.auditEvents).toEqual([])
  })

  it('rejects an oversize transcript', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { transcript: 'x'.repeat(1201) })
    await handleVoiceIntentRoutes(buildReq(), buildUrl(), ctx)
    expect(responses[0]?.status).toBe(413)
    expect(pool.auditEvents).toEqual([])
  })
})

describe('handleVoiceIntentRoutes — GET poll + POST respond webhook', () => {
  const validUuid = '00000000-0000-4000-8000-000000000abc'
  const token = 'voice-token-abc123'

  it('poll returns 404 when no staged intent for this company', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleVoiceIntentRoutes(buildReq('GET'), buildUrl(`/api/projects/voice-intent/${validUuid}`), ctx)
    expect(responses[0]).toEqual({ status: 404, body: { error: 'staged voice intent not found for this company' } })
  })

  it('poll returns 202 pending then 200 parsed after the webhook lands', async () => {
    process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN = token
    try {
      const pool = new FakePool()
      // Seed a staged row directly.
      pool.auditEvents.push({
        id: validUuid,
        companyId: 'co-1',
        actorUserId: 'user-1',
        action: 'stage_transcript',
        after: { voice_intent: { transcript: 'hi', origin: 'project-new' } },
      })

      // 1) pending
      {
        const { ctx, responses } = makeCtx(pool)
        await handleVoiceIntentRoutes(buildReq('GET'), buildUrl(`/api/projects/voice-intent/${validUuid}`), ctx)
        expect(responses[0]?.status).toBe(202)
        expect((responses[0]?.body as JsonRecord).status).toBe('pending')
      }

      // 2) webhook posts the parsed fields back
      {
        const respondBody = {
          fields: { name: 'Maple Ridge', customer: { match: 'new', name: 'Acme' }, divisions: ['scaffold'] },
          model: 'claude-test',
        }
        const { ctx, responses } = makeCtx(pool, respondBody)
        await handleVoiceIntentRoutes(
          buildReq('POST', { authorization: `Bearer ${token}` }),
          buildUrl(`/api/projects/voice-intent/${validUuid}/respond`),
          ctx,
        )
        expect(responses[0]?.status).toBe(201)
        expect((responses[0]?.body as JsonRecord).status).toBe('recorded')
        // A parse_result row was written — actor agent, action parse_result.
        const resultRow = pool.auditEvents.find((a) => a.action === 'parse_result')
        expect(resultRow?.actorUserId).toBeNull()
      }

      // 3) poll now returns parsed with the shaped proposal
      {
        const { ctx, responses } = makeCtx(pool)
        await handleVoiceIntentRoutes(buildReq('GET'), buildUrl(`/api/projects/voice-intent/${validUuid}`), ctx)
        expect(responses[0]?.status).toBe(200)
        const body = responses[0]?.body as JsonRecord
        expect(body.status).toBe('parsed')
        expect(body.proposed).toMatchObject({
          name: 'Maple Ridge',
          customer: { match: 'new', name: 'Acme' },
          divisions: ['scaffold'],
          division_code: 'D3',
        })
      }
    } finally {
      delete process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN
    }
  })

  it('webhook rejects an invalid bearer token', async () => {
    process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN = token
    try {
      const pool = new FakePool()
      const { ctx, responses } = makeCtx(pool, { fields: {} })
      await handleVoiceIntentRoutes(
        buildReq('POST', { authorization: 'Bearer wrong-zzz' }),
        buildUrl(`/api/projects/voice-intent/${validUuid}/respond`),
        ctx,
      )
      expect(responses[0]).toEqual({ status: 401, body: { error: 'invalid bearer token' } })
    } finally {
      delete process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN
    }
  })

  it('webhook 503s when the token is not configured', async () => {
    delete process.env.SITELAYER_VOICE_INTENT_WEBHOOK_TOKEN
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { fields: {} })
    await handleVoiceIntentRoutes(
      buildReq('POST', { authorization: `Bearer ${token}` }),
      buildUrl(`/api/projects/voice-intent/${validUuid}/respond`),
      ctx,
    )
    expect(responses[0]?.status).toBe(503)
  })
})

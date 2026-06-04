import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import { handleFeedbackInviteRoutes, type FeedbackInviteRouteCtx } from './feedback-invites.js'

type Response = { status: number; body: unknown }

class FakePool {
  queries: Array<{ sql: string; params: unknown[] }> = []
  invites: Array<Record<string, unknown>> = []
  auditRows: unknown[][] = []
  admin = true

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

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
      const row = this.invites.find((invite) => invite.id === params[0])
      if (row) row.last_used_at = '2026-06-04T12:05:00.000Z'
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('update feedback_invites') && normalized.includes('set revoked_at')) {
      const row = this.invites.find((invite) => invite.company_id === params[0] && invite.id === params[1])
      if (row) row.revoked_at = '2026-06-04T12:10:00.000Z'
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
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
      buildUrl(
        '/api/portal/feedback-invites/capture-sessions/99999999-9999-4999-8999-999999999999/artifacts/upload',
      ),
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

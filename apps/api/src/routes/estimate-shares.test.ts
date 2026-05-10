import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import {
  PORTAL_ESTIMATES_PATH_PREFIX,
  handleEstimateShareRoutes,
  handlePublicEstimateShareRoutes,
  type EstimateShareRow,
} from './estimate-shares.js'
import { generateShareToken } from '../estimate-share-token.js'

// ---------------------------------------------------------------------------
// In-memory pg double — covers what the share routes need without spinning
// a real Postgres. Each fake responds to the SQL the route module emits by
// matching on a substring; test setup wires the rows the route should see.
// Mirrors the simple stubs other apps/api tests use; not a general-purpose
// SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  shares: EstimateShareRow[] = []
  projects: Row[] = []
  companies: Row[] = []
  workflowEvents: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  expiredOverride: { token: string; expiresAt: string } | null = null

  /** Register this fake pool with the mutation-tx module for the
   * duration of the test that owns it. */
  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    // Each connect() returns a tx-scoped client. The fake's tx semantics
    // are weak: we don't roll back on throw, but the route module's `for
    // update` selects + updates land on the same backing store, which is
    // enough for the assertions below.
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return { rows: [], rowCount: 0 }
    }

    // ---- estimate_share_links ----
    if (/select[\s\S]+from estimate_share_links/i.test(sql) && /share_token = \$1/.test(sql)) {
      const [token] = params as [string]
      const row = this.shares.find((s) => s.share_token === token) ?? null
      return { rows: row ? [this.serializeShare(row)] : [], rowCount: row ? 1 : 0 }
    }
    if (/select[\s\S]+from estimate_share_links/i.test(sql) && /project_id = \$2/.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.shares
        .filter((s) => s.company_id === companyId && s.project_id === projectId)
        .map((s) => this.serializeShare(s))
      return { rows, rowCount: rows.length }
    }
    if (/insert into estimate_share_links/i.test(sql)) {
      const [companyId, projectId, snapshot, token, email, name, expiresInDays] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
      ]
      const now = new Date().toISOString()
      const expires = new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
      const row: EstimateShareRow = {
        id: `share-${this.shares.length + 1}`,
        company_id: companyId,
        project_id: projectId,
        estimate_snapshot: JSON.parse(snapshot),
        share_token: token,
        recipient_email: email,
        recipient_name: name,
        sent_at: now,
        expires_at: expires,
        accepted_at: null,
        declined_at: null,
        decline_reason: null,
        viewed_at: null,
        view_count: 0,
        signature_data_url: null,
        signer_name: null,
        signer_ip: null,
        created_at: now,
        updated_at: now,
      }
      this.shares.push(row)
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /set expires_at = now\(\)/.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.shares.find((s) => s.company_id === companyId && s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.expires_at = new Date().toISOString()
      row.updated_at = row.expires_at
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /accepted_at = now\(\)/.test(sql)) {
      const [id, signerName, signatureUrl, ip] = params as [string, string, string, string | null]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      row.accepted_at = now
      row.signer_name = signerName
      row.signature_data_url = signatureUrl
      row.signer_ip = ip
      row.viewed_at = row.viewed_at ?? now
      row.updated_at = now
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /declined_at = now\(\)/.test(sql)) {
      const [id, reason] = params as [string, string]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      row.declined_at = now
      row.decline_reason = reason
      row.viewed_at = row.viewed_at ?? now
      row.updated_at = now
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /viewed_at = coalesce/.test(sql)) {
      const [id] = params as [string]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      row.viewed_at = row.viewed_at ?? now
      row.view_count += 1
      row.updated_at = now
      return { rows: [], rowCount: 1 }
    }

    // ---- projects ----
    if (/select id, bid_total, lifecycle_state/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/select lifecycle_state, lifecycle_state_version/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/p\.name as project_name/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      const company = this.companies.find((c) => c.id === companyId)
      if (!project || !company) return { rows: [], rowCount: 0 }
      return {
        rows: [{ project_name: project.name, company_name: company.name }],
        rowCount: 1,
      }
    }
    if (/select service_item_code, quantity, unit, rate, amount/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      // Test data: project p1 has two lines, total 1234.56.
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      return {
        rows: project.estimate_lines as Row[],
        rowCount: (project.estimate_lines as Row[]).length,
      }
    }
    if (/update projects/i.test(sql)) {
      // Lifecycle update — rewrite mapped columns. We don't bother to
      // parse the SET clause; route tests assert via re-reading the
      // project after the fact.
      const projectId = params[params.length - 1] as string
      const companyId = params[params.length - 2] as string
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      project.lifecycle_state = params[0]
      project.lifecycle_state_version = params[1]
      // Map the remaining params loosely: 3rd param is the timestamp in
      // SEND/ACCEPT/DECLINE; for ACCEPT we also pass NULLs but those land
      // as static SET NULL clauses, not parameters.
      if (project.lifecycle_state === 'sent') project.lifecycle_sent_at = params[2]
      if (project.lifecycle_state === 'accepted') {
        project.lifecycle_accepted_at = params[2]
        project.lifecycle_declined_at = null
        project.lifecycle_decline_reason = null
      }
      if (project.lifecycle_state === 'declined') {
        project.lifecycle_declined_at = params[2]
        project.lifecycle_decline_reason = params[3]
      }
      return { rows: [], rowCount: 1 }
    }

    // ---- workflow_event_log + sync_events + mutation_outbox ----
    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        company_id: params[0],
        workflow_name: params[1],
        schema_version: params[2],
        entity_type: params[3],
        entity_id: params[4],
        state_version: params[5],
        event_type: params[6],
        event_payload: params[7],
        snapshot_after: params[8],
        actor_user_id: params[9],
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    // Project meta read used by the inline lifecycle helper to construct
    // the notify_foreman_assignment outbox payload.
    if (/select name, customer_name\s+from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      return { rows: [{ name: project.name, customer_name: 'Test Customer' }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }

  private serializeShare(row: EstimateShareRow): Row {
    return {
      ...row,
      // The route SELECTs use `host(signer_ip) as signer_ip`; mirror.
      signer_ip: row.signer_ip,
    }
  }
}

function makeAuthCtx(pool: FakePool, overrides: Partial<Parameters<typeof handleEstimateShareRoutes>[2]> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Parameters<typeof handleEstimateShareRoutes>[2]['pool'],
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
      currentUserId: 'u-1',
      requireRole: () => true,
      readBody: async () => {
        const body = reads.shift() ?? {}
        return body as Record<string, unknown>
      },
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      shareSecret: 'test-secret',
      portalBaseUrl: 'https://app.example.com',
      ...overrides,
    },
  }
}

function makePublicCtx(pool: FakePool, overrides: Partial<Parameters<typeof handlePublicEstimateShareRoutes>[2]> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Parameters<typeof handlePublicEstimateShareRoutes>[2]['pool'],
      shareSecret: 'test-secret',
      resolveClientIp: () => '127.0.0.1',
      readBody: async () => {
        const body = reads.shift() ?? {}
        return body as Record<string, unknown>
      },
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      ...overrides,
    },
  }
}

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.companies.push({ id: 'co-1', name: 'Acme Co' })
  pool.projects.push({
    id: 'p-1',
    company_id: 'co-1',
    name: 'Riverbend',
    bid_total: 5000,
    lifecycle_state: 'estimating',
    lifecycle_state_version: 2,
    estimate_lines: [
      {
        service_item_code: 'SVC-1',
        quantity: 100,
        unit: 'sqft',
        rate: 25,
        amount: 2500,
        division_code: null,
      },
      {
        service_item_code: 'SVC-2',
        quantity: 50,
        unit: 'lf',
        rate: 50,
        amount: 2500,
        division_code: null,
      },
    ],
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleEstimateShareRoutes — POST /api/projects/:id/estimate/share', () => {
  it('creates a share row, returns share_url, and dispatches lifecycle SEND when project is estimating', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com', recipient_name: 'Client Smith' })

    const handled = await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/p-1/estimate/share'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { share_token: string; share_url: string; id: string }
    expect(body.share_token).toMatch(/\./)
    expect(body.share_url).toContain(`${PORTAL_ESTIMATES_PATH_PREFIX}`)

    expect(pool.shares).toHaveLength(1)
    const project = pool.projects[0]!
    expect(project.lifecycle_state).toBe('sent')
    expect(project.lifecycle_state_version).toBe(3)

    const sendEvent = pool.workflowEvents.find((e) => e.event_type === 'SEND')
    expect(sendEvent).toBeDefined()
    expect(sendEvent?.entity_id).toBe('p-1')
  })

  it('rejects when recipient_email is missing or malformed', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({})
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects expires_in_days outside (0, 365]', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'a@b.co', expires_in_days: 999 })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', name: 'Acme Co' })
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'a@b.co' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/missing/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('does not transition the lifecycle when the project is past estimating', async () => {
    const pool = new FakePool()
    seedProject(pool, { lifecycle_state: 'sent', lifecycle_state_version: 3 })
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(201)
    const project = pool.projects[0]!
    expect(project.lifecycle_state).toBe('sent')
    // No SEND workflow event written this run because the helper short-circuited.
    expect(pool.workflowEvents.find((e) => e.event_type === 'SEND')).toBeUndefined()
  })
})

describe('handleEstimateShareRoutes — POST /api/estimate-shares/:id/revoke', () => {
  it('sets expires_at to now and returns the share', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx: createCtx, reads: createReads } = makeAuthCtx(pool)
    createReads.push({ recipient_email: 'a@b.co' })
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/p-1/estimate/share'),
      createCtx,
    )
    const share = pool.shares[0]!
    const before = new Date(share.expires_at).getTime()

    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/estimate-shares/${share.id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const after = new Date(pool.shares[0]!.expires_at).getTime()
    expect(after).toBeLessThanOrEqual(Date.now() + 5)
    expect(after).toBeLessThan(before)
  })
})

describe('handlePublicEstimateShareRoutes — portal flows', () => {
  async function seedShare(pool: FakePool): Promise<{ token: string; id: string }> {
    seedProject(pool)
    const { ctx, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com', recipient_name: 'Client' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    const row = pool.shares[0]!
    return { token: row.share_token, id: row.id }
  }

  it('GET /api/portal/estimates/:token returns the snapshot + bumps view_count on first view', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { status: string; estimate: { lines: unknown[] }; project_name: string }
    expect(body.status).toBe('pending')
    expect(body.estimate.lines).toHaveLength(2)
    expect(body.project_name).toBe('Riverbend')
    expect(pool.shares[0]?.view_count).toBe(1)
    expect(pool.shares[0]?.viewed_at).not.toBeNull()
  })

  it('GET returns 401 for an invalid (HMAC mismatch) token', async () => {
    const pool = new FakePool()
    await seedShare(pool)
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/abc.def`), ctx)
    expect(responses[0]?.status).toBe(401)
  })

  it('GET returns 410 for an expired share', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.expires_at = new Date(Date.now() - 1000).toISOString()
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(410)
  })

  it('POST /accept marks accepted_at and dispatches lifecycle ACCEPT (sent → accepted)', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    // Sanity: SEND already moved the project to 'sent' during share create.
    expect(pool.projects[0]?.lifecycle_state).toBe('sent')

    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.accepted_at).not.toBeNull()
    expect(pool.shares[0]?.signer_name).toBe('Client Smith')
    expect(pool.projects[0]?.lifecycle_state).toBe('accepted')
    const accept = pool.workflowEvents.find((e) => e.event_type === 'ACCEPT')
    expect(accept).toBeDefined()
  })

  it('POST /accept is idempotent — a second accept returns the existing accepted_at', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const first = makePublicCtx(pool)
    first.reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      first.ctx,
    )
    const acceptedAt = pool.shares[0]!.accepted_at

    const second = makePublicCtx(pool)
    second.reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      second.ctx,
    )
    expect(second.responses[0]?.status).toBe(200)
    const body = second.responses[0]?.body as { idempotent: boolean; accepted_at: string }
    expect(body.idempotent).toBe(true)
    expect(body.accepted_at).toBe(acceptedAt)
  })

  it('POST /accept rejects a malformed signature data URL', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ signer_name: 'X', signature_data_url: 'not-a-data-url' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('POST /decline marks declined_at and dispatches lifecycle DECLINE', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ decline_reason: 'too expensive' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.declined_at).not.toBeNull()
    expect(pool.shares[0]?.decline_reason).toBe('too expensive')
    expect(pool.projects[0]?.lifecycle_state).toBe('declined')
  })

  it('POST /decline returns 409 when the share has already been accepted', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.accepted_at = new Date().toISOString()
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ decline_reason: 'wait, no' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })

  it('returns false for non-portal paths so the public dispatcher keeps walking', async () => {
    const pool = new FakePool()
    const { ctx } = makePublicCtx(pool)
    const handled = await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/health'), ctx)
    expect(handled).toBe(false)
  })

  it('refuses an unforgeable token: a freshly-generated token under a different secret is 401', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { token } = generateShareToken('a-different-secret')
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(401)
  })
})

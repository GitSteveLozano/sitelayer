import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import { handleAdminWorkRequestRoutes } from './admin-work-requests.js'

type Response = { status: number; body: unknown }

class FakePool {
  queries: Array<{ sql: string; params: unknown[] }> = []
  boardRows: Array<Record<string, unknown>> = []

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from platform_admins')) {
      return { rows: params[0] === 'admin-1' ? [{ '?column?': 1 }] : [], rowCount: params[0] === 'admin-1' ? 1 : 0 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('join companies c')) {
      return { rows: this.boardRows, rowCount: this.boardRows.length }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method } as http.IncomingMessage
}

function buildUrl(path = '/api/admin/work-requests/board'): URL {
  return new URL(`http://localhost${path}`)
}

function makeDeps(pool: FakePool, identity: Identity = { userId: 'admin-1', source: 'clerk' }) {
  const responses: Response[] = []
  return {
    responses,
    deps: {
      pool,
      identity,
      sendJson: (status: number, body: unknown) => responses.push({ status, body }),
      envIds: new Set<string>(),
    },
  }
}

function boardRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    company_id: '11111111-1111-4111-8111-111111111111',
    company_slug: 'co-a',
    company_name: 'Company A',
    support_packet_id: '00000000-0000-4000-8000-000000000301',
    domain: 'app_issue',
    title: 'Capture issue',
    summary: 'Something broke',
    status: 'new',
    lane: 'triage',
    severity: 'normal',
    route: '/desktop',
    capture_session_id: null,
    entity_type: 'feedback',
    entity_id: 'fb-1',
    assignee_user_id: null,
    created_by_user_id: 'user-1',
    created_at: '2026-06-04T12:00:00.000Z',
    updated_at: '2026-06-04T12:01:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: '2026-06-05T12:00:00.000Z',
    ...overrides,
  }
}

describe('handleAdminWorkRequestRoutes', () => {
  it('ignores non-admin work-request board paths', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool)

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl('/api/work-requests/board'), deps)

    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
    expect(pool.queries).toHaveLength(0)
  })

  it('requires a verified platform admin identity', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool, { userId: 'demo-user', source: 'default' })

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]).toMatchObject({
      status: 401,
      body: { error: 'platform admin requires a verified Clerk session' },
    })
    expect(pool.queries).toHaveLength(0)
  })

  it('returns cross-tenant board columns with tenant identity on every item', async () => {
    const pool = new FakePool()
    const statuses = [
      'new',
      'triaged',
      'agent_running',
      'human_assigned',
      'review_ready',
      'review_stale',
      'proposal_expired',
      'resolved',
      'reopened',
      'wont_do',
      'reversed',
    ]
    pool.boardRows = statuses.map((status, index) =>
      boardRow({
        id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
        title: `Status ${status}`,
        status,
        company_slug: index % 2 === 0 ? 'co-a' : 'co-b',
        company_name: index % 2 === 0 ? 'Company A' : 'Company B',
        lane: status === 'resolved' || status === 'wont_do' || status === 'reversed' ? 'done' : 'triage',
      }),
    )
    const { deps, responses } = makeDeps(pool)

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      columns: Array<{ id: string; statuses: string[]; work_items: Array<{ company_slug: string }> }>
      work_items: Array<{ company_slug: string; company_name: string }>
    }
    expect(body.columns.map((column) => column.id)).toEqual(['new', 'triaged', 'in_progress', 'done'])
    expect(body.columns.flatMap((column) => column.statuses).sort()).toEqual([...statuses].sort())
    expect(body.work_items.every((item) => item.company_slug && item.company_name)).toBe(true)
    expect(pool.queries.at(-1)?.sql).toContain('join companies c on c.id = w.company_id')
  })

  it('validates filters and passes safe filters as query params', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool)

    await handleAdminWorkRequestRoutes(
      buildReq(),
      buildUrl('/api/admin/work-requests/board?company_id=bad&status=new'),
      deps,
    )

    expect(responses[0]).toMatchObject({ status: 400, body: { error: 'company_id must be a uuid' } })

    const ok = makeDeps(pool)
    await handleAdminWorkRequestRoutes(
      buildReq(),
      buildUrl('/api/admin/work-requests/board?company_slug=co-a&status=new&lane=triage&assignee_user_id=operator'),
      ok.deps,
    )

    expect(ok.responses[0]?.status).toBe(200)
    expect(pool.queries.at(-1)?.params).toEqual(['co-a', 'new', 'triage', 'operator', 200, 0])
  })

  it('selects and returns the work-item domain on every board item (cross-domain read surface)', async () => {
    const pool = new FakePool()
    pool.boardRows = [
      boardRow({ domain: 'app_issue', title: 'Software bug' }),
      boardRow({
        id: '00000000-0000-4000-8000-000000000202',
        domain: 'field_request',
        title: 'Field problem',
        company_slug: 'co-b',
        company_name: 'Company B',
      }),
    ]
    const { deps, responses } = makeDeps(pool)

    await handleAdminWorkRequestRoutes(buildReq(), buildUrl(), deps)

    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { work_items: Array<{ domain: string; title: string }> }
    expect(body.work_items.map((item) => item.domain)).toEqual(['app_issue', 'field_request'])
    // The select list must actually carry the column.
    expect(pool.queries.at(-1)?.sql).toContain('w.domain')
  })

  it('accepts an optional domain filter and rejects unknown domains', async () => {
    const pool = new FakePool()
    const bad = makeDeps(pool)
    await handleAdminWorkRequestRoutes(buildReq(), buildUrl('/api/admin/work-requests/board?domain=bogus'), bad.deps)
    expect(bad.responses[0]).toMatchObject({
      status: 400,
      body: { error: 'domain must be one of app_issue, field_request' },
    })

    const ok = makeDeps(pool)
    await handleAdminWorkRequestRoutes(buildReq(), buildUrl('/api/admin/work-requests/board?domain=app_issue'), ok.deps)
    expect(ok.responses[0]?.status).toBe(200)
    expect(pool.queries.at(-1)?.sql).toContain('w.domain = $1')
    expect(pool.queries.at(-1)?.params).toEqual(['app_issue', 200, 0])
  })
})

// ---------------------------------------------------------------------------
// POST /api/admin/work-requests/:id/dispatch-to-agent — the agent-feed door.
// ---------------------------------------------------------------------------

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ITEM_ID = '00000000-0000-4000-9000-000000000001'
const SUPPORT_PACKET_ID = '00000000-0000-4000-8000-000000000301'
const CAPTURE_SESSION_ID = '00000000-0000-4000-8000-000000000123'
const ARTIFACT_ID = '00000000-0000-4000-8000-00000000a001'

type JsonRecord = Record<string, unknown>

class FakeDispatchPool {
  queries: Array<{ sql: string; params: unknown[] }> = []
  workItems: JsonRecord[] = []
  supportPackets: JsonRecord[] = []
  artifacts: JsonRecord[] = []
  agentFeedConcerns: JsonRecord[] = []
  handoffEvents: JsonRecord[] = []

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
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
    if (normalized.includes('from platform_admins')) {
      return { rows: params[0] === 'admin-1' ? [{ '?column?': 1 }] : [], rowCount: params[0] === 'admin-1' ? 1 : 0 }
    }
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
        payload: JSON.parse(params[7] as string) as JsonRecord,
        metadata: JSON.parse(params[8] as string) as JsonRecord,
        idempotency_key: idempotencyKey,
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('w.id = $1::uuid')) {
      const row = this.workItems.find((w) => w.id === params[0])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from support_debug_packets')) {
      const row = this.supportPackets.find((p) => p.company_id === params[0] && p.id === params[1])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from capture_artifacts')) {
      const rows = this.artifacts.filter(
        (a) => a.company_id === params[0] && a.capture_session_id === params[1] && a.storage_key,
      )
      return { rows, rowCount: rows.length }
    }
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
      const existing = this.agentFeedConcerns.find(
        (row) => row.project_key === projectKey && row.concern_ref === concernRef,
      )
      if (existing) return { rows: [], rowCount: 0 }
      const row = {
        id: `00000000-0000-4000-c000-${String(this.agentFeedConcerns.length + 1).padStart(12, '0')}`,
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
      this.agentFeedConcerns.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (normalized.includes('from agent_feed_concerns') && normalized.includes('concern_ref = $2')) {
      const row = this.agentFeedConcerns.find((r) => r.company_id === params[0] && r.concern_ref === params[1])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    throw new Error(`unexpected SQL: ${normalized.slice(0, 200)}`)
  }

  seedWorkItem(overrides: JsonRecord = {}) {
    const row = {
      id: WORK_ITEM_ID,
      company_id: COMPANY_ID,
      support_packet_id: SUPPORT_PACKET_ID,
      title: 'Verify scale button failed',
      summary: 'The recorded user could not verify scale.',
      severity: 'high',
      route: '/desktop/takeoff',
      capture_session_id: null,
      metadata: {},
      ...overrides,
    }
    this.workItems.push(row)
    return row
  }

  seedSupportPacket() {
    const row = {
      id: SUPPORT_PACKET_ID,
      company_id: COMPANY_ID,
      actor_user_id: 'user-1',
      request_id: 'req-1',
      route: '/desktop/takeoff',
      capture_session_id: CAPTURE_SESSION_ID,
      build_sha: 'build-test',
      problem: 'The recorded user could not verify scale.',
      client: {},
      server_context: { request_ids: ['req-1'], trace_ids: [] },
      created_at: '2026-06-09T11:00:00.000Z',
      expires_at: null,
      redaction_version: 'support-packet-v1',
    }
    this.supportPackets.push(row)
    return row
  }
}

function makeDispatchDeps(
  pool: FakeDispatchPool,
  body: Record<string, unknown>,
  identity: Identity = { userId: 'admin-1', source: 'clerk' },
) {
  pool.attach()
  const responses: Response[] = []
  return {
    responses,
    deps: {
      pool,
      identity,
      sendJson: (status: number, body: unknown) => responses.push({ status, body }),
      readBody: async () => body,
      envIds: new Set<string>(),
    },
  }
}

function dispatchUrl(id = WORK_ITEM_ID): URL {
  return buildUrl(`/api/admin/work-requests/${id}/dispatch-to-agent`)
}

describe('POST /api/admin/work-requests/:id/dispatch-to-agent', () => {
  it('requires a verified platform admin identity', async () => {
    const pool = new FakeDispatchPool()
    pool.seedWorkItem()
    const { deps, responses } = makeDispatchDeps(pool, { audience: 'steve' }, { userId: 'rando', source: 'clerk' })

    const handled = await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(403)
    expect(pool.agentFeedConcerns).toHaveLength(0)
  })

  it('creates the addressed steve concern from the work item + support packet (201)', async () => {
    const pool = new FakeDispatchPool()
    pool.seedWorkItem({ metadata: { acceptance: ['scale verification works on /desktop/takeoff'] } })
    pool.seedSupportPacket()
    const { deps, responses } = makeDispatchDeps(pool, { audience: 'steve' })

    const handled = await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { concern: JsonRecord; created: boolean }
    expect(body.created).toBe(true)
    expect(pool.agentFeedConcerns).toHaveLength(1)
    expect(pool.agentFeedConcerns[0]).toMatchObject({
      audience: 'steve',
      project_key: 'sitelayer',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      status: 'pending',
      work_item_id: WORK_ITEM_ID,
    })
    const concern = pool.agentFeedConcerns[0]?.concern as JsonRecord
    expect(concern).toMatchObject({
      kind: 'execute',
      title: 'Verify scale button failed',
      summary: 'The recorded user could not verify scale.',
      audience: 'steve',
      assignee: 'steve',
      acceptance: ['scale verification works on /desktop/takeoff'],
      source_event_ref: SUPPORT_PACKET_ID,
    })
    const inputs = concern.inputs as JsonRecord
    expect(inputs).toMatchObject({
      work_item_id: WORK_ITEM_ID,
      support_packet_id: SUPPORT_PACKET_ID,
      url: '/desktop/takeoff',
    })
    // The SAME prompt text the support-packet agent_prompt endpoint serves.
    expect(String(inputs.agent_prompt)).toContain(`Investigate Sitelayer support packet ${SUPPORT_PACKET_ID}`)
    expect(inputs.artifacts).toEqual([])
    // Dispatch is no longer invisible on the work item: the timeline shows it.
    expect(pool.handoffEvents).toHaveLength(1)
    expect(pool.handoffEvents[0]).toMatchObject({
      work_item_id: WORK_ITEM_ID,
      event_type: 'agent.dispatch_requested',
      actor_kind: 'user',
      actor_user_id: 'admin-1',
      idempotency_key: `agent_feed:wi:${WORK_ITEM_ID}:steve:dispatch_requested`,
    })
    expect(pool.handoffEvents[0]?.payload).toMatchObject({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      dispatch_surface: 'agent_feed',
    })
  })

  it('is idempotent on concern_ref — a repeat dispatch returns the existing row (200)', async () => {
    const pool = new FakeDispatchPool()
    pool.seedWorkItem()
    pool.seedSupportPacket()

    const first = makeDispatchDeps(pool, { audience: 'steve' })
    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), first.deps)
    expect(first.responses[0]?.status).toBe(201)

    const second = makeDispatchDeps(pool, { audience: 'steve' })
    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), second.deps)
    expect(second.responses[0]?.status).toBe(200)
    const body = second.responses[0]?.body as { concern: JsonRecord; created: boolean }
    expect(body.created).toBe(false)
    expect((body.concern as JsonRecord).concern_ref).toBe(`wi:${WORK_ITEM_ID}:steve`)
    expect(pool.agentFeedConcerns).toHaveLength(1)
    // The repeat dispatch appends NO second timeline event either.
    expect(pool.handoffEvents).toHaveLength(1)
  })

  it('maps the capture artifacts into the concern inputs when the work item has a capture session', async () => {
    const pool = new FakeDispatchPool()
    pool.seedWorkItem({ capture_session_id: CAPTURE_SESSION_ID })
    pool.seedSupportPacket()
    pool.artifacts.push({
      id: ARTIFACT_ID,
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      kind: 'rrweb',
      storage_key: `${COMPANY_ID}/capture-sessions/${CAPTURE_SESSION_ID}/replay.json`,
      content_type: 'application/json',
      byte_size: 1024,
      duration_ms: null,
    })
    const { deps, responses } = makeDispatchDeps(pool, { audience: 'steve' })

    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), deps)

    expect(responses[0]?.status).toBe(201)
    const concern = pool.agentFeedConcerns[0]?.concern as JsonRecord
    const artifacts = (concern.inputs as JsonRecord).artifacts as JsonRecord[]
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ kind: 'rrweb', content_type: 'application/json', byte_size: 1024 })
    expect(String(artifacts[0]?.ref)).toContain(`/api/agent-feed/artifacts/${ARTIFACT_ID}`)
  })

  it('validates the work item id, audience, and existence', async () => {
    const pool = new FakeDispatchPool()
    const badId = makeDispatchDeps(pool, { audience: 'steve' })
    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl('not-a-uuid'), badId.deps)
    expect(badId.responses[0]).toMatchObject({ status: 400, body: { error: 'work item id must be a uuid' } })

    const noAudience = makeDispatchDeps(pool, {})
    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), noAudience.deps)
    expect(noAudience.responses[0]).toMatchObject({ status: 400, body: { error: 'audience is required' } })

    const missing = makeDispatchDeps(pool, { audience: 'steve' })
    await handleAdminWorkRequestRoutes(buildReq('POST'), dispatchUrl(), missing.deps)
    expect(missing.responses[0]).toMatchObject({ status: 404, body: { error: 'work item not found' } })
  })

  it('rejects non-POST methods on the dispatch path', async () => {
    const pool = new FakeDispatchPool()
    pool.seedWorkItem()
    const { deps, responses } = makeDispatchDeps(pool, { audience: 'steve' })

    await handleAdminWorkRequestRoutes(buildReq('GET'), dispatchUrl(), deps)

    expect(responses[0]).toMatchObject({ status: 405 })
  })
})

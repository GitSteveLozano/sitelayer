import { afterEach, describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'
import type { Readable } from 'node:stream'
import {
  agentFeedBaseUrl,
  handleAgentFeedRoutes,
  loadAgentFeedAudienceLiveness,
  mapCaptureArtifactsToConcernRefs,
  parseAgentFeedTokens,
  type AgentFeedRouteDeps,
} from './agent-feed.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '00000000-0000-4000-8000-000000000123'
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000456'
const WORK_ITEM_ID = '00000000-0000-4000-9000-000000000001'
const ARTIFACT_ID = '00000000-0000-4000-8000-00000000a001'
const STEVE_ARTIFACT_ID = '00000000-0000-4000-8000-00000000a002'

const TOKENS_ENV = JSON.stringify({ 'capture-analyzer': 'tok-analyzer', steve: 'tok-steve' })

type JsonRecord = Record<string, unknown>

type ConcernRow = {
  id: string
  company_id: string
  audience: string
  project_key: string
  concern_ref: string
  concern: JsonRecord
  status: string
  callback: JsonRecord | null
  work_item_id: string | null
  capture_session_id: string | null
  claimed_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

type ArtifactRow = {
  id: string
  company_id: string
  capture_session_id: string
  kind: string
  storage_key: string | null
  content_type: string | null
  metadata: JsonRecord
  deleted_at: string | null
}

type WorkItemRow = {
  id: string
  company_id: string
  support_packet_id: string
  domain: string
  title: string
  summary: string | null
  status: string
  lane: string
  severity: string | null
  route: string | null
  capture_session_id: string | null
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
  dedup_key: string | null
}

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  files = new Map<string, Buffer>()

  async put(key: string, contents: Buffer) {
    this.files.set(key, contents)
  }
  async putStream(key: string, body: Readable, _options?: PutStreamOptions) {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    this.files.set(key, Buffer.concat(chunks))
  }
  async get(key: string) {
    const buf = this.files.get(key)
    if (!buf) throw new Error(`missing ${key}`)
    return buf
  }
  async copy(sourceKey: string, destKey: string) {
    this.files.set(destKey, await this.get(sourceKey))
  }
  async deleteObject(key: string) {
    this.files.delete(key)
  }
  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions) {
    return null
  }
}

class FakeFeedPool {
  concerns: ConcernRow[] = []
  artifacts: ArtifactRow[] = []
  workItems: WorkItemRow[] = []
  handoffEvents: JsonRecord[] = []
  liveness = new Map<string, { audience: string; last_poll_at: string; updated_at: string }>()
  private concernCounter = 0
  private handoffCounter = 0
  private claimCounter = 0

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  seedWorkItem(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
    const row: WorkItemRow = {
      id: WORK_ITEM_ID,
      company_id: COMPANY_ID,
      support_packet_id: '00000000-0000-4000-8000-000000000301',
      domain: 'app_issue',
      title: 'Capture issue',
      summary: null,
      status: 'agent_running',
      lane: 'agent',
      severity: null,
      route: '/x',
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
      metadata: {},
      dedup_key: null,
      ...overrides,
    }
    this.workItems.push(row)
    return row
  }

  seedConcern(overrides: Partial<ConcernRow> = {}): ConcernRow {
    this.concernCounter += 1
    const ref = overrides.concern_ref ?? `capan:${SESSION_ID}`
    const row: ConcernRow = {
      id: `00000000-0000-4000-c000-${String(this.concernCounter).padStart(12, '0')}`,
      company_id: COMPANY_ID,
      audience: 'capture-analyzer',
      project_key: 'sitelayer',
      concern_ref: ref,
      concern: { schema_version: '1.4.0', concern_ref: ref, title: 'Analyze capture' },
      status: 'pending',
      callback: null,
      work_item_id: null,
      capture_session_id: null,
      claimed_at: null,
      completed_at: null,
      created_at: `2026-06-09T12:00:0${this.concernCounter}.000Z`,
      updated_at: `2026-06-09T12:00:0${this.concernCounter}.000Z`,
      ...overrides,
    }
    this.concerns.push(row)
    return row
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

    if (normalized.startsWith('insert into agent_feed_audience_liveness')) {
      const [audience] = params as [string]
      const row = {
        audience,
        last_poll_at: '2026-06-09T12:00:00.000Z',
        updated_at: '2026-06-09T12:00:00.000Z',
      }
      this.liveness.set(audience, row)
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('select audience, last_poll_at::text as last_poll_at')) {
      const [audience] = params as [string]
      const row = this.liveness.get(audience)
      return { rows: row ? [{ audience: row.audience, last_poll_at: row.last_poll_at }] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('select concern from agent_feed_concerns')) {
      const [audience, limit] = params as [string, number]
      const rows = this.concerns
        .filter((row) => row.audience === audience && row.status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((row) => ({ concern: row.concern }))
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('select id, company_id, audience, project_key, concern_ref, status')) {
      const [concernRef] = params as [string]
      const row = this.concerns.find((r) => r.concern_ref === concernRef)
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('update agent_feed_concerns') && normalized.includes("status = 'claimed'")) {
      const [id, companyId] = params as [string, string]
      const row = this.concerns.find((r) => r.id === id && r.company_id === companyId && r.status === 'pending')
      if (!row) return { rows: [], rowCount: 0 }
      this.claimCounter += 1
      row.status = 'claimed'
      // Distinct per claim instance, like Postgres now() — the re-claim
      // idempotency-key test depends on a fresh stamp per lease generation.
      row.claimed_at = `2026-06-09T12:01:${String(this.claimCounter).padStart(2, '0')}.000Z`
      row.updated_at = row.claimed_at
      return { rows: [{ id: row.id, claimed_at: row.claimed_at }], rowCount: 1 }
    }

    if (normalized.startsWith('update agent_feed_concerns') && normalized.includes('callback = $4::jsonb')) {
      const [id, companyId, status, callbackRaw, completedAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
      ]
      const row = this.concerns.find(
        (r) => r.id === id && r.company_id === companyId && (r.status === 'pending' || r.status === 'claimed'),
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.callback = JSON.parse(callbackRaw) as JsonRecord
      row.completed_at = completedAt ?? '2026-06-09T12:02:00.000Z'
      row.updated_at = '2026-06-09T12:02:00.000Z'
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (normalized.startsWith('update context_work_items') && normalized.includes('metadata = metadata ||')) {
      const [companyId, workItemId, patchRaw] = params as [string, string, string]
      const item = this.workItems.find((w) => w.company_id === companyId && w.id === workItemId)
      if (!item) return { rows: [], rowCount: 0 }
      item.metadata = { ...item.metadata, ...(JSON.parse(patchRaw) as JsonRecord) }
      item.updated_at = '2026-06-09T12:02:01.000Z'
      return { rows: [], rowCount: 1 }
    }

    // applyClaimEffects locked status/lane pre-read.
    if (normalized.startsWith('select status, lane from context_work_items')) {
      const [companyId, workItemId] = params as [string, string]
      const item = this.workItems.find((w) => w.company_id === companyId && w.id === workItemId)
      return { rows: item ? [{ status: item.status, lane: item.lane }] : [], rowCount: item ? 1 : 0 }
    }

    // applyTerminalCallbackEffects status pre-read.
    if (normalized.startsWith('select status from context_work_items')) {
      const [companyId, workItemId] = params as [string, string]
      const item = this.workItems.find((w) => w.company_id === companyId && w.id === workItemId)
      return { rows: item ? [{ status: item.status }] : [], rowCount: item ? 1 : 0 }
    }

    // updateContextWorkItemWithEventTx's locked full-row read.
    if (
      normalized.startsWith('select id, company_id, support_packet_id, domain') &&
      normalized.includes('for update')
    ) {
      const [companyId, workItemId] = params as [string, string]
      const item = this.workItems.find((w) => w.company_id === companyId && w.id === workItemId)
      return { rows: item ? [{ ...item, expires_at: null }] : [], rowCount: item ? 1 : 0 }
    }

    // updateContextWorkItemWithEventTx's status/lane write.
    if (normalized.startsWith('update context_work_items') && normalized.includes('set status = $3')) {
      const [companyId, workItemId, status, lane, assigneeUserId, resolvedAt, reversedAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
      const item = this.workItems.find((w) => w.company_id === companyId && w.id === workItemId)
      if (!item) return { rows: [], rowCount: 0 }
      item.status = status
      item.lane = lane
      item.assignee_user_id = assigneeUserId
      item.resolved_at = resolvedAt
      item.reversed_at = reversedAt
      item.updated_at = '2026-06-09T12:02:03.000Z'
      return { rows: [{ ...item, expires_at: null }], rowCount: 1 }
    }

    // appendContextHandoffEventTx idempotent-replay lookup.
    if (normalized.includes('from context_handoff_events') && normalized.includes('idempotency_key = $2')) {
      const [companyId, idempotencyKey] = params as [string, string]
      const row = this.handoffEvents.find((e) => e.company_id === companyId && e.idempotency_key === idempotencyKey)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('insert into context_handoff_events')) {
      const idempotencyKey = (params[9] as string | null) ?? null
      const existing = idempotencyKey
        ? this.handoffEvents.find((e) => e.company_id === params[0] && e.idempotency_key === idempotencyKey)
        : null
      if (existing) return { rows: [], rowCount: 0 }
      this.handoffCounter += 1
      const row = {
        id: `00000000-0000-4000-a000-${String(this.handoffCounter).padStart(12, '0')}`,
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
        occurred_at: '2026-06-09T12:02:02.000Z',
        recorded_at: '2026-06-09T12:02:02.000Z',
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('select a.id, a.company_id, a.kind, a.storage_key')) {
      const [artifactId, audience] = params as [string, string]
      const artifact = this.artifacts.find((a) => a.id === artifactId && a.deleted_at === null)
      if (!artifact) return { rows: [], rowCount: 0 }
      const authorized = this.concerns.some(
        (c) =>
          c.audience === audience &&
          c.company_id === artifact.company_id &&
          c.capture_session_id === artifact.capture_session_id,
      )
      if (!authorized) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            id: artifact.id,
            company_id: artifact.company_id,
            kind: artifact.kind,
            storage_key: artifact.storage_key,
            content_type: artifact.content_type,
            metadata: artifact.metadata,
          },
        ],
        rowCount: 1,
      }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 200)}`)
  }
}

function req(method: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, headers } as http.IncomingMessage
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function makeDeps(
  pool: FakeFeedPool,
  opts: { body?: Record<string, unknown>; tokensEnv?: string | undefined; storage?: MemoryStorage } = {},
) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const files: Array<{ mimeType: string; fileName: string; content: Buffer | string }> = []
  const storage = opts.storage ?? new MemoryStorage()
  const deps: AgentFeedRouteDeps = {
    pool: pool as unknown as Pool,
    storage,
    sendJson: (status, body) => responses.push({ status, body }),
    readBody: async () => opts.body ?? {},
    sendFileContent: (mimeType, fileName, content) => files.push({ mimeType, fileName, content }),
    tokensEnv: 'tokensEnv' in opts ? opts.tokensEnv : TOKENS_ENV,
  }
  return { deps, responses, files, storage }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function terminalCallback(concernRef: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.4.0',
    concern_ref: concernRef,
    status: 'succeeded',
    completed_at: '2026-06-09T12:02:00.000Z',
    ...overrides,
  }
}

describe('parseAgentFeedTokens', () => {
  it('returns null for unset / invalid / empty maps (feed off, fail loud)', () => {
    expect(parseAgentFeedTokens(undefined)).toBeNull()
    expect(parseAgentFeedTokens('')).toBeNull()
    expect(parseAgentFeedTokens('not-json')).toBeNull()
    expect(parseAgentFeedTokens('[]')).toBeNull()
    expect(parseAgentFeedTokens('{}')).toBeNull()
    expect(parseAgentFeedTokens('{"steve": ""}')).toBeNull()
  })

  it('parses a valid audience -> token map', () => {
    const tokens = parseAgentFeedTokens(TOKENS_ENV)
    expect(tokens?.get('steve')).toBe('tok-steve')
    expect(tokens?.get('capture-analyzer')).toBe('tok-analyzer')
  })
})

describe('mapCaptureArtifactsToConcernRefs', () => {
  it('maps stored capture kinds to the analyzer vocabulary with absolute refs', () => {
    const refs = mapCaptureArtifactsToConcernRefs(
      [
        { id: 'a1', kind: 'rrweb', content_type: 'application/json', byte_size: '1024', duration_ms: null },
        { id: 'a2', kind: 'audio', content_type: 'audio/webm', byte_size: 2048, duration_ms: 9000 },
        { id: 'a3', kind: 'video', content_type: 'video/webm', byte_size: 4096, duration_ms: 9000 },
        { id: 'a4', kind: 'screenshot', content_type: 'image/png', byte_size: 512, duration_ms: null },
        { id: 'a5', kind: 'image', content_type: 'image/png', byte_size: 256, duration_ms: null },
        { id: 'a6', kind: 'repro_bracket', content_type: 'application/json', byte_size: 64, duration_ms: null },
      ],
      'https://app.example.com',
    )
    expect(refs.map((r) => r.kind)).toEqual(['rrweb', 'audio', 'video', 'screenshot', 'screenshot', 'repro_bracket'])
    expect(refs[0]).toEqual({
      kind: 'rrweb',
      ref: 'https://app.example.com/api/agent-feed/artifacts/a1',
      content_type: 'application/json',
      byte_size: 1024,
    })
    expect(refs[1]).toMatchObject({ byte_size: 2048, duration_ms: 9000 })
  })
})

describe('agent feed auth', () => {
  it('answers 503 on every route when AGENT_FEED_TOKENS is unset (fail loud, not open)', async () => {
    const pool = new FakeFeedPool()
    pool.seedConcern()
    const { deps, responses } = makeDeps(pool, { tokensEnv: undefined })

    const handled = await handleAgentFeedRoutes(
      req('GET', bearer('tok-analyzer')),
      url('/api/agent-feed/concerns?audience=capture-analyzer'),
      deps,
    )

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(503)

    const cb = await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)
    expect(cb).toBe(true)
    expect(responses[1]?.status).toBe(503)
  })

  it('rejects a missing or unknown bearer token with 401', async () => {
    const pool = new FakeFeedPool()
    const { deps, responses } = makeDeps(pool)

    await handleAgentFeedRoutes(req('GET'), url('/api/agent-feed/concerns?audience=steve'), deps)
    await handleAgentFeedRoutes(req('GET', bearer('wrong-token')), url('/api/agent-feed/concerns?audience=steve'), deps)

    expect(responses[0]?.status).toBe(401)
    expect(responses[1]?.status).toBe(401)
  })

  it('refuses a GET for an audience the token does not grant (403)', async () => {
    const pool = new FakeFeedPool()
    pool.seedConcern({ audience: 'steve', concern_ref: 'wi:x:steve' })
    const { deps, responses } = makeDeps(pool)

    await handleAgentFeedRoutes(
      req('GET', bearer('tok-analyzer')),
      url('/api/agent-feed/concerns?audience=steve'),
      deps,
    )

    expect(responses[0]?.status).toBe(403)
  })

  it('does not handle non-agent-feed paths', async () => {
    const pool = new FakeFeedPool()
    const { deps, responses } = makeDeps(pool)
    const handled = await handleAgentFeedRoutes(req('GET', bearer('tok-steve')), url('/api/projects'), deps)
    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
  })
})

describe('GET /api/agent-feed/concerns', () => {
  it('lists only pending concerns for the token audience, oldest first', async () => {
    const pool = new FakeFeedPool()
    pool.seedConcern({ concern_ref: 'capan:claimed', status: 'claimed' })
    pool.seedConcern({ concern_ref: 'capan:done', status: 'succeeded' })
    const pending = pool.seedConcern({ concern_ref: 'capan:pending' })
    pool.seedConcern({ audience: 'steve', concern_ref: 'wi:x:steve' })
    const { deps, responses } = makeDeps(pool)

    await handleAgentFeedRoutes(
      req('GET', bearer('tok-analyzer')),
      url('/api/agent-feed/concerns?audience=capture-analyzer'),
      deps,
    )

    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { concerns: JsonRecord[] }
    expect(body.concerns).toHaveLength(1)
    expect(body.concerns[0]?.concern_ref).toBe(pending.concern_ref)
    expect(pool.liveness.get('capture-analyzer')).toMatchObject({
      audience: 'capture-analyzer',
      last_poll_at: '2026-06-09T12:00:00.000Z',
    })
    await expect(
      loadAgentFeedAudienceLiveness(pool as unknown as Pool, 'capture-analyzer', Date.parse('2026-06-09T12:00:30Z')),
    ).resolves.toMatchObject({
      audience: 'capture-analyzer',
      last_poll_age_seconds: 30,
      live: true,
    })
  })
})

describe('POST /api/agent-feed/callbacks — claim semantics', () => {
  it('claims a pending concern on the first accepted callback (202) and 409s the second', async () => {
    const pool = new FakeFeedPool()
    const row = pool.seedConcern()
    const claim = { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' }

    const first = makeDeps(pool, { body: claim })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), first.deps)
    expect(first.responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('claimed')
    expect(pool.concerns[0]?.claimed_at).not.toBeNull()

    const second = makeDeps(pool, { body: claim })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), second.deps)
    expect(second.responses[0]?.status).toBe(409)
  })

  it('a claim acknowledges the dispatch: agent.dispatch_acknowledged + status agent_running (reconciler-visible)', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'triaged', lane: 'triage' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('claimed')
    // EXACTLY the (status, event) pair the work-dispatch-reconciler's
    // candidate query requires (status='agent_running' + a latest
    // agent.dispatch_acknowledged event), so the L4 safety net covers
    // agent-feed work the same as mesh dispatches.
    expect(pool.workItems[0]?.status).toBe('agent_running')
    expect(pool.workItems[0]?.lane).toBe('agent')
    expect(pool.handoffEvents).toHaveLength(1)
    expect(pool.handoffEvents[0]).toMatchObject({
      work_item_id: WORK_ITEM_ID,
      event_type: 'agent.dispatch_acknowledged',
      actor_kind: 'agent',
      actor_ref: 'agent-feed:steve',
      // Salted with the lease instance (claimed_at) so a re-claim after a
      // lease-sweep requeue stamps its OWN auditable ack event.
      idempotency_key: `agent_feed:${row.concern_ref}:claim:${pool.concerns[0]?.claimed_at}`,
    })
  })

  it("a claim preserves lane 'both' when a human co-watches (projectkit deriveTransition)", async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'proposal_expired', lane: 'both' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.workItems[0]?.status).toBe('agent_running')
    // Canonical agent.dispatch_acknowledged: lane stays 'both' when a human
    // is co-watching — never clobbered to 'agent'.
    expect(pool.workItems[0]?.lane).toBe('both')
  })

  it('an analyzer claim appends the ack event but never advances the work item (enrichment lane)', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'new', lane: 'triage' })
    const row = pool.seedConcern({ work_item_id: WORK_ITEM_ID, capture_session_id: SESSION_ID })
    const { deps, responses } = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('claimed')
    // The enrichment lane never owns the item: a fresh capture issue must NOT
    // flip to agent_running just because the analyzer claimed its concern.
    expect(pool.workItems[0]?.status).toBe('new')
    expect(pool.workItems[0]?.lane).toBe('triage')
    expect(pool.handoffEvents).toHaveLength(1)
    expect(pool.handoffEvents[0]).toMatchObject({
      event_type: 'agent.dispatch_acknowledged',
      actor_ref: 'agent-feed:capture-analyzer',
    })
    expect((pool.handoffEvents[0]?.payload as JsonRecord).status).toBeUndefined()
  })

  it('a re-claim after a lease-sweep requeue records its own ack event (distinct idempotency key)', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'triaged', lane: 'triage' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      work_item_id: WORK_ITEM_ID,
    })
    const claim = { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' }

    const first = makeDeps(pool, { body: claim })
    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), first.deps)
    expect(first.responses[0]?.status).toBe(202)
    const firstKey = pool.handoffEvents[0]?.idempotency_key

    // The lease sweep requeues the wedged claim: pending again, lease cleared.
    pool.concerns[0]!.status = 'pending'
    pool.concerns[0]!.claimed_at = null

    const second = makeDeps(pool, { body: claim })
    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), second.deps)
    expect(second.responses[0]?.status).toBe(202)

    // The second lease generation is auditable: a NEW ack event, not an
    // idempotency-conflict no-op against the first claim's key.
    expect(pool.handoffEvents).toHaveLength(2)
    expect(pool.handoffEvents[1]?.idempotency_key).not.toBe(firstKey)
    expect(pool.handoffEvents[1]).toMatchObject({ event_type: 'agent.dispatch_acknowledged' })
  })

  it('a claim on a work item a human already resolved keeps the resolution (event only)', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'resolved', lane: 'done', resolved_at: '2026-06-09T12:00:00.000Z' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('claimed')
    expect(pool.workItems[0]?.status).toBe('resolved')
    expect(pool.handoffEvents[0]).toMatchObject({ event_type: 'agent.dispatch_acknowledged' })
  })

  it('404s an unknown concern_ref and 400s an invalid callback body', async () => {
    const pool = new FakeFeedPool()
    const unknown = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: 'capan:nope', status: 'accepted' },
    })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), unknown.deps)
    expect(unknown.responses[0]?.status).toBe(404)

    const invalid = makeDeps(pool, { body: { status: 'accepted' } })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), invalid.deps)
    expect(invalid.responses[0]?.status).toBe(400)
  })

  it("refuses a callback against another audience's concern (403)", async () => {
    const pool = new FakeFeedPool()
    const row = pool.seedConcern({ audience: 'steve', concern_ref: 'wi:x:steve' })
    const { deps, responses } = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(403)
    expect(pool.concerns[0]?.status).toBe('pending')
  })
})

describe('POST /api/agent-feed/callbacks — terminal post-processing', () => {
  it('stores a succeeded analyzer callback, writes metadata.capture_analysis, and appends a handoff event', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'new', lane: 'triage', metadata: { source: 'x' } })
    const row = pool.seedConcern({
      status: 'claimed',
      work_item_id: WORK_ITEM_ID,
      capture_session_id: SESSION_ID,
    })
    const callback = terminalCallback(row.concern_ref, {
      outputs: { stdout: '# Analysis\n\nThe replay shows the failure.' },
      artifacts: [{ kind: 'report', ref: 'capan-report-1' }],
    })
    const { deps, responses } = makeDeps(pool, { body: callback })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('succeeded')
    expect(pool.concerns[0]?.callback).toMatchObject({ status: 'succeeded' })
    expect(pool.concerns[0]?.completed_at).toBe('2026-06-09T12:02:00.000Z')

    const analysis = pool.workItems[0]?.metadata.capture_analysis as JsonRecord
    expect(analysis).toMatchObject({
      markdown: '# Analysis\n\nThe replay shows the failure.',
      completed_at: '2026-06-09T12:02:00.000Z',
    })
    expect(analysis.artifacts).toEqual([{ kind: 'report', ref: 'capan-report-1' }])

    expect(pool.handoffEvents).toHaveLength(1)
    expect(pool.handoffEvents[0]).toMatchObject({
      work_item_id: WORK_ITEM_ID,
      event_type: 'agent.artifact_attached',
      actor_kind: 'agent',
      actor_ref: 'agent-feed:capture-analyzer',
      idempotency_key: `agent_feed:${row.concern_ref}:terminal`,
    })
    // The analysis is enrichment evidence — it never advances the work item.
    expect(pool.workItems[0]?.status).toBe('new')
  })

  it('REGRESSION: analyzer claim + succeeded callback leaves status untouched while writing capture_analysis', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'new', lane: 'triage' })
    const row = pool.seedConcern({ work_item_id: WORK_ITEM_ID, capture_session_id: SESSION_ID })

    // 1. The pull-executor claims with 'accepted' BEFORE working.
    const claim = makeDeps(pool, {
      body: { schema_version: '1.4.0', concern_ref: row.concern_ref, status: 'accepted' },
    })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), claim.deps)
    expect(claim.responses[0]?.status).toBe(202)
    expect(pool.workItems[0]?.status).toBe('new')

    // 2. The analyzer succeeds: write-back only, no lifecycle move needed.
    const terminal = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { outputs: { stdout: '# Analysis' } }),
    })
    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), terminal.deps)
    expect(terminal.responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('succeeded')

    // The item never visited agent_running and is NOT stranded there: it is
    // still triage-able exactly where the capture finalize left it.
    expect(pool.workItems[0]?.status).toBe('new')
    expect(pool.workItems[0]?.lane).toBe('triage')
    expect((pool.workItems[0]?.metadata.capture_analysis as JsonRecord).markdown).toBe('# Analysis')
    expect(pool.handoffEvents.map((e) => e.event_type)).toEqual([
      'agent.dispatch_acknowledged',
      'agent.artifact_attached',
    ])
  })

  it('a failed analyzer callback annotates the timeline without moving the work item', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'new', lane: 'triage' })
    const row = pool.seedConcern({ status: 'claimed', work_item_id: WORK_ITEM_ID })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { status: 'failed', error: 'analyzer crashed' }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('failed')
    // A failed enrichment leg is NOT a proposal_expired work item.
    expect(pool.workItems[0]?.status).toBe('new')
    expect(pool.workItems[0]?.lane).toBe('triage')
    expect(pool.workItems[0]?.metadata.capture_analysis).toBeUndefined()
    expect(pool.handoffEvents[0]).toMatchObject({ event_type: 'agent.message_received' })
    expect((pool.handoffEvents[0]?.payload as JsonRecord).error).toBe('analyzer crashed')
  })

  it('caps the persisted analysis markdown at ~64KB', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'new', lane: 'triage' })
    const row = pool.seedConcern({ status: 'claimed', work_item_id: WORK_ITEM_ID })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { outputs: { stdout: 'x'.repeat(100_000) } }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    const analysis = pool.workItems[0]?.metadata.capture_analysis as { markdown: string }
    expect(analysis.markdown).toHaveLength(64 * 1024)
  })

  it('a steve succeeded callback appends agent.completed AND advances the work item to review_ready', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'agent_running', lane: 'agent' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      status: 'claimed',
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { outputs: { stdout: 'fixed it' } }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('succeeded')
    // No analyzer metadata write for the steve lane.
    expect(pool.workItems[0]?.metadata.capture_analysis).toBeUndefined()
    // The RETURN leg: agents only ever reach review_ready — a human resolves.
    expect(pool.workItems[0]?.status).toBe('review_ready')
    expect(pool.workItems[0]?.lane).toBe('both')
    expect(pool.handoffEvents[0]).toMatchObject({
      event_type: 'agent.completed',
      actor_ref: 'agent-feed:steve',
      idempotency_key: `agent_feed:${row.concern_ref}:terminal`,
    })
    expect((pool.handoffEvents[0]?.payload as JsonRecord).status).toBe('review_ready')
  })

  it('a failed callback appends agent.failed with the error and un-strands agent_running', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'agent_running', lane: 'agent' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      status: 'claimed',
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { status: 'failed', error: 'agent blew up', error_code: 'execution' }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.concerns[0]?.status).toBe('failed')
    // Not stranded in agent_running: back to the triage-able state the
    // reconciler/stale sweeps use for a dead agent leg.
    expect(pool.workItems[0]?.status).toBe('proposal_expired')
    expect(pool.workItems[0]?.lane).toBe('both')
    // The failure is its own lifecycle event — agent.message_received stays a
    // pure annotation per the projectkit reducer; the move rides agent.failed.
    expect(pool.handoffEvents[0]).toMatchObject({ event_type: 'agent.failed' })
    expect((pool.handoffEvents[0]?.payload as JsonRecord).error).toBe('agent blew up')
    expect((pool.handoffEvents[0]?.payload as JsonRecord).error_code).toBe('execution')
  })

  it('a late terminal callback never reverses a human decision (resolved stays resolved)', async () => {
    const pool = new FakeFeedPool()
    pool.seedWorkItem({ status: 'resolved', lane: 'done', resolved_at: '2026-06-09T12:00:00.000Z' })
    const row = pool.seedConcern({
      audience: 'steve',
      concern_ref: `wi:${WORK_ITEM_ID}:steve`,
      status: 'claimed',
      work_item_id: WORK_ITEM_ID,
    })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { outputs: { stdout: 'done late' } }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-steve')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(pool.workItems[0]?.status).toBe('resolved')
    // The result still lands on the timeline.
    expect(pool.handoffEvents[0]).toMatchObject({ event_type: 'agent.completed' })
  })

  it('replays a duplicate terminal callback for an already-terminal concern', async () => {
    const pool = new FakeFeedPool()
    const row = pool.seedConcern({ status: 'succeeded' })
    const { deps, responses } = makeDeps(pool, { body: terminalCallback(row.concern_ref) })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(202)
    expect(responses[0]?.body).toMatchObject({
      ok: true,
      concern_ref: row.concern_ref,
      status: 'succeeded',
      replayed: true,
    })
    expect(pool.concerns[0]?.status).toBe('succeeded')
  })

  it('409s a conflicting terminal callback for an already-terminal concern', async () => {
    const pool = new FakeFeedPool()
    const row = pool.seedConcern({ status: 'succeeded' })
    const { deps, responses } = makeDeps(pool, {
      body: terminalCallback(row.concern_ref, { status: 'failed', error: 'late conflicting result' }),
    })

    await handleAgentFeedRoutes(req('POST', bearer('tok-analyzer')), url('/api/agent-feed/callbacks'), deps)

    expect(responses[0]?.status).toBe(409)
    expect(pool.concerns[0]?.status).toBe('succeeded')
  })
})

describe('GET /api/agent-feed/artifacts/:artifactId', () => {
  function seedArtifact(pool: FakeFeedPool, storage: MemoryStorage) {
    const storageKey = `${COMPANY_ID}/capture-sessions/${SESSION_ID}/replay.json`
    storage.files.set(storageKey, Buffer.from('{"rrweb":true}'))
    pool.artifacts.push({
      id: ARTIFACT_ID,
      company_id: COMPANY_ID,
      capture_session_id: SESSION_ID,
      kind: 'rrweb',
      storage_key: storageKey,
      content_type: 'application/json',
      metadata: { file_name: 'replay.json' },
      deleted_at: null,
    })
  }

  it('streams the artifact bytes with the stored content-type for an authorized audience', async () => {
    const pool = new FakeFeedPool()
    const storage = new MemoryStorage()
    seedArtifact(pool, storage)
    pool.seedConcern({ capture_session_id: SESSION_ID })
    const { deps, responses, files } = makeDeps(pool, { storage })

    const handled = await handleAgentFeedRoutes(
      req('GET', bearer('tok-analyzer')),
      url(`/api/agent-feed/artifacts/${ARTIFACT_ID}`),
      deps,
    )

    expect(handled).toBe(true)
    expect(responses).toHaveLength(0)
    expect(files[0]).toMatchObject({ mimeType: 'application/json', fileName: 'replay.json' })
    expect(files[0]?.content.toString()).toBe('{"rrweb":true}')
  })

  it("denies an artifact whose session is not referenced by the caller's audience (404)", async () => {
    const pool = new FakeFeedPool()
    const storage = new MemoryStorage()
    seedArtifact(pool, storage)
    // The analyzer has a concern on this session; steve only has one on ANOTHER
    // session, so steve must not be able to fetch this artifact.
    pool.seedConcern({ capture_session_id: SESSION_ID })
    pool.seedConcern({ audience: 'steve', concern_ref: 'wi:y:steve', capture_session_id: OTHER_SESSION_ID })
    const { deps, responses, files } = makeDeps(pool, { storage })

    await handleAgentFeedRoutes(req('GET', bearer('tok-steve')), url(`/api/agent-feed/artifacts/${ARTIFACT_ID}`), deps)

    expect(files).toHaveLength(0)
    expect(responses[0]?.status).toBe(404)
  })

  it('serves the artifact to steve once a steve concern references its session', async () => {
    const pool = new FakeFeedPool()
    const storage = new MemoryStorage()
    const storageKey = `${COMPANY_ID}/capture-sessions/${SESSION_ID}/screen-video.webm`
    storage.files.set(storageKey, Buffer.from('webm-bytes'))
    pool.artifacts.push({
      id: STEVE_ARTIFACT_ID,
      company_id: COMPANY_ID,
      capture_session_id: SESSION_ID,
      kind: 'video',
      storage_key: storageKey,
      content_type: 'video/webm',
      metadata: {},
      deleted_at: null,
    })
    pool.seedConcern({ audience: 'steve', concern_ref: `wi:${WORK_ITEM_ID}:steve`, capture_session_id: SESSION_ID })
    const { deps, files } = makeDeps(pool, { storage })

    await handleAgentFeedRoutes(
      req('GET', bearer('tok-steve')),
      url(`/api/agent-feed/artifacts/${STEVE_ARTIFACT_ID}`),
      deps,
    )

    expect(files[0]).toMatchObject({ mimeType: 'video/webm', fileName: 'screen-video.webm' })
  })

  it('400s a non-uuid artifact id', async () => {
    const pool = new FakeFeedPool()
    const { deps, responses } = makeDeps(pool)
    await handleAgentFeedRoutes(req('GET', bearer('tok-steve')), url('/api/agent-feed/artifacts/not-a-uuid'), deps)
    expect(responses[0]?.status).toBe(400)
  })
})

describe('agentFeedBaseUrl', () => {
  const saved: Record<string, string | undefined> = {}
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('explicit APP_PUBLIC_URL wins and is trimmed of trailing slashes', () => {
    setEnv('APP_PUBLIC_URL', 'https://example.test///')
    expect(agentFeedBaseUrl()).toBe('https://example.test')
  })

  it('falls back per tier so non-prod tiers never mint prod refs', () => {
    setEnv('APP_PUBLIC_URL', undefined)
    setEnv('APP_TIER', 'dev')
    expect(agentFeedBaseUrl()).toBe('https://dev.sitelayer.sandolab.xyz')
    setEnv('APP_TIER', 'demo')
    expect(agentFeedBaseUrl()).toBe('https://demo.preview.sitelayer.sandolab.xyz')
    setEnv('APP_TIER', 'prod')
    expect(agentFeedBaseUrl()).toBe('https://sitelayer.sandolab.xyz')
    setEnv('APP_TIER', 'local')
    expect(agentFeedBaseUrl()).toBe('http://localhost:3001')
  })
})

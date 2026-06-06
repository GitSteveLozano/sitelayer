import type http from 'node:http'
import { describe, expect, it, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import {
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  workflowEventRef,
} from '@sitelayer/workflows'
import { attachMutationTx } from '../mutation-tx.js'
import { handleAnchorRoutes, type AnchorRouteCtx } from './anchors.js'

// ---------------------------------------------------------------------------
// GET /api/anchors/:eventRef (+ ?to=) — the one-string anchor lookup surface.
// Covers: token gate, single-anchor resolve (event-log row + capture session +
// artifacts + deterministic replay), the from/to clip range, and the
// not-found / not-an-anchor error paths. The handler is a read-only projection
// so the FakePool just routes the queries it issues to in-memory fixtures.
// ---------------------------------------------------------------------------

const COMPANY_ID = '00000000-0000-4000-8000-000000000abc'
const ENTITY_ID = '11111111-2222-3333-4444-555555555555'
const CAPTURE_SESSION_ID = '99999999-8888-7777-6666-555555555555'
const TOKEN = 'test-debug-token'

type EventLogFixture = {
  id: string
  company_id: string
  workflow_name: string
  schema_version: number
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  event_payload: Record<string, unknown>
  snapshot_after: Record<string, unknown>
  actor_user_id: string | null
  applied_at: string
  request_id: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  capture_session_id: string | null
}

type CaptureSessionFixture = {
  id: string
  company_id: string
  mode: string
  status: string
  route_path: string | null
  started_at: string
  last_seen_at: string
  stopped_at: string | null
}

type CaptureArtifactFixture = {
  id: string
  company_id: string
  capture_session_id: string
  kind: string
  content_type: string | null
  byte_size: string | null
  duration_ms: number | null
  pii_level: string | null
  access_policy: string | null
  created_at: string
  deleted_at: string | null
}

type CaptureMarkFixture = {
  id: string
  company_id: string
  capture_session_id: string
  event_type: string
  occurred_at: string
  route_path: string | null
  event_ref: string
}

class FakePool {
  eventLog: EventLogFixture[] = []
  sessions: CaptureSessionFixture[] = []
  artifacts: CaptureArtifactFixture[] = []
  marks: CaptureMarkFixture[] = []

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
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // Anchor resolve: by (workflow_name, state_version).
    if (/from workflow_event_log/i.test(sql) && /and state_version = \$3/i.test(sql)) {
      const [companyId, workflowName, stateVersion] = params as [string, string, number]
      const rows = this.eventLog.filter(
        (r) => r.company_id === companyId && r.workflow_name === workflowName && r.state_version === stateVersion,
      )
      return { rows, rowCount: rows.length }
    }

    // Entity bracket: by (workflow_name, entity_type, entity_id).
    if (/from workflow_event_log/i.test(sql) && /entity_id = \$4::uuid/i.test(sql)) {
      const [companyId, workflowName, entityType, entityId] = params as [string, string, string, string]
      const rows = this.eventLog
        .filter(
          (r) =>
            r.company_id === companyId &&
            r.workflow_name === workflowName &&
            r.entity_type === entityType &&
            r.entity_id === entityId,
        )
        .sort((a, b) => a.state_version - b.state_version)
      return { rows, rowCount: rows.length }
    }

    if (/from capture_sessions/i.test(sql)) {
      const [companyId, sessionId] = params as [string, string]
      const rows = this.sessions.filter((s) => s.company_id === companyId && s.id === sessionId)
      return { rows, rowCount: rows.length }
    }

    if (/from capture_artifacts/i.test(sql)) {
      const [companyId, sessionId] = params as [string, string]
      const rows = this.artifacts.filter(
        (a) => a.company_id === companyId && a.capture_session_id === sessionId && a.deleted_at === null,
      )
      return { rows, rowCount: rows.length }
    }

    if (/from capture_session_events/i.test(sql)) {
      const [companyId, ref] = params as [string, string]
      const rows = this.marks.filter((m) => m.company_id === companyId && m.event_ref === ref)
      return { rows, rowCount: rows.length }
    }

    throw new Error(`unexpected SQL in anchors test: ${sql.slice(0, 80)}`)
  }
}

function buildCtx(
  pool: FakePool,
  path: string,
  opts: { token?: string | null; to?: string } = {},
): { ctx: AnchorRouteCtx; captured: { status: number; body: unknown }[]; headers: Record<string, string> } {
  const captured: { status: number; body: unknown }[] = []
  const headers: Record<string, string> = {}
  const search = opts.to ? `?to=${encodeURIComponent(opts.to)}` : ''
  const url = new URL(`http://localhost${path}${search}`)
  const token = opts.token === undefined ? TOKEN : opts.token
  const req = {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as http.IncomingMessage
  const ctx: AnchorRouteCtx = {
    pool: pool as unknown as Pool,
    company: { id: COMPANY_ID, slug: 'acme', name: 'Acme', role: 'admin' } as AnchorRouteCtx['company'],
    tier: 'dev',
    requestId: 'req-1',
    req,
    url,
    sendJson: (status, body) => captured.push({ status, body }),
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value
    },
  }
  return { ctx, captured, headers }
}

function approveEventLogRow(stateVersion: number): EventLogFixture {
  return {
    id: `evt-${stateVersion}`,
    company_id: COMPANY_ID,
    workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
    schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
    entity_type: 'rental_billing_run',
    entity_id: ENTITY_ID,
    state_version: stateVersion,
    event_type: 'APPROVE',
    event_payload: { type: 'APPROVE', approved_at: '2026-06-06T00:00:00.000Z', approved_by: 'u-1' },
    snapshot_after: {
      state: 'approved',
      state_version: stateVersion + 1,
      approved_at: '2026-06-06T00:00:00.000Z',
      approved_by: 'u-1',
      error: null,
      failed_at: null,
    },
    actor_user_id: 'u-1',
    applied_at: '2026-06-06T00:00:01.000Z',
    request_id: 'req-evt',
    sentry_trace: 'abc123-def-1',
    sentry_baggage: null,
    capture_session_id: CAPTURE_SESSION_ID,
  }
}

function anchorOf(stateVersion: number): string {
  return workflowEventRef({
    workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
    entity_id: ENTITY_ID,
    state_version: stateVersion,
  })
}

describe('handleAnchorRoutes', () => {
  beforeEach(() => {
    process.env.DEBUG_TRACE_TOKEN = TOKEN
    delete process.env.DEBUG_ALLOW_PROD
  })

  it('404s with no DEBUG_TRACE_TOKEN configured (endpoint hidden)', async () => {
    delete process.env.DEBUG_TRACE_TOKEN
    const pool = new FakePool()
    pool.attach()
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`)
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(404)
  })

  it('401s on a wrong bearer token', async () => {
    const pool = new FakePool()
    pool.attach()
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`, { token: 'nope' })
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(401)
  })

  it('400s a string that is not a workflow_event anchor', async () => {
    const pool = new FakePool()
    pool.attach()
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent('not-an-anchor')}`)
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(400)
  })

  it('404s when no event-log row matches the anchor', async () => {
    const pool = new FakePool()
    pool.attach()
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`)
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(404)
  })

  it('resolves a single anchor → row + capture session + artifacts + clean replay', async () => {
    const pool = new FakePool()
    pool.attach()
    pool.eventLog.push(approveEventLogRow(0))
    pool.sessions.push({
      id: CAPTURE_SESSION_ID,
      company_id: COMPANY_ID,
      mode: 'feedback',
      status: 'stopped',
      route_path: '/rentals/1/billing',
      started_at: '2026-06-06T00:00:00.000Z',
      last_seen_at: '2026-06-06T00:00:05.000Z',
      stopped_at: '2026-06-06T00:00:05.000Z',
    })
    pool.artifacts.push({
      id: 'art-1',
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      kind: 'rrweb',
      content_type: 'application/json',
      byte_size: '1024',
      duration_ms: 5000,
      pii_level: 'private',
      access_policy: 'support_only',
      created_at: '2026-06-06T00:00:04.000Z',
      deleted_at: null,
    })
    pool.marks.push({
      id: 'mark-1',
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      event_type: 'workflow.transition',
      occurred_at: '2026-06-06T00:00:02.000Z',
      route_path: '/rentals/1/billing',
      event_ref: anchorOf(0),
    })

    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`)
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]!.body as {
      anchor: {
        event_ref: string
        workflow_name: string
        to_state: string
        sentry_trace: string | null
        capture_session_id: string | null
        marks: unknown[]
      }
      capture_session: { id: string; artifacts: { id: string; file_url: string }[] } | null
      replay: { available: boolean; ok: boolean | null }
    }
    expect(body.anchor.event_ref).toBe(anchorOf(0))
    expect(body.anchor.workflow_name).toBe(RENTAL_BILLING_WORKFLOW_NAME)
    expect(body.anchor.to_state).toBe('approved')
    expect(body.anchor.sentry_trace).toBe('abc123-def-1')
    expect(body.anchor.capture_session_id).toBe(CAPTURE_SESSION_ID)
    expect(body.anchor.marks).toHaveLength(1)
    expect(body.capture_session?.id).toBe(CAPTURE_SESSION_ID)
    expect(body.capture_session?.artifacts[0]?.file_url).toBe(
      `/api/capture-sessions/${CAPTURE_SESSION_ID}/artifacts/art-1/file`,
    )
    // The deterministic replay re-ran the bracket through the real reducer.
    expect(body.replay.available).toBe(true)
    expect(body.replay.ok).toBe(true)
  })

  it('resolves a from/to pair → a clip range over the same session', async () => {
    const pool = new FakePool()
    pool.attach()
    pool.eventLog.push(approveEventLogRow(0))
    // A second transition on the same entity at state_version 1.
    pool.eventLog.push({
      ...approveEventLogRow(1),
      event_type: 'POST_REQUESTED',
      event_payload: { type: 'POST_REQUESTED' },
      snapshot_after: { state: 'posting', state_version: 2, error: null, failed_at: null },
    })
    pool.sessions.push({
      id: CAPTURE_SESSION_ID,
      company_id: COMPANY_ID,
      mode: 'feedback',
      status: 'stopped',
      route_path: '/rentals/1/billing',
      started_at: '2026-06-06T00:00:00.000Z',
      last_seen_at: '2026-06-06T00:00:10.000Z',
      stopped_at: '2026-06-06T00:00:10.000Z',
    })
    pool.artifacts.push({
      id: 'art-audio',
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      kind: 'audio',
      content_type: 'audio/webm',
      byte_size: '4096',
      duration_ms: 10000,
      pii_level: 'private',
      access_policy: 'support_only',
      created_at: '2026-06-06T00:00:09.000Z',
      deleted_at: null,
    })
    pool.marks.push(
      {
        id: 'mark-from',
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:02.000Z',
        route_path: '/rentals/1/billing',
        event_ref: anchorOf(0),
      },
      {
        id: 'mark-to',
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:07.000Z',
        route_path: '/rentals/1/billing',
        event_ref: anchorOf(1),
      },
    )

    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`, {
      to: anchorOf(1),
    })
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]!.body as {
      range: {
        kind: string
        same_session: boolean
        duration_ms: number | null
        start_at: string
        end_at: string
        capture_session_id: string | null
        media_artifacts: { id: string; kind: string }[]
      }
    }
    expect(body.range.kind).toBe('clip')
    expect(body.range.same_session).toBe(true)
    expect(body.range.duration_ms).toBe(5000)
    expect(body.range.start_at).toBe('2026-06-06T00:00:02.000Z')
    expect(body.range.end_at).toBe('2026-06-06T00:00:07.000Z')
    expect(body.range.capture_session_id).toBe(CAPTURE_SESSION_ID)
    expect(body.range.media_artifacts.map((a) => a.kind)).toEqual(['audio'])
  })

  it('treats from == to as a still', async () => {
    const pool = new FakePool()
    pool.attach()
    pool.eventLog.push(approveEventLogRow(0))
    pool.marks.push({
      id: 'mark-only',
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      event_type: 'workflow.transition',
      occurred_at: '2026-06-06T00:00:02.000Z',
      route_path: '/rentals/1/billing',
      event_ref: anchorOf(0),
    })
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`, {
      to: anchorOf(0),
    })
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(200)
    const body = captured[0]!.body as { range: { kind: string; duration_ms: number | null } }
    expect(body.range.kind).toBe('still')
    expect(body.range.duration_ms).toBe(0)
  })

  it('409s a from/to pair on different entities', async () => {
    const pool = new FakePool()
    pool.attach()
    pool.eventLog.push(approveEventLogRow(0))
    // A different-entity row sharing the same (workflow_name, state_version)
    // would not match the anchor digest, so a cross-entity `to` resolves to 404
    // before the same-stream check. Use a second valid anchor on another entity.
    const otherEntity = '22222222-3333-4444-5555-666666666666'
    const otherRef = workflowEventRef({
      workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
      entity_id: otherEntity,
      state_version: 0,
    })
    pool.eventLog.push({ ...approveEventLogRow(0), id: 'evt-other', entity_id: otherEntity })
    const { ctx, captured } = buildCtx(pool, `/api/anchors/${encodeURIComponent(anchorOf(0))}`, {
      to: otherRef,
    })
    expect(await handleAnchorRoutes(ctx)).toBe(true)
    expect(captured[0]?.status).toBe(409)
  })

  it('ignores non-anchor paths', async () => {
    const pool = new FakePool()
    pool.attach()
    const { ctx, captured } = buildCtx(pool, '/api/something-else')
    expect(await handleAnchorRoutes(ctx)).toBe(false)
    expect(captured).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleWorkflowEventLogRoutes, type WorkflowEventLogRouteCtx } from './workflow-event-log.js'

// ---------------------------------------------------------------------------
// Read-only GET /api/workflow-event-log — closes Probe TODO #1.
// The route is a thin projection over workflow_event_log, scoped to the
// active company. Smoke coverage: a single insert is reflected, role gate
// blocks workers, and missing query params surface as 400.
// ---------------------------------------------------------------------------

type WorkflowEventLogRow = {
  id: string
  company_id: string
  workflow_name: string
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  event_payload: unknown
  snapshot_after: { state: string; state_version: number }
  actor_user_id: string | null
  applied_at: string
  request_id?: string | null
  sentry_trace?: string | null
}

class FakePool {
  rows: WorkflowEventLogRow[] = []

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

    // The route's read query: `with stream as (... from workflow_event_log
    // where company_id = $1 and entity_type = $2 and entity_id = $3::uuid)
    // select ... from stream order by state_version desc limit $4`.
    if (/from workflow_event_log/i.test(sql)) {
      const [companyId, entityType, entityId, limit] = params as [string, string, string, number]
      const matched = this.rows
        .filter((r) => r.company_id === companyId && r.entity_type === entityType && r.entity_id === entityId)
        .sort((a, b) => a.state_version - b.state_version)
      // Compute LAG(snapshot_after->>'state') over (partition by entity_id
      // order by state_version asc).
      const withLag = matched.map((r, idx) => ({
        ...r,
        from_state: idx > 0 ? matched[idx - 1]!.snapshot_after.state : null,
      }))
      // Project to the route's output column shape.
      const projected = withLag.map((r) => ({
        id: r.id,
        workflow_name: r.workflow_name,
        entity_id: r.entity_id,
        event_type: r.event_type,
        state_version: r.state_version,
        to_state: r.snapshot_after.state,
        to_state_version: r.snapshot_after.state_version,
        from_state: r.from_state,
        actor_user_id: r.actor_user_id,
        applied_at: r.applied_at,
        request_id: r.request_id ?? null,
        sentry_trace: r.sentry_trace ?? null,
        event_payload: r.event_payload,
      }))
      const descending = projected.slice().sort((a, b) => b.state_version - a.state_version)
      const limited = descending.slice(0, limit)
      return { rows: limited, rowCount: limited.length }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  role: 'admin' | 'office' | 'member' | 'foreman' | 'bookkeeper' = 'admin',
): { ctx: WorkflowEventLogRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      sendJson: (status, body) => {
        responses.push({ status, body })
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

const ENTITY_ID = '11111111-1111-4111-8111-111111111111'

describe('handleWorkflowEventLogRoutes — GET /api/workflow-event-log', () => {
  it('returns false for non-matching paths/methods so dispatch can fall through', async () => {
    const pool = new FakePool()
    const { ctx } = makeCtx(pool)
    const handled = await handleWorkflowEventLogRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/workflow-event-log'),
      ctx,
    )
    expect(handled).toBe(false)
  })

  it('returns 400 when entity_type is missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_id=${ENTITY_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 400 when entity_id is missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/workflow-event-log?entity_type=estimate_push'),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('returns the rows for an entity, newest-first, with from_state derived from the previous row', async () => {
    const pool = new FakePool()
    pool.rows.push({
      id: 'wel-1',
      company_id: 'co-1',
      workflow_name: 'estimate_push',
      entity_type: 'estimate_push',
      entity_id: ENTITY_ID,
      state_version: 1,
      event_type: 'REVIEW',
      event_payload: { type: 'REVIEW', reviewed_by: 'u-1' },
      snapshot_after: { state: 'reviewed', state_version: 2 },
      actor_user_id: 'u-1',
      applied_at: '2026-05-01T00:00:00.000Z',
    })
    pool.rows.push({
      id: 'wel-2',
      company_id: 'co-1',
      workflow_name: 'estimate_push',
      entity_type: 'estimate_push',
      entity_id: ENTITY_ID,
      state_version: 2,
      event_type: 'APPROVE',
      event_payload: { type: 'APPROVE', approved_by: 'u-1' },
      snapshot_after: { state: 'approved', state_version: 3 },
      actor_user_id: 'u-1',
      applied_at: '2026-05-01T01:00:00.000Z',
      request_id: 'web-approve',
      sentry_trace: 'trace-approve-span-1',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_type=estimate_push&entity_id=${ENTITY_ID}`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { events: Array<Record<string, unknown>> }
    expect(body.events).toHaveLength(2)
    // Newest first.
    expect(body.events[0]?.event_type).toBe('APPROVE')
    expect(body.events[0]?.from_state).toBe('reviewed')
    expect(body.events[0]?.to_state).toBe('approved')
    expect(body.events[0]?.from_state_version).toBe(2)
    expect(body.events[0]?.to_state_version).toBe(3)
    expect(body.events[0]?.request_id).toBe('web-approve')
    expect(body.events[0]?.sentry_trace).toBe('trace-approve-span-1')
    // Oldest row has no predecessor.
    expect(body.events[1]?.event_type).toBe('REVIEW')
    expect(body.events[1]?.from_state).toBeNull()
    expect(body.events[1]?.to_state).toBe('reviewed')
    expect(body.events[1]?.event_payload).toEqual({ type: 'REVIEW', reviewed_by: 'u-1' })
  })

  it('honors the limit query param', async () => {
    const pool = new FakePool()
    for (let i = 1; i <= 5; i++) {
      pool.rows.push({
        id: `wel-${i}`,
        company_id: 'co-1',
        workflow_name: 'estimate_push',
        entity_type: 'estimate_push',
        entity_id: ENTITY_ID,
        state_version: i,
        event_type: 'REVIEW',
        event_payload: {},
        snapshot_after: { state: `s${i}`, state_version: i + 1 },
        actor_user_id: null,
        applied_at: `2026-05-01T0${i}:00:00.000Z`,
      })
    }
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_type=estimate_push&entity_id=${ENTITY_ID}&limit=2`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { events: Array<Record<string, unknown>> }
    expect(body.events).toHaveLength(2)
    // Newest two.
    expect(body.events[0]?.from_state_version).toBe(5)
    expect(body.events[1]?.from_state_version).toBe(4)
  })

  it('rejects limit > 100', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_type=estimate_push&entity_id=${ENTITY_ID}&limit=500`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('blocks member role (workers do not see workflow_event_log)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, 'member')
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_type=estimate_push&entity_id=${ENTITY_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('scopes results to the active company', async () => {
    const pool = new FakePool()
    pool.rows.push({
      id: 'wel-other',
      company_id: 'co-OTHER',
      workflow_name: 'estimate_push',
      entity_type: 'estimate_push',
      entity_id: ENTITY_ID,
      state_version: 1,
      event_type: 'REVIEW',
      event_payload: {},
      snapshot_after: { state: 'reviewed', state_version: 2 },
      actor_user_id: null,
      applied_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleWorkflowEventLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/workflow-event-log?entity_type=estimate_push&entity_id=${ENTITY_ID}`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { events: unknown[] }
    expect(body.events).toEqual([])
  })
})

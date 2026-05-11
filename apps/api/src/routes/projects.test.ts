import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleProjectRoutes, type ProjectRouteCtx } from './projects.js'

// ---------------------------------------------------------------------------
// In-memory pg double for the GET /api/projects/:id/closeout snapshot
// endpoint and the POST /api/projects/:id/closeout round-trip. Mirrors the
// pattern in project-lifecycle.test.ts; not a general-purpose SQL emulator.
//
// The POST closeout handler does a `select ... for update`, an `update
// projects ... returning ...`, then a workflow_event_log + sync_events +
// mutation_outbox triple via withMutationTx. After commit it fires a
// best-effort `summarizeProject` rollup to decide whether to enqueue a
// margin-shortfall admin alert; those reads must succeed so the route
// returns 200, but their content is unimportant here.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  projects: Row[] = []
  workflowEvents: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []
  notifications: Row[] = []

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
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return { rows: [], rowCount: 0 }
    }

    // ---- projects: snapshot select (GET handler) ----
    if (/select id, company_id, status, state_version/i.test(sql) && /from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: locking select (POST closeout) ----
    if (
      /select id, status, state_version, closed_at, closed_by, summary_locked_at, version/i.test(sql) &&
      /from projects/i.test(sql)
    ) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: idempotent already-completed read inside the tx ----
    if (
      /select id, customer_id, name, customer_name, division_code, status, bid_total/i.test(sql) &&
      /from projects/i.test(sql) &&
      !/update projects/i.test(sql)
    ) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: update to completed (POST closeout) ----
    if (/^update projects/i.test(sql) && /set\s+status\s*=\s*'completed'/i.test(sql)) {
      // params: [companyId, projectId, expectedVersion, nextStateVersion, closedAt, closedBy]
      const companyId = params[0] as string
      const projectId = params[1] as string
      const expectedVersion = params[2] as number | null
      const nextStateVersion = params[3] as number
      const closedAt = params[4] as string
      const closedBy = params[5] as string
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && project.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
      project.status = 'completed'
      project.state_version = nextStateVersion
      project.closed_at = project.closed_at ?? closedAt
      project.closed_by = project.closed_by ?? closedBy
      project.summary_locked_at = project.summary_locked_at ?? closedAt
      project.version = (project.version as number) + 1
      project.updated_at = new Date().toISOString()
      return { rows: [project], rowCount: 1 }
    }

    // ---- workflow_event_log ----
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

    // ---- sync_events ----
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    // ---- mutation_outbox ----
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        company_id: params[0],
        device_id: params[1],
        actor_user_id: params[2] ?? null,
        entity_type: params[3],
        entity_id: params[4],
        mutation_type: params[5],
        idempotency_key: params[7],
      })
      return { rows: [], rowCount: 1 }
    }

    // ---- audit_events ----
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    // ---- summarizeProject reads (post-commit margin-alert path) ----
    // Project select for summary (different column set than the snapshot
    // select above) — falls through to here when the snapshot regex
    // doesn't match.
    if (/^select id, company_id, customer_id, name, customer_name, division_code, status, bid_total/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/from takeoff_measurements/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from estimate_lines/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from labor_entries/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from material_bills/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/from bonus_rules/i.test(sql)) return { rows: [], rowCount: 0 }

    // ---- listCompanyAdminIds / enqueueNotification (margin-shortfall) ----
    if (/from company_memberships/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/^\s*insert into notifications/i.test(sql)) {
      this.notifications.push({ params })
      return { rows: [{ id: 'notif-1' }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
): {
  ctx: ProjectRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
      currentUserId: 'u-1',
      requireRole: () => true,
      readBody: async () => body,
      sendJson: (status: number, response: unknown) => {
        responses.push({ status, body: response })
      },
      checkVersion: async () => true,
    },
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.projects.push({
    id: PROJECT_ID,
    company_id: 'co-1',
    customer_id: null,
    name: 'Riverbend',
    customer_name: 'Acme Co',
    division_code: 'D4',
    status: 'active',
    state_version: 1,
    bid_total: 1000,
    labor_rate: 0,
    target_sqft_per_hr: null,
    bonus_pool: 0,
    closed_at: null,
    closed_by: null,
    summary_locked_at: null,
    workflow_engine: 'postgres',
    workflow_run_id: null,
    version: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleProjectRoutes — GET /api/projects/:id/closeout', () => {
  it('returns a WorkflowSnapshot with state="active", state_version, and a CLOSEOUT next event for an active project', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleProjectRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/closeout`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const snapshot = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string; label: string }>
      context: { id: string; status: string; closed_at: string | null }
    }
    expect(snapshot.state).toBe('active')
    expect(snapshot.state_version).toBe(1)
    expect(snapshot.next_events).toEqual([{ type: 'CLOSEOUT', label: 'Mark project complete' }])
    expect(snapshot.context.id).toBe(PROJECT_ID)
    expect(snapshot.context.status).toBe('active')
    expect(snapshot.context.closed_at).toBeNull()
  })

  it('returns state="completed" with no next_events when the project is already closed', async () => {
    const pool = new FakePool()
    seedProject(pool, {
      status: 'completed',
      state_version: 2,
      closed_at: '2026-05-01T00:00:00.000Z',
      closed_by: 'u-1',
      summary_locked_at: '2026-05-01T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    const snapshot = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { closed_at: string | null }
    }
    expect(snapshot.state).toBe('completed')
    expect(snapshot.state_version).toBe(2)
    expect(snapshot.next_events).toEqual([])
    expect(snapshot.context.closed_at).toBe('2026-05-01T00:00:00.000Z')
  })

  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('POST + GET round-trips: state advances from active to completed after a successful closeout', async () => {
    const pool = new FakePool()
    seedProject(pool)

    // 1) GET before — active, version 1.
    const before = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), before.ctx)
    const beforeSnap = before.responses[0]?.body as { state: string; state_version: number }
    expect(beforeSnap.state).toBe('active')
    expect(beforeSnap.state_version).toBe(1)

    // 2) POST closeout.
    const postCtx = makeCtx(pool, {})
    await handleProjectRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/projects/${PROJECT_ID}/closeout`),
      postCtx.ctx,
    )
    expect(postCtx.responses[0]?.status, JSON.stringify(postCtx.responses[0]?.body)).toBe(200)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('project_closeout')
    expect(pool.workflowEvents[0]?.event_type).toBe('CLOSEOUT')
    expect(pool.workflowEvents[0]?.state_version).toBe(1)

    // 3) GET after — completed, version bumped, no next_events.
    const after = makeCtx(pool)
    await handleProjectRoutes({ method: 'GET' } as never, buildUrl(`/api/projects/${PROJECT_ID}/closeout`), after.ctx)
    const afterSnap = after.responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<unknown>
      context: { closed_at: string | null; closed_by: string | null }
    }
    expect(afterSnap.state).toBe('completed')
    expect(afterSnap.state_version).toBe(2)
    expect(afterSnap.next_events).toEqual([])
    expect(afterSnap.context.closed_at).toBeTruthy()
    expect(afterSnap.context.closed_by).toBe('u-1')
  })
})

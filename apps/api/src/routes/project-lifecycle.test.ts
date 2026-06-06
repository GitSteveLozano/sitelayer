import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import {
  nextProjectLifecycleEvents,
  PROJECT_LIFECYCLE_ALL_STATES,
  type ProjectLifecycleWorkflowState,
} from '@sitelayer/workflows'
import { attachMutationTx } from '../mutation-tx.js'
import { handleProjectLifecycleRoutes, type ProjectLifecycleRouteCtx } from './project-lifecycle.js'

// ---------------------------------------------------------------------------
// In-memory pg double — covers what the project-lifecycle event route needs
// without spinning a real Postgres. Mirrors the simple stub used by
// estimate-shares.test.ts; not a general-purpose SQL emulator. Just enough
// to assert that ACCEPT and START_WORK enqueue a notify_foreman_assignment
// outbox row with the expected idempotency key + payload.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type OutboxRow = {
  company_id: string
  device_id: string
  actor_user_id: string | null
  entity_type: string
  entity_id: string
  mutation_type: string
  payload: Record<string, unknown>
  idempotency_key: string
}

class FakePool {
  projects: Row[] = []
  workflowEvents: Row[] = []
  syncEvents: Row[] = []
  outbox: OutboxRow[] = []

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

    // ---- projects: select ... for update ----
    if (/select[\s\S]+from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }

    // ---- projects: update ----
    if (/^update projects/i.test(sql)) {
      // Route's params: [companyId, id, state, state_version, sent_at,
      // accepted_at, declined_at, decline_reason, started_at, completed_at,
      // archived_at]
      const companyId = params[0] as string
      const projectId = params[1] as string
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      project.lifecycle_state = params[2]
      project.lifecycle_state_version = params[3]
      project.lifecycle_sent_at = params[4]
      project.lifecycle_accepted_at = params[5]
      project.lifecycle_declined_at = params[6]
      project.lifecycle_decline_reason = params[7]
      project.lifecycle_started_at = params[8]
      project.lifecycle_completed_at = params[9]
      project.lifecycle_archived_at = params[10]
      project.updated_at = new Date().toISOString()
      return {
        rows: [project],
        rowCount: 1,
      }
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
      this.outbox.push({
        company_id: params[0] as string,
        device_id: params[1] as string,
        actor_user_id: (params[2] as string | null) ?? null,
        entity_type: params[3] as string,
        entity_id: params[4] as string,
        mutation_type: params[5] as string,
        payload: JSON.parse(params[6] as string) as Record<string, unknown>,
        idempotency_key: params[7] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown>,
): {
  ctx: ProjectLifecycleRouteCtx
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
    },
  }
}

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.projects.push({
    id: '11111111-1111-4111-8111-111111111111',
    company_id: 'co-1',
    name: 'Riverbend',
    customer_name: 'Acme Co',
    status: 'active',
    lifecycle_state: 'sent',
    lifecycle_state_version: 3,
    lifecycle_sent_at: '2026-05-01T00:00:00.000Z',
    lifecycle_accepted_at: null,
    lifecycle_declined_at: null,
    lifecycle_decline_reason: null,
    lifecycle_started_at: null,
    lifecycle_completed_at: null,
    lifecycle_archived_at: null,
    version: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleProjectLifecycleRoutes — POST /api/projects/:id/lifecycle/events', () => {
  it('ACCEPT (sent → accepted) enqueues notify_foreman_assignment with the expected idempotency key + payload', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'ACCEPT', state_version: 3 })

    const handled = await handleProjectLifecycleRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle/events'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    expect(pool.projects[0]?.lifecycle_state).toBe('accepted')
    expect(pool.projects[0]?.lifecycle_state_version).toBe(4)

    const notifyOutbox = pool.outbox.find((row) => row.mutation_type === 'notify_foreman_assignment')
    expect(notifyOutbox).toBeDefined()
    expect(notifyOutbox?.idempotency_key).toBe(
      'project_lifecycle:notify_foreman:11111111-1111-4111-8111-111111111111:4',
    )
    expect(notifyOutbox?.payload.project_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(notifyOutbox?.payload.project_name).toBe('Riverbend')
    expect(notifyOutbox?.payload.customer_name).toBe('Acme Co')
    expect(notifyOutbox?.payload.transition).toBe('accepted')
    expect(notifyOutbox?.payload.actor_user_id).toBe('u-1')
    expect(typeof notifyOutbox?.payload.occurred_at).toBe('string')
  })

  it('START_WORK (accepted → in_progress) enqueues notify_foreman_assignment with transition=started', async () => {
    const pool = new FakePool()
    seedProject(pool, {
      lifecycle_state: 'accepted',
      lifecycle_state_version: 4,
      lifecycle_accepted_at: '2026-05-02T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { event: 'START_WORK', state_version: 4 })

    await handleProjectLifecycleRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle/events'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.projects[0]?.lifecycle_state).toBe('in_progress')

    const notifyOutbox = pool.outbox.find((row) => row.mutation_type === 'notify_foreman_assignment')
    expect(notifyOutbox).toBeDefined()
    expect(notifyOutbox?.idempotency_key).toBe(
      'project_lifecycle:notify_foreman:11111111-1111-4111-8111-111111111111:5',
    )
    expect(notifyOutbox?.payload.transition).toBe('started')
    expect(notifyOutbox?.payload.project_id).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('SEND (estimating → sent) does NOT enqueue notify_foreman_assignment', async () => {
    const pool = new FakePool()
    seedProject(pool, {
      lifecycle_state: 'estimating',
      lifecycle_state_version: 2,
      lifecycle_sent_at: null,
    })
    const { ctx, responses } = makeCtx(pool, { event: 'SEND', state_version: 2 })

    await handleProjectLifecycleRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle/events'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.projects[0]?.lifecycle_state).toBe('sent')
    expect(pool.outbox.find((row) => row.mutation_type === 'notify_foreman_assignment')).toBeUndefined()
  })

  it('COMPLETE (in_progress → done) does NOT enqueue notify_foreman_assignment', async () => {
    const pool = new FakePool()
    seedProject(pool, {
      lifecycle_state: 'in_progress',
      lifecycle_state_version: 5,
      lifecycle_accepted_at: '2026-05-02T00:00:00.000Z',
      lifecycle_started_at: '2026-05-03T00:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { event: 'COMPLETE', state_version: 5 })

    await handleProjectLifecycleRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle/events'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.projects[0]?.lifecycle_state).toBe('done')
    expect(pool.outbox.find((row) => row.mutation_type === 'notify_foreman_assignment')).toBeUndefined()
  })

  it('returns 409 on stale state_version without writing any outbox row', async () => {
    const pool = new FakePool()
    seedProject(pool, { lifecycle_state: 'sent', lifecycle_state_version: 3 })
    const { ctx, responses } = makeCtx(pool, { event: 'ACCEPT', state_version: 99 })

    await handleProjectLifecycleRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle/events'),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
    expect(pool.outbox).toHaveLength(0)
  })
})

describe('handleProjectLifecycleRoutes — GET /api/projects/:id/lifecycle next_events', () => {
  // Gap 5 guard: the GET snapshot's next_events must be exactly what the
  // registered nextProjectLifecycleEvents selector returns for every state —
  // proving the route no longer hand-copies a divergent table (the old
  // private workflowNextEvents dropped disabled_reason and was typed as
  // string).
  it.each(PROJECT_LIFECYCLE_ALL_STATES as readonly ProjectLifecycleWorkflowState[])(
    'state %s → next_events deep-equals the registered selector',
    async (state) => {
      const pool = new FakePool()
      seedProject(pool, { lifecycle_state: state })
      const { ctx, responses } = makeCtx(pool, {})

      const handled = await handleProjectLifecycleRoutes(
        { method: 'GET' } as never,
        buildUrl('/api/projects/11111111-1111-4111-8111-111111111111/lifecycle'),
        ctx,
      )
      expect(handled).toBe(true)
      expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
      const body = responses[0]?.body as { state: string; next_events: unknown }
      expect(body.state).toBe(state)
      expect(body.next_events).toEqual(nextProjectLifecycleEvents(state))
    },
  )
})

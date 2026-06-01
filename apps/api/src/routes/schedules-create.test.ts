import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleScheduleRoutes, type ScheduleRouteCtx } from './schedules.js'

// ---------------------------------------------------------------------------
// POST /api/schedules — create handler. The load-bearing assertions:
//
//   1. P0.2 auto-confirm: with no explicit status, a new assignment is created
//      AND confirmed in one request (so it lands in the confirmed-only today/
//      active read surfaces instead of silently dropping as a draft).
//   2. The genesis CREATE event is logged at state_version 0 and the
//      auto-confirm CONFIRM at state_version 1 — DISTINCT versions. The fake
//      pool below enforces the real (entity_id, workflow_name, state_version)
//      unique key, so a regression to a non-advancing CREATE@1 (which would
//      collide with CONFIRM@1 and 409 the create) fails this test.
//   3. An explicit status:'draft' still parks the row in draft with only the
//      genesis CREATE event and no confirm side effects.
// ---------------------------------------------------------------------------

type ScheduleRow = {
  id: string
  company_id: string
  project_id: string
  scheduled_for: string
  crew: unknown
  status: 'draft' | 'confirmed'
  version: number
  state_version: number
  confirmed_at: string | null
  confirmed_by: string | null
  created_by: string | null
  start_time: string | null
  end_time: string | null
  takeoff_measurement_id: string | null
  deleted_at: string | null
  created_at: string
}

const NEW_ID = '22222222-2222-4222-8222-222222222222'

class FakePool {
  schedules: ScheduleRow[] = []
  workflowEvents: Array<{ entity_id: string; workflow_name: string; state_version: number; event_type: string }> = []
  outbox: Array<{ mutation_type: string; idempotency_key: string }> = []
  syncEvents: number = 0
  auditEvents: number = 0
  // Mirrors the real UNIQUE (entity_id, workflow_name, state_version) key so a
  // duplicate workflow_event_log write surfaces as a 23505 the same way prod
  // would (recordWorkflowEvent maps it to a 409).
  private eventKeys = new Set<string>()

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

    if (/^insert into crew_schedules/i.test(sql)) {
      const [companyId, projectId, scheduledFor, crewJson, createdBy, startTime, endTime, takeoffId] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
      const row: ScheduleRow = {
        id: NEW_ID,
        company_id: companyId,
        project_id: projectId,
        scheduled_for: scheduledFor,
        crew: JSON.parse(crewJson),
        status: 'draft',
        version: 1,
        state_version: 1,
        confirmed_at: null,
        confirmed_by: null,
        created_by: createdBy,
        start_time: startTime,
        end_time: endTime,
        takeoff_measurement_id: takeoffId,
        deleted_at: null,
        created_at: '2026-05-31T00:00:00.000Z',
      }
      this.schedules.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^update crew_schedules/i.test(sql) && /set status = \$3/i.test(sql)) {
      const [companyId, id, status, stateVersion, confirmedAt, confirmedBy] = params as [
        string,
        string,
        'draft' | 'confirmed',
        number,
        string | null,
        string | null,
      ]
      const row = this.schedules.find((s) => s.company_id === companyId && s.id === id && !s.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.confirmed_at = confirmedAt
      row.confirmed_by = confirmedBy
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^insert into workflow_event_log/i.test(sql)) {
      const workflowName = params[1] as string
      const entityId = params[4] as string
      const stateVersion = params[5] as number
      const eventType = params[6] as string
      const key = `${entityId}|${workflowName}|${stateVersion}`
      if (this.eventKeys.has(key)) {
        const err = new Error(
          'duplicate key value violates unique constraint "workflow_event_log_entity_workflow_version_key"',
        ) as Error & { code?: string }
        err.code = '23505'
        throw err
      }
      this.eventKeys.add(key)
      this.workflowEvents.push({
        entity_id: entityId,
        workflow_name: workflowName,
        state_version: stateVersion,
        event_type: eventType,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into sync_events/i.test(sql)) {
      this.syncEvents += 1
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ mutation_type: params[5] as string, idempotency_key: params[7] as string })
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into audit_events/i.test(sql)) {
      this.auditEvents += 1
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown>,
  role: 'admin' | 'foreman' | 'office' | 'member' = 'admin',
): { ctx: ScheduleRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'u-1',
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async () => true,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

const VALID_PROJECT = '00000000-0000-4000-8000-000000000001'

describe('handleScheduleRoutes — POST /api/schedules (create)', () => {
  it('auto-confirms a new assignment by default (P0.2): row lands at confirmed@2', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { project_id: VALID_PROJECT, scheduled_for: '2026-05-31', crew: ['w-1'] })
    await handleScheduleRoutes({ method: 'POST' } as never, buildUrl('/api/schedules'), ctx)

    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const created = responses[0]?.body as ScheduleRow
    expect(created.status).toBe('confirmed')
    expect(created.state_version).toBe(2)
    expect(created.confirmed_by).toBe('u-1')
    expect(created.confirmed_at).not.toBeNull()
  })

  it('logs the genesis CREATE at state_version 0 and the auto-confirm CONFIRM at 1 (no collision)', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { project_id: VALID_PROJECT, scheduled_for: '2026-05-31' })
    // If CREATE and CONFIRM ever shared a state_version the fake pool would
    // throw 23505 here (→ 409), so reaching 201 IS the anti-collision proof.
    await handleScheduleRoutes({ method: 'POST' } as never, buildUrl('/api/schedules'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)

    expect(pool.workflowEvents.map((e) => `${e.event_type}@${e.state_version}`)).toEqual(['CREATE@0', 'CONFIRM@1'])
    // The auto-confirm enqueues the same stable-keyed materialize outbox the
    // legacy /confirm route does, so the worker path is identical.
    expect(
      pool.outbox.some(
        (r) =>
          r.mutation_type === 'materialize_labor_entries' &&
          r.idempotency_key === `crew_schedule:materialize_labor:${NEW_ID}`,
      ),
    ).toBe(true)
  })

  it('an explicit status:draft parks the row in draft with only the genesis CREATE event', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      project_id: VALID_PROJECT,
      scheduled_for: '2026-05-31',
      status: 'draft',
    })
    await handleScheduleRoutes({ method: 'POST' } as never, buildUrl('/api/schedules'), ctx)

    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const created = responses[0]?.body as ScheduleRow
    expect(created.status).toBe('draft')
    expect(created.state_version).toBe(1)
    expect(pool.workflowEvents.map((e) => `${e.event_type}@${e.state_version}`)).toEqual(['CREATE@0'])
    expect(pool.outbox.some((r) => r.mutation_type === 'materialize_labor_entries')).toBe(false)
  })

  it('rejects a non-admin/foreman/office caller with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { project_id: VALID_PROJECT, scheduled_for: '2026-05-31' }, 'member')
    await handleScheduleRoutes({ method: 'POST' } as never, buildUrl('/api/schedules'), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.schedules).toHaveLength(0)
  })
})

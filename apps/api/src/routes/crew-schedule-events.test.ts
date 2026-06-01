import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { nextCrewScheduleEvents } from '@sitelayer/workflows'
import { attachMutationTx } from '../mutation-tx.js'
import { handleCrewScheduleEventRoutes, type CrewScheduleEventRouteCtx } from './crew-schedule-events.js'
import { makeTestRequirePermission } from './test-require-permission.js'

// ---------------------------------------------------------------------------
// crew-schedule workflow surface — snapshot GET, event POST, drag-to-
// reschedule PATCH. The most consequential assertion is the
// already-confirmed-is-a-noop branch, which preserves the legacy
// /confirm endpoint's idempotent-on-replay behavior.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

type ScheduleRow = {
  id: string
  company_id: string
  project_id: string
  scheduled_for: string
  crew: unknown
  status: 'draft' | 'confirmed' | 'declined'
  version: number
  state_version: number
  confirmed_at: string | null
  confirmed_by: string | null
  created_by: string | null
  declined_at: string | null
  declined_by: string | null
  decline_reason: string | null
  start_time: string | null
  end_time: string | null
  takeoff_measurement_id: string | null
  deleted_at: string | null
  created_at: string
}

class FakePool {
  schedules: ScheduleRow[] = []
  workflowEvents: Array<{ event_type: string; state_version: number }> = []
  syncEvents: Row[] = []
  outbox: Array<{ mutation_type: string; idempotency_key: string }> = []
  auditEvents: Row[] = []

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

    if (/from crew_schedules/i.test(sql) && /select\s/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const row = this.schedules.find((s) => s.company_id === companyId && s.id === id && !s.deleted_at)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (/^update crew_schedules/i.test(sql) && /scheduled_for = \$3::date/i.test(sql)) {
      const [companyId, id, scheduledFor] = params as [string, string, string]
      const row = this.schedules.find((s) => s.company_id === companyId && s.id === id && !s.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.scheduled_for = scheduledFor
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^update crew_schedules/i.test(sql) && /status = \$3/i.test(sql)) {
      const [companyId, id, status, stateVersion, confirmedAt, confirmedBy, declinedAt, declinedBy, declineReason] =
        params as [
          string,
          string,
          'draft' | 'confirmed' | 'declined',
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      const row = this.schedules.find((s) => s.company_id === companyId && s.id === id && !s.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.confirmed_at = confirmedAt
      row.confirmed_by = confirmedBy
      row.declined_at = declinedAt
      row.declined_by = declinedBy
      row.decline_reason = declineReason
      row.version += 1
      return { rows: [row], rowCount: 1 }
    }

    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        state_version: params[5] as number,
        event_type: params[6] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        mutation_type: params[5] as string,
        idempotency_key: params[7] as string,
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111'

function seedSchedule(pool: FakePool, overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: SCHEDULE_ID,
    company_id: 'co-1',
    project_id: 'p-1',
    scheduled_for: '2026-05-15',
    crew: [],
    status: 'draft',
    version: 1,
    state_version: 1,
    confirmed_at: null,
    confirmed_by: null,
    created_by: null,
    declined_at: null,
    declined_by: null,
    decline_reason: null,
    start_time: null,
    end_time: null,
    takeoff_measurement_id: null,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
  pool.schedules.push(row)
  return row
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'foreman' | 'office' | 'member' = 'admin',
): { ctx: CrewScheduleEventRouteCtx; responses: Array<{ status: number; body: unknown }> } {
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
      requirePermission: makeTestRequirePermission(role, responses),
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

describe('handleCrewScheduleEventRoutes — GET /api/schedules/:id', () => {
  it('returns a WorkflowSnapshot with state=draft and next_events=[CONFIRM]', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool)
    await handleCrewScheduleEventRoutes({ method: 'GET' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
    }
    expect(body.state).toBe('draft')
    expect(body.next_events.map((e) => e.type)).toEqual(['CONFIRM', 'DECLINE'])
  })

  it('returns 404 for an unknown schedule', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleCrewScheduleEventRoutes({ method: 'GET' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('400s when id is not a uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleCrewScheduleEventRoutes({ method: 'GET' } as never, buildUrl('/api/schedules/not-a-uuid'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('next_events is sourced from the registered reducer selector (Gap 3/6)', async () => {
    // The route must not hand-duplicate the transition table — its
    // next_events deep-equals nextCrewScheduleEvents(state) for every state.
    for (const state of ['draft', 'confirmed', 'declined'] as const) {
      const pool = new FakePool()
      seedSchedule(pool, { status: state, state_version: state === 'draft' ? 1 : 2 })
      const { ctx, responses } = makeCtx(pool)
      await handleCrewScheduleEventRoutes({ method: 'GET' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
      const body = responses[0]?.body as { next_events: Array<{ type: string; label: string }> }
      expect(body.next_events, `state=${state}`).toEqual(nextCrewScheduleEvents(state))
    }
  })
})

describe('handleCrewScheduleEventRoutes — POST /api/schedules/:id/events', () => {
  it('rejects office callers with 403 (POST events is admin/foreman only)', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'CONFIRM', state_version: 1 }, 'office')
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(403)
  })

  it('CONFIRM: draft → confirmed + workflow_event_log row + materialize_labor_entries outbox', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool, {
      event: 'CONFIRM',
      state_version: 1,
      entries: [{ worker_id: 'w-1', service_item_code: 'SVC-1', hours: 8, occurred_on: '2026-05-15' }],
    })
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.schedules[0]?.status).toBe('confirmed')
    expect(pool.workflowEvents[0]?.event_type).toBe('CONFIRM')
    expect(pool.outbox.some((r) => r.idempotency_key.startsWith(`crew_schedule:event:${SCHEDULE_ID}:`))).toBe(true)
    // Gap 1 — the labor-entry materialization is a declared outbox side
    // effect, keyed per-entity (NOT per-state_version) so a replay upserts
    // one row. This is the row the worker runner drains.
    expect(
      pool.outbox.some(
        (r) =>
          r.mutation_type === 'materialize_labor_entries' &&
          r.idempotency_key === `crew_schedule:materialize_labor:${SCHEDULE_ID}`,
      ),
    ).toBe(true)
  })

  it('DECLINE: draft → declined + notify_foreman_decline outbox (Gap 5)', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool, { event: 'DECLINE', state_version: 1, reason: 'double-booked' }, 'foreman')
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.schedules[0]?.status).toBe('declined')
    expect(pool.schedules[0]?.decline_reason).toBe('double-booked')
    expect(pool.workflowEvents[0]?.event_type).toBe('DECLINE')
    expect(
      pool.outbox.some(
        (r) =>
          r.mutation_type === 'notify_foreman_decline' &&
          r.idempotency_key === `crew_schedule:notify_decline:${SCHEDULE_ID}:2`,
      ),
    ).toBe(true)
  })

  it('REASSIGN: declined → draft, clears decline fields (Gap 5)', async () => {
    const pool = new FakePool()
    seedSchedule(pool, {
      status: 'declined',
      state_version: 2,
      declined_at: '2026-05-10T00:00:00.000Z',
      declined_by: 'w-1',
      decline_reason: 'sick',
    })
    const { ctx, responses } = makeCtx(pool, { event: 'REASSIGN', state_version: 2 }, 'foreman')
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.schedules[0]?.status).toBe('draft')
    expect(pool.schedules[0]?.decline_reason).toBeNull()
    expect(pool.schedules[0]?.state_version).toBe(3)
  })

  it('returns 409 on stale state_version', async () => {
    const pool = new FakePool()
    seedSchedule(pool, { state_version: 5 })
    const { ctx, responses } = makeCtx(pool, { event: 'CONFIRM', state_version: 1 })
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })

  it('CONFIRM on an already-confirmed schedule is treated as a no-op success', async () => {
    const pool = new FakePool()
    seedSchedule(pool, {
      status: 'confirmed',
      state_version: 2,
      confirmed_at: '2026-05-10T00:00:00.000Z',
      confirmed_by: 'u-1',
    })
    const { ctx, responses } = makeCtx(pool, { event: 'CONFIRM', state_version: 2 })
    await handleCrewScheduleEventRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/schedules/${SCHEDULE_ID}/events`),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    // No new workflow_event_log row written for the no-op path.
    expect(pool.workflowEvents).toHaveLength(0)
  })
})

describe('handleCrewScheduleEventRoutes — PATCH /api/schedules/:id', () => {
  it('reschedules and bumps version', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool, { scheduled_for: '2026-05-20' })
    await handleCrewScheduleEventRoutes({ method: 'PATCH' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.schedules[0]?.scheduled_for).toBe('2026-05-20')
    expect(pool.schedules[0]?.version).toBe(2)
  })

  it('400s when scheduled_for is missing or malformed', async () => {
    const pool = new FakePool()
    seedSchedule(pool)
    const { ctx, responses } = makeCtx(pool, {})
    await handleCrewScheduleEventRoutes({ method: 'PATCH' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('reschedule preserves the workflow invariants — state_version + status unchanged (Gap 6)', async () => {
    // Reschedule is a field edit, NOT a workflow transition: it bumps the
    // row `version` (optimistic concurrency) but must leave state_version
    // and status alone.
    const pool = new FakePool()
    seedSchedule(pool, { state_version: 3, status: 'draft' })
    const { ctx, responses } = makeCtx(pool, { scheduled_for: '2026-05-20' })
    await handleCrewScheduleEventRoutes({ method: 'PATCH' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.schedules[0]?.state_version).toBe(3) // unchanged
    expect(pool.schedules[0]?.status).toBe('draft') // unchanged
    expect(pool.schedules[0]?.version).toBe(2) // bumped
  })

  it('409s on a stale expected_version (Gap 4)', async () => {
    // When the row exists but the optimistic version check fails, the
    // route delegates to ctx.checkVersion → a 409. Simulate the conflict
    // by having checkVersion report "not ok" (false).
    const pool = new FakePool()
    seedSchedule(pool, { version: 5 })
    pool.attach()
    const responses: Array<{ status: number; body: unknown }> = []
    const ctx: CrewScheduleEventRouteCtx = {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' },
      currentUserId: 'u-1',
      requireRole: () => true,
      requirePermission: makeTestRequirePermission('admin', responses),
      readBody: async () => ({ scheduled_for: '2026-05-20', expected_version: 2 }),
      sendJson: (status, body) => responses.push({ status, body }),
      // false => the route's "version conflict already responded" path.
      checkVersion: async () => false,
    }
    await handleCrewScheduleEventRoutes({ method: 'PATCH' } as never, buildUrl(`/api/schedules/${SCHEDULE_ID}`), ctx)
    // checkVersion(false) means it already emitted the 409 itself and the
    // route returns without a further sendJson — so no 404 is emitted.
    expect(responses.find((r) => r.status === 404)).toBeUndefined()
    // The row was not rescheduled (stale version rejected).
    expect(pool.schedules[0]?.scheduled_for).toBe('2026-05-15')
  })
})

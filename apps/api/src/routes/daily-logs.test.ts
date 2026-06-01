import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleDailyLogRoutes, type DailyLogRouteCtx } from './daily-logs.js'
import { makeTestRequirePermission } from './test-require-permission.js'
import type { BlueprintStorage } from '../storage.js'

// ---------------------------------------------------------------------------
// In-memory pg double — covers what the daily-log routes need to read/write
// from the new daily_log_photos metadata table without spinning a real
// Postgres. Mirrors the simple stubs other route tests use.
//
// Scope: GET /api/daily-logs/:id/photos and DELETE /api/daily-logs/:id/photos.
// The POST upload path goes through busboy + a real BlueprintStorage and is
// covered by the existing blueprint-upload integration tests; the schema
// behavior (per-photo metadata + label denorm) lives in the SQL emitted by
// these two paths.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  dailyLogs: Row[] = []
  photos: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  workflowEvents: Array<{ entity_id: string; state_version: number; event_type: string }> = []

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

    // ---- daily_logs: select ... for update (submit/events lock) ----
    if (/^select[\s\S]+from\s+daily_logs[\s\S]+for update/i.test(sql)) {
      const [companyId, id, ownerFilter] = params as [string, string, string]
      const row = this.dailyLogs.find(
        (l) => l.company_id === companyId && l.id === id && (ownerFilter === '' || l.foreman_user_id === ownerFilter),
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // ---- daily_logs: snapshot / detail select (full columns, no for update) ----
    if (/^select\s+id, company_id, project_id[\s\S]+from\s+daily_logs/i.test(sql) && /id = \$2/i.test(sql)) {
      const [companyId, id, ownerFilter] = params as [string, string, string]
      const row = this.dailyLogs.find(
        (l) => l.company_id === companyId && l.id === id && (ownerFilter === '' || l.foreman_user_id === ownerFilter),
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // ---- daily_logs: update status (submit/events transition) ----
    if (/^update daily_logs[\s\S]+set status = \$4/i.test(sql)) {
      const [companyId, id, ownerFilter, status, stateVersion, submittedAt] = params as [
        string,
        string,
        string,
        string,
        number,
        string,
      ]
      const row = this.dailyLogs.find(
        (l) =>
          l.company_id === companyId &&
          l.id === id &&
          l.status === 'draft' &&
          (ownerFilter === '' || l.foreman_user_id === ownerFilter),
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.submitted_at = submittedAt
      row.version = ((row.version as number) ?? 0) + 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    // ---- workflow_event_log append ----
    if (/^insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        entity_id: params[4] as string,
        state_version: params[5] as number,
        event_type: params[6] as string,
      })
      return { rows: [], rowCount: 1 }
    }

    // ---- daily_logs: ownership existence check ----
    if (/^select exists\([\s\S]+from daily_logs/i.test(sql)) {
      const [companyId, id, ownerFilter] = params as [string, string, string]
      const row = this.dailyLogs.find(
        (l) => l.company_id === companyId && l.id === id && (ownerFilter === '' || l.foreman_user_id === ownerFilter),
      )
      return { rows: [{ exists: Boolean(row) }], rowCount: 1 }
    }

    // ---- daily_logs: select for ownership/status ----
    if (/^select id, status, foreman_user_id[\s\S]+from daily_logs/i.test(sql)) {
      const [companyId, id, ownerFilter] = params as [string, string, string]
      const row = this.dailyLogs.find(
        (l) => l.company_id === companyId && l.id === id && (ownerFilter === '' || l.foreman_user_id === ownerFilter),
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // ---- daily_logs: update photo_keys (DELETE photo path) ----
    if (/^update daily_logs[\s\S]+set photo_keys = array_remove/i.test(sql)) {
      const [companyId, id, key, ownerFilter] = params as [string, string, string, string]
      const row = this.dailyLogs.find(
        (l) =>
          l.company_id === companyId &&
          l.id === id &&
          l.status === 'draft' &&
          (ownerFilter === '' || l.foreman_user_id === ownerFilter) &&
          Array.isArray(l.photo_keys) &&
          (l.photo_keys as string[]).includes(key),
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.photo_keys = (row.photo_keys as string[]).filter((k) => k !== key)
      row.version = ((row.version as number) ?? 0) + 1
      return { rows: [row], rowCount: 1 }
    }

    // ---- daily_log_photos: list ----
    if (
      /^select id, storage_key, scope_step_id, scope_step_label, captured_at[\s\S]+from daily_log_photos/i.test(sql)
    ) {
      const [companyId, dailyLogId] = params as [string, string]
      const rows = this.photos
        .filter((p) => p.company_id === companyId && p.daily_log_id === dailyLogId)
        .map((p) => ({
          id: p.id,
          storage_key: p.storage_key,
          scope_step_id: p.scope_step_id,
          scope_step_label: p.scope_step_label,
          captured_at: p.captured_at,
        }))
      return { rows, rowCount: rows.length }
    }

    // ---- daily_log_photos: delete by key ----
    if (/^delete from daily_log_photos/i.test(sql)) {
      const [companyId, dailyLogId, key] = params as [string, string, string]
      const before = this.photos.length
      this.photos = this.photos.filter(
        (p) => !(p.company_id === companyId && p.daily_log_id === dailyLogId && p.storage_key === key),
      )
      return { rows: [], rowCount: before - this.photos.length }
    }

    // ---- mutation ledger writes (recordMutationLedger fan-out) ----
    if (/^insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const LOG_ID = '22222222-2222-4222-8222-222222222222'
const STEP_ONE_ID = '33333333-3333-4333-8333-333333333333'
const STEP_TWO_ID = '44444444-4444-4444-8444-444444444444'
const KEY_ONE = `${COMPANY_ID}/daily-logs/${LOG_ID}/p1.jpg`
const KEY_TWO = `${COMPANY_ID}/daily-logs/${LOG_ID}/p2.jpg`
const KEY_THREE = `${COMPANY_ID}/daily-logs/${LOG_ID}/p3.jpg`

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'foreman' | 'office' = 'foreman',
  currentUserId = 'foreman-1',
): { ctx: DailyLogRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role },
      currentUserId,
      requireRole: () => true,
      requirePermission: makeTestRequirePermission(role, responses),
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async () => true,
      storage: {} as BlueprintStorage,
      maxPhotoBytes: 1_000_000,
      photoDownloadPresigned: false,
      sendFileContent: () => undefined,
      sendFileRedirect: () => undefined,
    },
  }
}

function seedLog(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.dailyLogs.push({
    id: LOG_ID,
    company_id: COMPANY_ID,
    project_id: '99999999-9999-4999-8999-999999999999',
    occurred_on: '2026-05-09',
    foreman_user_id: 'foreman-1',
    scope_progress: '[]',
    weather: null,
    notes: null,
    schedule_deviations: '[]',
    crew_summary: '[]',
    photo_keys: [KEY_ONE, KEY_TWO, KEY_THREE],
    status: 'draft',
    submitted_at: null,
    origin: 'test',
    version: 0,
    state_version: 1,
    created_at: '2026-05-09T08:00:00.000Z',
    updated_at: '2026-05-09T08:00:00.000Z',
    ...overrides,
  })
}

function seedPhoto(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.photos.push({
    id: `photo-${pool.photos.length + 1}`,
    company_id: COMPANY_ID,
    daily_log_id: LOG_ID,
    storage_key: KEY_ONE,
    scope_step_id: null,
    scope_step_label: null,
    captured_at: '2026-05-09T08:30:00.000Z',
    created_at: '2026-05-09T08:30:00.000Z',
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleDailyLogRoutes — GET /api/daily-logs/:id/photos', () => {
  it('returns photos with scope_step_id / scope_step_label / captured_at metadata', async () => {
    const pool = new FakePool()
    seedLog(pool)
    seedPhoto(pool, {
      id: 'photo-step-1',
      storage_key: KEY_ONE,
      scope_step_id: STEP_ONE_ID,
      scope_step_label: 'Frame the south wall',
    })
    seedPhoto(pool, {
      id: 'photo-step-2',
      storage_key: KEY_TWO,
      scope_step_id: STEP_TWO_ID,
      scope_step_label: 'Sheath the south wall',
    })
    seedPhoto(pool, {
      id: 'photo-untagged',
      storage_key: KEY_THREE,
      // Untagged — backfilled or worker captured outside an active step.
    })
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleDailyLogRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/daily-logs/${LOG_ID}/photos`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { photos: Array<Record<string, unknown>> }
    expect(body.photos).toHaveLength(3)
    expect(body.photos.find((p) => p.storage_key === KEY_ONE)?.scope_step_id).toBe(STEP_ONE_ID)
    expect(body.photos.find((p) => p.storage_key === KEY_ONE)?.scope_step_label).toBe('Frame the south wall')
    expect(body.photos.find((p) => p.storage_key === KEY_TWO)?.scope_step_id).toBe(STEP_TWO_ID)
    // Untagged row keeps a null step id so the foreman PhotoTimeline can
    // route it to the "Untagged" bucket.
    expect(body.photos.find((p) => p.storage_key === KEY_THREE)?.scope_step_id).toBeNull()
  })

  it('returns 404 when the log is not visible to the foreman', async () => {
    const pool = new FakePool()
    seedLog(pool, { foreman_user_id: 'someone-else' })
    seedPhoto(pool)
    const { ctx, responses } = makeCtx(pool, {}, 'foreman', 'foreman-1')

    await handleDailyLogRoutes({ method: 'GET' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/photos`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('admin can list photos on any foreman log', async () => {
    const pool = new FakePool()
    seedLog(pool, { foreman_user_id: 'someone-else' })
    seedPhoto(pool, { storage_key: KEY_ONE })
    const { ctx, responses } = makeCtx(pool, {}, 'admin', 'admin-1')

    await handleDailyLogRoutes({ method: 'GET' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/photos`), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { photos: unknown[] }).photos).toHaveLength(1)
  })
})

describe('handleDailyLogRoutes — DELETE /api/daily-logs/:id/photos', () => {
  it('removes the storage key from photo_keys AND deletes the daily_log_photos row', async () => {
    const pool = new FakePool()
    seedLog(pool)
    seedPhoto(pool, {
      id: 'photo-keep',
      storage_key: KEY_ONE,
      scope_step_id: STEP_ONE_ID,
      scope_step_label: 'Frame',
    })
    seedPhoto(pool, {
      id: 'photo-drop',
      storage_key: KEY_TWO,
      scope_step_id: STEP_TWO_ID,
      scope_step_label: 'Sheath',
    })
    const { ctx, responses } = makeCtx(pool, { key: KEY_TWO })

    const handled = await handleDailyLogRoutes(
      { method: 'DELETE' } as never,
      buildUrl(`/api/daily-logs/${LOG_ID}/photos`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    // photo_keys array trimmed.
    const log = pool.dailyLogs[0]!
    expect(log.photo_keys).toEqual([KEY_ONE, KEY_THREE])

    // Metadata row deleted; KEY_ONE row preserved.
    expect(pool.photos.map((p) => p.storage_key)).toEqual([KEY_ONE])
  })
})

describe('handleDailyLogRoutes — POST /api/daily-logs/:id/events', () => {
  it('happy path: SUBMIT flips draft → submitted, bumps state_version, logs the event + ledger', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: 1 })

    const handled = await handleDailyLogRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/daily-logs/${LOG_ID}/events`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)

    // Response is a WorkflowSnapshot, not a raw { dailyLog } row.
    const body = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { submitted_at: string | null }
    }
    expect(body.state).toBe('submitted')
    expect(body.state_version).toBe(2)
    expect(body.next_events).toEqual([])
    expect(body.context.submitted_at).not.toBeNull()

    // Row mutated.
    const row = pool.dailyLogs[0]!
    expect(row.status).toBe('submitted')
    expect(row.state_version).toBe(2)
    expect(row.submitted_at).not.toBeNull()

    // One workflow_event_log row, keyed at the BEFORE state_version.
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]).toMatchObject({ entity_id: LOG_ID, state_version: 1, event_type: 'SUBMIT' })

    // Ledger row keyed daily_log:submit:<id>.
    expect(pool.outbox).toHaveLength(1)
    expect((pool.outbox[0]?.params as unknown[])[7]).toBe(`daily_log:submit:${LOG_ID}`)
  })

  it('stale state_version → 409 with a fresh snapshot in the body', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 2 })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: 1 })

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    const body = responses[0]?.body as { error: string; snapshot: { state: string; state_version: number } }
    expect(body.snapshot.state).toBe('draft')
    expect(body.snapshot.state_version).toBe(2)
    // No transition was written.
    expect(pool.workflowEvents).toHaveLength(0)
    expect(pool.dailyLogs[0]?.status).toBe('draft')
  })

  it('already submitted → 409 illegal transition, no second event-log row', async () => {
    const pool = new FakePool()
    seedLog(pool, { status: 'submitted', state_version: 2, submitted_at: '2026-05-09T17:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: 2 })

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('foreman cannot submit another foreman’s draft → 409 (row invisible to the WHERE)', async () => {
    const pool = new FakePool()
    seedLog(pool, { foreman_user_id: 'someone-else', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: 1 }, 'foreman', 'foreman-1')

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.dailyLogs[0]?.status).toBe('draft')
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('admin can submit any foreman’s draft → 200', async () => {
    const pool = new FakePool()
    seedLog(pool, { foreman_user_id: 'someone-else', state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: 1 }, 'admin', 'admin-1')

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.dailyLogs[0]?.status).toBe('submitted')
    expect(pool.workflowEvents).toHaveLength(1)
  })

  it('bad body → 400 via parseDailyLogEventRequest', async () => {
    for (const body of [{}, { event: 'UNSUBMIT', state_version: 1 }, { event: 'SUBMIT', state_version: 'x' }]) {
      const pool = new FakePool()
      seedLog(pool, { state_version: 1 })
      const { ctx, responses } = makeCtx(pool, body)
      await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
      expect(responses[0]?.status, JSON.stringify(body)).toBe(400)
      expect(pool.workflowEvents).toHaveLength(0)
    }
  })

  it('numeric-string state_version is coerced (offline replay)', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { event: 'SUBMIT', state_version: '1' })

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.dailyLogs[0]?.status).toBe('submitted')
  })

  it('replay after submitted → 409, ledger/event-log unchanged', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 1 })
    const first = makeCtx(pool, { event: 'SUBMIT', state_version: 1 })
    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), first.ctx)
    expect(first.responses[0]?.status).toBe(200)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.outbox).toHaveLength(1)

    // Re-POST against the now-stale state_version=1.
    const second = makeCtx(pool, { event: 'SUBMIT', state_version: 1 })
    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/events`), second.ctx)
    expect(second.responses[0]?.status).toBe(409)
    // No double side-effect.
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.outbox).toHaveLength(1)
  })
})

describe('handleDailyLogRoutes — GET /api/daily-logs/:id/snapshot', () => {
  it('returns a WorkflowSnapshot with next_events from the reducer (draft → SUBMIT)', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 1 })
    const { ctx, responses } = makeCtx(pool)

    await handleDailyLogRoutes({ method: 'GET' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/snapshot`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { id: string }
    }
    expect(body.state).toBe('draft')
    expect(body.state_version).toBe(1)
    expect(body.next_events).toEqual([{ type: 'SUBMIT', label: 'Submit daily log' }])
    expect(body.context.id).toBe(LOG_ID)
  })

  it('submitted log → next_events empty', async () => {
    const pool = new FakePool()
    seedLog(pool, { status: 'submitted', state_version: 2, submitted_at: '2026-05-09T17:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool)

    await handleDailyLogRoutes({ method: 'GET' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/snapshot`), ctx)
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { next_events: unknown[] }).next_events).toEqual([])
  })
})

describe('handleDailyLogRoutes — POST /api/daily-logs/:id/submit (legacy alias)', () => {
  it('still submits through the reducer (event-log + ledger) and returns { dailyLog }', async () => {
    const pool = new FakePool()
    seedLog(pool, { state_version: 1 })
    const { ctx, responses } = makeCtx(pool, { expected_version: 0 })

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/submit`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    // Legacy shape preserved: { dailyLog: row }, not a snapshot.
    const body = responses[0]?.body as { dailyLog: { status: string; state_version: number } }
    expect(body.dailyLog.status).toBe('submitted')
    expect(body.dailyLog.state_version).toBe(2)
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]).toMatchObject({ entity_id: LOG_ID, state_version: 1, event_type: 'SUBMIT' })
    expect((pool.outbox[0]?.params as unknown[])[7]).toBe(`daily_log:submit:${LOG_ID}`)
  })

  it('already submitted → 409', async () => {
    const pool = new FakePool()
    seedLog(pool, { status: 'submitted', state_version: 2, submitted_at: '2026-05-09T17:00:00.000Z' })
    const { ctx, responses } = makeCtx(pool, { expected_version: 1 })

    await handleDailyLogRoutes({ method: 'POST' } as never, buildUrl(`/api/daily-logs/${LOG_ID}/submit`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
  })
})

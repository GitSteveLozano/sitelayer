import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleNotificationRoutes, type NotificationRouteCtx } from './notifications.js'

// ---------------------------------------------------------------------------
// Minimal pg double — same shape used in project-lifecycle.test.ts.
// Notifications routes only run a single SELECT or a single UPDATE per call,
// so the matcher lives inline in dispatch().
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  kind: string
  subject: string
  body_text: string
  payload: Record<string, unknown>
  created_at: string
}

class FakePool {
  rows: StoredRow[] = []

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  // withCompanyClient() in mutation-tx.ts calls pool.connect() → client.query.
  // Mirror that so RLS-scoped reads keep working under the same FakePool.
  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim()

    if (
      trimmed.startsWith('begin') ||
      trimmed.startsWith('commit') ||
      trimmed.startsWith('rollback') ||
      trimmed.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/^select[\s\S]+from notifications/i.test(trimmed)) {
      const [companyId, recipientId, ...rest] = params as [string, string, ...unknown[]]
      // Trailing params are [..., limit, offset]; the optional kind (when
      // ?kind=… is supplied) sits between recipient and limit. The route now
      // always appends both limit and offset, so detect kind by whether
      // rest has 3 trailing params instead of 2.
      const offset = rest.length > 0 ? Number(rest[rest.length - 1]) : 0
      const limit = rest.length > 1 ? Number(rest[rest.length - 2]) : 20
      const kind = rest.length === 3 ? (rest[0] as string) : null
      const unreadOnly = /payload->>'read_at'\) is null/.test(trimmed)
      const filtered = this.rows
        .filter((r) => r.company_id === companyId)
        .filter((r) => r.recipient_clerk_user_id === recipientId)
        .filter((r) => (kind ? r.kind === kind : true))
        .filter((r) => (unreadOnly ? r.payload['read_at'] === undefined : true))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(offset, offset + limit)
        .map((r) => ({
          id: r.id,
          company_id: r.company_id,
          recipient_clerk_user_id: r.recipient_clerk_user_id,
          kind: r.kind,
          subject: r.subject,
          body_text: r.body_text,
          payload: r.payload,
          read_at: typeof r.payload['read_at'] === 'string' ? (r.payload['read_at'] as string) : null,
          created_at: r.created_at,
        }))
      return { rows: filtered, rowCount: filtered.length }
    }

    if (/^update notifications/i.test(trimmed)) {
      const [id, companyId, recipientId] = params as [string, string, string]
      const row = this.rows.find(
        (r) => r.id === id && r.company_id === companyId && r.recipient_clerk_user_id === recipientId,
      )
      if (!row) return { rows: [], rowCount: 0 }
      if (row.payload['read_at'] === undefined) {
        row.payload = { ...row.payload, read_at: '2026-05-09T12:00:00.000Z' }
      }
      return {
        rows: [
          {
            ...row,
            read_at: row.payload['read_at'] as string,
          },
        ],
        rowCount: 1,
      }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  currentUserId = 'user_worker_1',
): {
  ctx: NotificationRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'member' as const },
      currentUserId,
      requireRole: () => true,
      readBody: async () => ({}),
      sendJson: (status, body) => {
        responses.push({ status, body })
      },
    },
  }
}

function seed(pool: FakePool, overrides: Partial<StoredRow> = {}): StoredRow {
  const row: StoredRow = {
    id: '00000000-0000-4000-8000-000000000001',
    company_id: 'co-1',
    recipient_clerk_user_id: 'user_worker_1',
    kind: 'worker_issue_resolved',
    subject: 'Your foreman replied',
    body_text: 'Foreman action: resolved\n\nMessage body',
    payload: {},
    created_at: '2026-05-09T08:00:00.000Z',
    ...overrides,
  }
  pool.rows.push(row)
  return row
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleNotificationRoutes — GET /api/notifications', () => {
  it('returns rows for the current user only', async () => {
    const pool = new FakePool()
    seed(pool, { id: '00000000-0000-4000-8000-000000000001' })
    seed(pool, { id: '00000000-0000-4000-8000-000000000002', recipient_clerk_user_id: 'user_other' })
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { notifications: Array<{ id: string }> }
    expect(body.notifications.map((n) => n.id)).toEqual(['00000000-0000-4000-8000-000000000001'])
  })

  it('does not leak across companies', async () => {
    const pool = new FakePool()
    seed(pool, { company_id: 'co-2' })
    const { ctx, responses } = makeCtx(pool)

    await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications'), ctx)
    const body = responses[0]?.body as { notifications: unknown[] }
    expect(body.notifications).toEqual([])
  })

  it('filters by kind when ?kind=… is supplied', async () => {
    const pool = new FakePool()
    seed(pool, { id: '00000000-0000-4000-8000-000000000010', kind: 'worker_issue_resolved' })
    seed(pool, { id: '00000000-0000-4000-8000-000000000011', kind: 'foreman_assignment' })
    const { ctx, responses } = makeCtx(pool)

    await handleNotificationRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/notifications?kind=worker_issue_resolved'),
      ctx,
    )
    const body = responses[0]?.body as { notifications: Array<{ kind: string }> }
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0]?.kind).toBe('worker_issue_resolved')
  })

  it('filters out already-read rows when ?unread=1', async () => {
    const pool = new FakePool()
    seed(pool, { id: '00000000-0000-4000-8000-000000000020', payload: {} })
    seed(pool, {
      id: '00000000-0000-4000-8000-000000000021',
      payload: { read_at: '2026-05-09T07:00:00.000Z' },
    })
    const { ctx, responses } = makeCtx(pool)

    await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications?unread=1'), ctx)
    const body = responses[0]?.body as { notifications: Array<{ id: string }> }
    expect(body.notifications.map((n) => n.id)).toEqual(['00000000-0000-4000-8000-000000000020'])
  })
})

describe('handleNotificationRoutes — POST /api/notifications/:id/read', () => {
  it('marks the row read and returns the updated notification', async () => {
    const pool = new FakePool()
    const row = seed(pool, { id: '00000000-0000-4000-8000-000000000030' })
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleNotificationRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/notifications/${row.id}/read`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { notification: { read_at: string | null } }
    expect(body.notification.read_at).toBe('2026-05-09T12:00:00.000Z')
    expect(pool.rows[0]?.payload['read_at']).toBe('2026-05-09T12:00:00.000Z')
  })

  it('404s when the notification belongs to a different recipient', async () => {
    const pool = new FakePool()
    const row = seed(pool, {
      id: '00000000-0000-4000-8000-000000000040',
      recipient_clerk_user_id: 'user_other',
    })
    const { ctx, responses } = makeCtx(pool, 'user_worker_1')

    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${row.id}/read`), ctx)
    expect(responses[0]?.status).toBe(404)
    expect(pool.rows[0]?.payload['read_at']).toBeUndefined()
  })

  it('404s when the notification belongs to a different company', async () => {
    const pool = new FakePool()
    const row = seed(pool, {
      id: '00000000-0000-4000-8000-000000000050',
      company_id: 'co-other',
    })
    const { ctx, responses } = makeCtx(pool)

    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${row.id}/read`), ctx)
    expect(responses[0]?.status).toBe(404)
    expect(pool.rows[0]?.payload['read_at']).toBeUndefined()
  })

  it('400s when the id is not a uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)

    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl('/api/notifications/not-a-uuid/read'), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Admin queue + workflow-event surface. Mirrors rental-billing-state.test.ts:
// list shape, 403 gating, RETRY happy path + event log, 409 stale, 409
// illegal, 404. Uses a dedicated fake pool that models the
// notifications ↔ workflow_event_log lateral join the queue join relies on,
// since the canonical eight-state vocabulary lives in snapshot_after.
// ---------------------------------------------------------------------------

type QueueStoredRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  status: string
  state_version: number
  error: string | null
  last_delivery_error: string | null
  delivery_attempts: number
  next_attempt_at: string | null
  sent_at: string | null
  created_at: string
}

type EventLogRow = {
  entity_id: string
  state_version: number
  event_type: string
  snapshot_after: Record<string, unknown>
  workflow_name: string
}

class QueueFakePool {
  rows: QueueStoredRow[] = []
  // entity_id → latest snapshot_after (highest state_version), modeling the
  // lateral join the queue SELECT performs.
  snapshots = new Map<string, Record<string, unknown>>()
  workflowEvents: EventLogRow[] = []

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

  private project(row: QueueStoredRow) {
    return {
      id: row.id,
      company_id: row.company_id,
      recipient_clerk_user_id: row.recipient_clerk_user_id,
      recipient_email: row.recipient_email,
      kind: row.kind,
      subject: row.subject,
      status: row.status,
      state_version: row.state_version,
      error: row.error,
      last_delivery_error: row.last_delivery_error,
      delivery_attempts: row.delivery_attempts,
      next_attempt_at: row.next_attempt_at,
      sent_at: row.sent_at,
      created_at: row.created_at,
    }
  }

  async query(sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // Queue list / locked read: select ... from notifications n left join lateral ...
    if (/from notifications n/i.test(sql) && /^select/i.test(sql)) {
      const companyId = params[0] as string
      const byId = / n\.id = \$2/i.test(sql)
      const id = byId ? (params[1] as string) : null
      // state filter params, if present, are appended after companyId:
      // $2 = canonical state, $3 = legacy status (list path only).
      const canonicalState = !byId && params.length >= 3 ? (params[1] as string) : null
      const legacyStatus = !byId && params.length >= 3 ? (params[2] as string) : null

      const matched = this.rows
        .filter((r) => r.company_id === companyId)
        .filter((r) => (id ? r.id === id : true))
        .filter((r) => {
          if (!canonicalState) return true
          const snap = this.snapshots.get(r.id)
          if (snap) return snap.state === canonicalState
          return r.status === legacyStatus
        })
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .map((r) => ({ ...this.project(r), snapshot_after: this.snapshots.get(r.id) ?? null }))
      return { rows: matched, rowCount: matched.length }
    }

    if (/^update notifications/i.test(sql)) {
      const [companyId, id, status, stateVersion] = params as [string, string, string, number]
      const row = this.rows.find((r) => r.company_id === companyId && r.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      if (/error = \$5/i.test(sql)) {
        row.error = (params[4] as string | null) ?? null
      } else {
        // RETRY path clears error + last_delivery_error + resets schedule.
        row.error = null
        row.last_delivery_error = null
        row.next_attempt_at = '2026-05-26T00:00:00.000Z'
      }
      return { rows: [{ ...this.project(row), snapshot_after: null }], rowCount: 1 }
    }

    if (/^insert into workflow_event_log/i.test(sql)) {
      const row: EventLogRow = {
        entity_id: params[4] as string,
        workflow_name: params[1] as string,
        state_version: params[5] as number,
        event_type: params[6] as string,
        snapshot_after: JSON.parse(params[8] as string),
      }
      this.workflowEvents.push(row)
      // Keep the lateral-join snapshot current: highest state_version wins.
      this.snapshots.set(row.entity_id, row.snapshot_after)
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in QueueFakePool: ${sql.slice(0, 200)}`)
  }
}

const QN_ID = '00000000-0000-4000-8000-0000000000aa'

function seedQueue(pool: QueueFakePool, overrides: Partial<QueueStoredRow> = {}): QueueStoredRow {
  const row: QueueStoredRow = {
    id: QN_ID,
    company_id: 'co-1',
    recipient_clerk_user_id: 'user_worker_1',
    recipient_email: 'crew@example.com',
    kind: 'worker_issue_resolved',
    subject: 'Your foreman replied',
    status: 'pending',
    state_version: 1,
    error: null,
    last_delivery_error: null,
    delivery_attempts: 0,
    next_attempt_at: '2026-05-09T08:00:00.000Z',
    sent_at: null,
    created_at: '2026-05-09T08:00:00.000Z',
    ...overrides,
  }
  pool.rows.push(row)
  return row
}

// Stamp an authoritative workflow snapshot for a row (models a worker that
// drove the row to a failed terminal and wrote workflow_event_log).
function seedSnapshot(pool: QueueFakePool, entityId: string, snapshot: Record<string, unknown>): void {
  pool.snapshots.set(entityId, snapshot)
}

function makeQueueCtx(
  pool: QueueFakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): { ctx: NotificationRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'admin-1',
      requireRole: (allowed) => {
        if ((allowed as readonly string[]).includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, b) => {
        responses.push({ status, body: b })
      },
    },
  }
}

describe('handleNotificationRoutes — GET /api/notifications/queue', () => {
  it('returns company-scoped rows with workflow delivery columns', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { id: '00000000-0000-4000-8000-0000000000b1', status: 'sent', state_version: 3 })
    seedSnapshot(pool, '00000000-0000-4000-8000-0000000000b1', {
      state: 'sent',
      state_version: 3,
      channel: 'email',
      sent_at: '2026-05-09T09:00:00.000Z',
      error: null,
      failure_kind: null,
    })
    const { ctx, responses } = makeQueueCtx(pool)
    await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications/queue'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as {
      notifications: Array<{
        id: string
        state: string
        state_version: number
        channel: string | null
        failure_kind: string | null
        subject: string
        recipient_email: string | null
      }>
    }
    expect(body.notifications).toHaveLength(1)
    const r = body.notifications[0]!
    expect(r.state).toBe('sent')
    expect(r.state_version).toBe(3)
    expect(r.channel).toBe('email')
    expect(r.failure_kind).toBeNull()
    expect(r.recipient_email).toBe('crew@example.com')
  })

  it('rejects non-admin/office callers with 403', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool)
    const { ctx, responses } = makeQueueCtx(pool, {}, 'member')
    await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications/queue'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('does not leak across companies', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { company_id: 'co-other' })
    const { ctx, responses } = makeQueueCtx(pool)
    await handleNotificationRoutes({ method: 'GET' } as never, buildUrl('/api/notifications/queue'), ctx)
    const body = responses[0]?.body as { notifications: unknown[] }
    expect(body.notifications).toEqual([])
  })

  it('filters by canonical workflow state via the event-log snapshot', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { id: '00000000-0000-4000-8000-0000000000c1', status: 'failed', state_version: 4 })
    seedSnapshot(pool, '00000000-0000-4000-8000-0000000000c1', {
      state: 'failed_provider',
      state_version: 4,
      error: 'smtp 550',
      failure_kind: 'provider',
      failed_at: '2026-05-09T10:00:00.000Z',
    })
    seedQueue(pool, { id: '00000000-0000-4000-8000-0000000000c2', status: 'sent', state_version: 3 })
    seedSnapshot(pool, '00000000-0000-4000-8000-0000000000c2', {
      state: 'sent',
      state_version: 3,
      channel: 'email',
    })
    const { ctx, responses } = makeQueueCtx(pool)
    await handleNotificationRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/notifications/queue?state=failed_provider'),
      ctx,
    )
    const body = responses[0]?.body as {
      notifications: Array<{ id: string; state: string; failure_kind: string | null; error: string | null }>
    }
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0]?.state).toBe('failed_provider')
    expect(body.notifications[0]?.failure_kind).toBe('provider')
    expect(body.notifications[0]?.error).toBe('smtp 550')
  })

  it('returns an empty list for an unknown state value', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool)
    const { ctx, responses } = makeQueueCtx(pool)
    await handleNotificationRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/notifications/queue?state=not-a-state'),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect((responses[0]?.body as { notifications: unknown[] }).notifications).toEqual([])
  })
})

describe('handleNotificationRoutes — POST /api/notifications/:id/events', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { status: 'failed', state_version: 2 })
    seedSnapshot(pool, QN_ID, { state: 'failed_provider', state_version: 2, failure_kind: 'provider' })
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 2 }, 'member')
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('RETRY: failed_provider → pending, resets schedule, writes event log', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { status: 'failed', state_version: 2, error: 'smtp 550', last_delivery_error: 'smtp 550' })
    seedSnapshot(pool, QN_ID, {
      state: 'failed_provider',
      state_version: 2,
      error: 'smtp 550',
      failure_kind: 'provider',
    })
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 2 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as {
      state: string
      state_version: number
      next_events: Array<{ type: string }>
      context: { error: string | null; failure_kind: string | null; next_attempt_at: string | null }
    }
    expect(snap.state).toBe('pending')
    expect(snap.state_version).toBe(3)
    // RETRY clears the failure discriminators.
    expect(snap.context.error).toBeNull()
    expect(snap.context.failure_kind).toBeNull()
    // Schedule reset so the worker re-claims the row.
    expect(snap.context.next_attempt_at).not.toBeNull()
    // Row persisted as the collapsed legacy status.
    expect(pool.rows[0]?.status).toBe('pending')
    expect(pool.rows[0]?.state_version).toBe(3)
    // Event log written against the pre-transition version.
    expect(pool.workflowEvents).toHaveLength(1)
    expect(pool.workflowEvents[0]?.event_type).toBe('RETRY')
    expect(pool.workflowEvents[0]?.state_version).toBe(2)
    expect(pool.workflowEvents[0]?.workflow_name).toBe('notification')
  })

  it('VOID: pending → voided and stashes the reason', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { status: 'pending', state_version: 1 })
    const { ctx, responses } = makeQueueCtx(pool, { event: 'VOID', state_version: 1, reason: 'duplicate' })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const snap = responses[0]?.body as { state: string; context: { error: string | null } }
    expect(snap.state).toBe('voided')
    expect(snap.context.error).toBe('duplicate')
    expect(pool.rows[0]?.status).toBe('voided')
  })

  it('returns 409 on a stale state_version without writing an event log', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { status: 'failed', state_version: 5 })
    seedSnapshot(pool, QN_ID, { state: 'failed_provider', state_version: 5, failure_kind: 'provider' })
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 2 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
    expect(pool.rows[0]?.state_version).toBe(5)
  })

  it('returns 409 on an illegal transition (RETRY from sent)', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool, { status: 'sent', state_version: 3 })
    seedSnapshot(pool, QN_ID, { state: 'sent', state_version: 3, channel: 'email' })
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 3 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.workflowEvents).toHaveLength(0)
  })

  it('returns 404 for an unknown notification id', async () => {
    const pool = new QueueFakePool()
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 1 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('400s when the id is not a uuid', async () => {
    const pool = new QueueFakePool()
    const { ctx, responses } = makeQueueCtx(pool, { event: 'RETRY', state_version: 1 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl('/api/notifications/not-a-uuid/events'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('400s on an invalid event body', async () => {
    const pool = new QueueFakePool()
    seedQueue(pool)
    const { ctx, responses } = makeQueueCtx(pool, { event: 'NONSENSE', state_version: 1 })
    await handleNotificationRoutes({ method: 'POST' } as never, buildUrl(`/api/notifications/${QN_ID}/events`), ctx)
    expect(responses[0]?.status).toBe(400)
  })
})

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
      // last param is the limit; the parsed kind (if present) is the
      // 3rd positional after company + recipient.
      const limit = rest.length > 0 ? Number(rest[rest.length - 1]) : 20
      const kind = rest.length === 2 ? (rest[0] as string) : null
      const unreadOnly = /payload->>'read_at'\) is null/.test(trimmed)
      const filtered = this.rows
        .filter((r) => r.company_id === companyId)
        .filter((r) => r.recipient_clerk_user_id === recipientId)
        .filter((r) => (kind ? r.kind === kind : true))
        .filter((r) => (unreadOnly ? r.payload['read_at'] === undefined : true))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, limit)
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

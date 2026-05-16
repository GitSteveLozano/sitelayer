import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleWorkerRoutes, type WorkerRouteCtx } from './workers.js'

/**
 * Tests for the message-a-worker route. Other workers routes (CRUD) are
 * covered indirectly via integration tests; this file zeroes in on the
 * one branch that's new — POST /api/workers/:id/messages — because it
 * does its own clerk-user-id resolution and only happens to live in the
 * workers route file.
 *
 * The FakePool below stubs only the three SQL fragments the route runs:
 *   1. select set_config — RLS scoping inside withCompanyClient
 *   2. select … from (worker_issues UNION clock_events) sources — the
 *      worker → clerk_user_id lookup
 *   3. insert into notifications — the notification enqueue
 */

type IssueRow = { worker_id: string; reporter_clerk_user_id: string | null; created_at: string }
type ClockRow = { worker_id: string; clerk_user_id: string | null; occurred_at: string }
type NotificationRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  body_text: string
  body_html: string | null
  payload: Record<string, unknown>
}

class FakePool {
  issues: IssueRow[] = []
  clocks: ClockRow[] = []
  notifications: NotificationRow[] = []
  private idCounter = 0

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

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim()

    if (
      trimmed.startsWith('begin') ||
      trimmed.startsWith('commit') ||
      trimmed.startsWith('rollback') ||
      trimmed.startsWith('select set_config') ||
      trimmed.startsWith('set local')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // The lookup query: worker_issues UNION clock_events, ordered desc, limit 1.
    if (/from worker_issues[\s\S]+union all[\s\S]+from clock_events/i.test(trimmed)) {
      const [companyId, workerId] = params as [string, string]
      void companyId
      const fromIssues = this.issues
        .filter((r) => r.worker_id === workerId && r.reporter_clerk_user_id !== null)
        .map((r) => ({ clerk_user_id: r.reporter_clerk_user_id as string, created_at: r.created_at }))
      const fromClocks = this.clocks
        .filter((r) => r.worker_id === workerId && r.clerk_user_id !== null)
        .map((r) => ({ clerk_user_id: r.clerk_user_id as string, created_at: r.occurred_at }))
      const merged = [...fromIssues, ...fromClocks].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 1)
      return { rows: merged.map(({ clerk_user_id }) => ({ clerk_user_id })), rowCount: merged.length }
    }

    if (/^insert into notifications/i.test(trimmed)) {
      const [companyId, recipientId, recipientEmail, kind, subject, bodyText, bodyHtml, payload] = params as [
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string,
      ]
      this.idCounter += 1
      const row: NotificationRow = {
        id: `00000000-0000-4000-8000-${String(this.idCounter).padStart(12, '0')}`,
        company_id: companyId,
        recipient_clerk_user_id: recipientId,
        recipient_email: recipientEmail,
        kind,
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        payload: JSON.parse(payload) as Record<string, unknown>,
      }
      this.notifications.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  options: { role?: 'admin' | 'foreman' | 'office' | 'member' | 'bookkeeper' } = {},
): { ctx: WorkerRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const role = options.role ?? 'foreman'
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      currentUserId: 'user_foreman_1',
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, payload) => {
        responses.push({ status, body: payload })
      },
      checkVersion: async () => false,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

const WORKER_ID = '00000000-0000-4000-8000-000000000001'

describe('handleWorkerRoutes — POST /api/workers/:id/messages', () => {
  it('inserts a notification addressed to the worker_issues reporter clerk_user_id', async () => {
    const pool = new FakePool()
    pool.issues.push({
      worker_id: WORKER_ID,
      reporter_clerk_user_id: 'user_worker_42',
      created_at: '2026-05-15T10:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: 'Bring the spare ladders next trip' })

    const handled = await handleWorkerRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/workers/${WORKER_ID}/messages`),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { notification_id: string; recipient_clerk_user_id: string }
    expect(body.recipient_clerk_user_id).toBe('user_worker_42')

    expect(pool.notifications).toHaveLength(1)
    const inserted = pool.notifications[0]!
    expect(inserted.recipient_clerk_user_id).toBe('user_worker_42')
    expect(inserted.kind).toBe('foreman_message')
    expect(inserted.subject).toBe('Message from foreman')
    expect(inserted.body_text).toBe('Bring the spare ladders next trip')
    expect(inserted.payload).toMatchObject({ worker_id: WORKER_ID, from_clerk_user_id: 'user_foreman_1' })
  })

  it('falls back to clock_events.clerk_user_id when no worker_issues row exists', async () => {
    const pool = new FakePool()
    pool.clocks.push({
      worker_id: WORKER_ID,
      clerk_user_id: 'user_worker_self_clocked',
      occurred_at: '2026-05-16T07:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: 'Hello' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(201)
    expect(pool.notifications[0]?.recipient_clerk_user_id).toBe('user_worker_self_clocked')
  })

  it('prefers the more recent source when both exist (clock_events newer than worker_issues)', async () => {
    const pool = new FakePool()
    pool.issues.push({
      worker_id: WORKER_ID,
      reporter_clerk_user_id: 'older_clerk',
      created_at: '2026-05-10T10:00:00.000Z',
    })
    pool.clocks.push({
      worker_id: WORKER_ID,
      clerk_user_id: 'newer_clerk',
      occurred_at: '2026-05-16T07:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: 'Hi' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(201)
    expect(pool.notifications[0]?.recipient_clerk_user_id).toBe('newer_clerk')
  })

  it('returns 422 when the worker has no clerk_user_id anywhere', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { body: 'Hi' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(422)
    expect((responses[0]?.body as { worker_id: string }).worker_id).toBe(WORKER_ID)
    expect(pool.notifications).toHaveLength(0)
  })

  it('rejects an empty body with 400', async () => {
    const pool = new FakePool()
    pool.issues.push({
      worker_id: WORKER_ID,
      reporter_clerk_user_id: 'user_worker_42',
      created_at: '2026-05-15T10:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: '   ' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.notifications).toHaveLength(0)
  })

  it('rejects a body over 2000 characters with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { body: 'x'.repeat(2001) })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects a non-foreman/admin/office caller with 403', async () => {
    const pool = new FakePool()
    pool.issues.push({
      worker_id: WORKER_ID,
      reporter_clerk_user_id: 'user_worker_42',
      created_at: '2026-05-15T10:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: 'Hello' }, { role: 'member' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.notifications).toHaveLength(0)
  })

  it('respects an explicit subject when provided', async () => {
    const pool = new FakePool()
    pool.issues.push({
      worker_id: WORKER_ID,
      reporter_clerk_user_id: 'user_worker_42',
      created_at: '2026-05-15T10:00:00.000Z',
    })
    const { ctx, responses } = makeCtx(pool, { body: 'Hi', subject: 'Quick question' })

    await handleWorkerRoutes({ method: 'POST' } as never, buildUrl(`/api/workers/${WORKER_ID}/messages`), ctx)
    expect(responses[0]?.status).toBe(201)
    expect(pool.notifications[0]?.subject).toBe('Quick question')
  })
})

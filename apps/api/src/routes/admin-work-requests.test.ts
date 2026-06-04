import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Identity } from '../auth.js'
import { handleAdminWorkRequestRoutes } from './admin-work-requests.js'

type Response = { status: number; body: unknown }

class FakePool {
  queries: Array<{ sql: string; params: unknown[] }> = []
  boardRows: Array<Record<string, unknown>> = []

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from platform_admins')) {
      return { rows: params[0] === 'admin-1' ? [{ '?column?': 1 }] : [], rowCount: params[0] === 'admin-1' ? 1 : 0 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('join companies c')) {
      return { rows: this.boardRows, rowCount: this.boardRows.length }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method } as http.IncomingMessage
}

function buildUrl(path = '/api/admin/work-requests/board'): URL {
  return new URL(`http://localhost${path}`)
}

function makeDeps(pool: FakePool, identity: Identity = { userId: 'admin-1', source: 'clerk' }) {
  const responses: Response[] = []
  return {
    responses,
    deps: {
      pool,
      identity,
      sendJson: (status: number, body: unknown) => responses.push({ status, body }),
      envIds: new Set<string>(),
    },
  }
}

function boardRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    company_id: '11111111-1111-4111-8111-111111111111',
    company_slug: 'co-a',
    company_name: 'Company A',
    support_packet_id: '00000000-0000-4000-8000-000000000301',
    title: 'Capture issue',
    summary: 'Something broke',
    status: 'new',
    lane: 'triage',
    severity: 'normal',
    route: '/desktop',
    capture_session_id: null,
    entity_type: 'feedback',
    entity_id: 'fb-1',
    assignee_user_id: null,
    created_by_user_id: 'user-1',
    created_at: '2026-06-04T12:00:00.000Z',
    updated_at: '2026-06-04T12:01:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: '2026-06-05T12:00:00.000Z',
    ...overrides,
  }
}

describe('handleAdminWorkRequestRoutes', () => {
  it('ignores non-admin work-request board paths', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool)

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl('/api/work-requests/board'), deps)

    expect(handled).toBe(false)
    expect(responses).toHaveLength(0)
    expect(pool.queries).toHaveLength(0)
  })

  it('requires a verified platform admin identity', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool, { userId: 'demo-user', source: 'default' })

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]).toMatchObject({
      status: 401,
      body: { error: 'platform admin requires a verified Clerk session' },
    })
    expect(pool.queries).toHaveLength(0)
  })

  it('returns cross-tenant board columns with tenant identity on every item', async () => {
    const pool = new FakePool()
    const statuses = [
      'new',
      'triaged',
      'agent_running',
      'human_assigned',
      'review_ready',
      'review_stale',
      'proposal_expired',
      'resolved',
      'reopened',
      'wont_do',
      'reversed',
    ]
    pool.boardRows = statuses.map((status, index) =>
      boardRow({
        id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
        title: `Status ${status}`,
        status,
        company_slug: index % 2 === 0 ? 'co-a' : 'co-b',
        company_name: index % 2 === 0 ? 'Company A' : 'Company B',
        lane: status === 'resolved' || status === 'wont_do' || status === 'reversed' ? 'done' : 'triage',
      }),
    )
    const { deps, responses } = makeDeps(pool)

    const handled = await handleAdminWorkRequestRoutes(buildReq(), buildUrl(), deps)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      columns: Array<{ id: string; statuses: string[]; work_items: Array<{ company_slug: string }> }>
      work_items: Array<{ company_slug: string; company_name: string }>
    }
    expect(body.columns.map((column) => column.id)).toEqual(['new', 'triaged', 'in_progress', 'done'])
    expect(body.columns.flatMap((column) => column.statuses).sort()).toEqual([...statuses].sort())
    expect(body.work_items.every((item) => item.company_slug && item.company_name)).toBe(true)
    expect(pool.queries.at(-1)?.sql).toContain('join companies c on c.id = w.company_id')
  })

  it('validates filters and passes safe filters as query params', async () => {
    const pool = new FakePool()
    const { deps, responses } = makeDeps(pool)

    await handleAdminWorkRequestRoutes(
      buildReq(),
      buildUrl('/api/admin/work-requests/board?company_id=bad&status=new'),
      deps,
    )

    expect(responses[0]).toMatchObject({ status: 400, body: { error: 'company_id must be a uuid' } })

    const ok = makeDeps(pool)
    await handleAdminWorkRequestRoutes(
      buildReq(),
      buildUrl('/api/admin/work-requests/board?company_slug=co-a&status=new&lane=triage&assignee_user_id=operator'),
      ok.deps,
    )

    expect(ok.responses[0]?.status).toBe(200)
    expect(pool.queries.at(-1)?.params).toEqual(['co-a', 'new', 'triage', 'operator', 200, 0])
  })
})

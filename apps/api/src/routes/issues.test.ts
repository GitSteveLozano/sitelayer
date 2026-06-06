import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany } from '../auth-types.js'
import type { Capability } from '@sitelayer/domain'
import { attachMutationTx } from '../mutation-tx.js'
import { handleIssueRoutes, type IssueRouteCtx } from './issues.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const APP_ISSUE_ID = '22222222-2222-4222-8222-222222222222'
const FIELD_REQUEST_ID = '33333333-3333-4333-8333-333333333333'

type Row = Record<string, unknown>

function workItem(id: string, domain: 'app_issue' | 'field_request'): Row {
  return {
    id,
    company_id: COMPANY_ID,
    support_packet_id: `sp-${id}`,
    domain,
    title: `${domain} ${id}`,
    summary: null,
    status: 'new',
    lane: 'triage',
    severity: null,
    route: '/x',
    capture_session_id: domain === 'app_issue' ? '44444444-4444-4444-8444-444444444444' : null,
    entity_type: null,
    entity_id: null,
    assignee_user_id: null,
    created_by_user_id: 'user-1',
    created_at: '2026-05-21T12:00:00.000Z',
    updated_at: '2026-05-21T12:00:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: null,
    metadata: {},
  }
}

// Two rows: one app_issue, one field_request. The list/detail SQL must only
// ever surface the app_issue row through this platform surface.
class FakeIssuePool {
  rows: Row[] = [workItem(APP_ISSUE_ID, 'app_issue'), workItem(FIELD_REQUEST_ID, 'field_request')]

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private async dispatch(sqlRaw: string, params: unknown[] = []) {
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    // listContextWorkItems — the consumer pins domain='app_issue' via a param.
    if (normalized.includes('from context_work_items') && normalized.includes('order by updated_at desc')) {
      const domainParam = params.find((p) => p === 'app_issue' || p === 'field_request') as string | undefined
      const rows = this.rows.filter((r) => (domainParam ? r.domain === domainParam : true))
      return { rows, rowCount: rows.length }
    }
    // getContextWorkItemWithEvents — single row by id (no domain predicate; the
    // consumer applies the domain guard in TS).
    if (normalized.includes('from context_work_items w') && normalized.includes('left join support_debug_packets')) {
      const id = params[1] as string
      const row = this.rows.find((r) => r.id === id)
      return { rows: row ? [{ ...row, support_packet: null }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('count(*)')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (normalized.includes('from context_handoff_events')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method, headers: {} } as http.IncomingMessage
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(
  pool: FakeIssuePool,
  allow: boolean,
): { ctx: IssueRouteCtx; responses: Array<{ status: number; body: unknown }>; capabilityChecks: Capability[] } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const capabilityChecks: Capability[] = []
  const company: ActiveCompany = { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' }
  return {
    responses,
    capabilityChecks,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      requireCapability: async (capability) => {
        capabilityChecks.push(capability)
        if (!allow) responses.push({ status: 403, body: { error: 'forbidden', capability } })
        return allow
      },
      sendJson: (status, body) => responses.push({ status, body }),
    },
  }
}

describe('internal app-issue surface (/api/issues)', () => {
  it('gates every route on app_issue.view (403 + nothing else when denied)', async () => {
    for (const path of ['/api/issues', '/api/issues/board', `/api/issues/${APP_ISSUE_ID}`]) {
      const pool = new FakeIssuePool()
      const { ctx, responses, capabilityChecks } = makeCtx(pool, false)
      const handled = await handleIssueRoutes(buildReq('GET'), buildUrl(path), ctx)
      expect(handled).toBe(true)
      expect(capabilityChecks).toEqual(['app_issue.view'])
      expect(responses).toEqual([{ status: 403, body: { error: 'forbidden', capability: 'app_issue.view' } }])
    }
  })

  it('GET /api/issues lists ONLY app_issue rows (never a field_request)', async () => {
    const pool = new FakeIssuePool()
    const { ctx, responses } = makeCtx(pool, true)
    await handleIssueRoutes(buildReq('GET'), buildUrl('/api/issues'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { issues: Array<{ id: string; domain: string }> }
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0]?.id).toBe(APP_ISSUE_ID)
    expect(body.issues.every((i) => i.domain === 'app_issue')).toBe(true)
  })

  it('GET /api/issues/board groups ONLY app_issue rows into columns', async () => {
    const pool = new FakeIssuePool()
    const { ctx, responses } = makeCtx(pool, true)
    await handleIssueRoutes(buildReq('GET'), buildUrl('/api/issues/board'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      group_by: string
      issues: Array<{ id: string }>
      columns: Array<{ id: string; work_items: Array<{ id: string }> }>
    }
    expect(body.group_by).toBe('status_group')
    expect(body.issues.map((i) => i.id)).toEqual([APP_ISSUE_ID])
    const newColumn = body.columns.find((c) => c.id === 'new')
    expect(newColumn?.work_items.map((i) => i.id)).toEqual([APP_ISSUE_ID])
  })

  it('GET /api/issues/:id returns the app_issue detail', async () => {
    const pool = new FakeIssuePool()
    const { ctx, responses } = makeCtx(pool, true)
    await handleIssueRoutes(buildReq('GET'), buildUrl(`/api/issues/${APP_ISSUE_ID}`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { issue: { id: string; domain: string } }
    expect(body.issue.id).toBe(APP_ISSUE_ID)
    expect(body.issue.domain).toBe('app_issue')
  })

  it('GET /api/issues/:id 404s a field_request id (domains cannot bleed)', async () => {
    const pool = new FakeIssuePool()
    const { ctx, responses } = makeCtx(pool, true)
    await handleIssueRoutes(buildReq('GET'), buildUrl(`/api/issues/${FIELD_REQUEST_ID}`), ctx)
    expect(responses[0]).toEqual({ status: 404, body: { error: 'issue not found' } })
  })
})

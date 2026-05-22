import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import { handleObstructionsRoutes, type ObstructionsRouteCtx, type ObstructionsResponse } from './obstructions.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

type StoredWorkItem = {
  id: string
  title: string
  status: string
  lane: 'agent' | 'human' | 'both' | 'triage' | 'done'
  severity: string | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  updated_at: string
  metadata: Record<string, unknown>
}

type StoredOutbox = {
  work_item_id: string
  status: 'pending' | 'processing' | 'failed' | 'dead' | 'applied'
  next_attempt_at: string | null
  applied_at: string | null
  attempt_count: number
}

type StoredEvent = {
  work_item_id: string
  event_type: string
  actor_kind: string
  recorded_at: string
}

class FakePool {
  workItems: StoredWorkItem[] = []
  outbox: StoredOutbox[] = []
  events: StoredEvent[] = []

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

    // The obstructions query uses CTEs (`with ... as (...) ...`). The
    // FakePool walks one query path: when we see the CTE-bearing select
    // we synthesize the merged rows in memory.
    if (normalized.includes('with status_obstructions') && normalized.includes('merged')) {
      const companyId = params[0] as string
      const dispatchMutationType = params[1] as string
      const statusObstructions: StoredWorkItem[] = this.workItems.filter(
        (item) => item.status === 'review_stale' || item.status === 'proposal_expired' || item.status === 'wont_do',
      )
      const deadDispatches: StoredWorkItem[] = this.workItems.filter((item) => {
        if (item.status === 'resolved' || item.status === 'wont_do') return false
        const latestDead = this.outbox
          .filter(
            (o) =>
              o.work_item_id === item.id &&
              dispatchMutationType === 'dispatch_mesh_work_request' &&
              (o.status === 'failed' || o.status === 'dead'),
          )
          .sort((a, b) => (b.attempt_count ?? 0) - (a.attempt_count ?? 0))[0]
        return Boolean(latestDead)
      })
      const seen = new Set(statusObstructions.map((i) => i.id))
      const dedupedDead = deadDispatches.filter((i) => !seen.has(i.id))
      type MergedRow = {
        work_item_id: string
        title: string
        status: string
        lane: 'agent' | 'human' | 'both' | 'triage' | 'done'
        severity: string | null
        route: string | null
        entity_type: string | null
        entity_id: string | null
        assignee_user_id: string | null
        blocked_since: string
        derived_status: string
        reversibility_window_seconds: number | null
        last_event_type: string | null
        last_event_occurred_at: string | null
        last_event_actor_kind: string | null
      }
      const merged: MergedRow[] = []
      for (const item of statusObstructions) {
        if (item.lane === 'triage' || item.lane === 'done') continue
        merged.push({
          work_item_id: item.id,
          title: item.title,
          status: item.status,
          lane: item.lane,
          severity: item.severity,
          route: item.route,
          entity_type: item.entity_type,
          entity_id: item.entity_id,
          assignee_user_id: item.assignee_user_id,
          blocked_since: item.updated_at,
          derived_status: item.status,
          reversibility_window_seconds: extractWindow(item.metadata),
          last_event_type: null,
          last_event_occurred_at: null,
          last_event_actor_kind: null,
        })
      }
      for (const item of dedupedDead) {
        if (item.lane === 'triage' || item.lane === 'done') continue
        merged.push({
          work_item_id: item.id,
          title: item.title,
          status: item.status,
          lane: item.lane,
          severity: item.severity,
          route: item.route,
          entity_type: item.entity_type,
          entity_id: item.entity_id,
          assignee_user_id: item.assignee_user_id,
          blocked_since: item.updated_at,
          derived_status: 'dead',
          reversibility_window_seconds: extractWindow(item.metadata),
          last_event_type: null,
          last_event_occurred_at: null,
          last_event_actor_kind: null,
        })
      }
      // Fill latest events
      for (const row of merged) {
        const latest = this.events
          .filter((e) => e.work_item_id === row.work_item_id)
          .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0]
        if (latest) {
          row.last_event_type = latest.event_type
          row.last_event_occurred_at = latest.recorded_at
          row.last_event_actor_kind = latest.actor_kind
        }
      }
      // Mirror the real SQL: `order by m.blocked_since asc nulls last,
      // m.work_item_id asc`. The FakePool was emitting rows in the order
      // they were pushed (status_obstructions then dead_dispatches), but
      // the SQL would sort by blocked_since.
      merged.sort((a, b) => {
        const aTime = a.blocked_since ?? ''
        const bTime = b.blocked_since ?? ''
        if (aTime !== bTime) return aTime.localeCompare(bTime)
        return a.work_item_id.localeCompare(b.work_item_id)
      })
      void companyId
      return { rows: merged, rowCount: merged.length }
    }

    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

function extractWindow(metadata: Record<string, unknown>): number | null {
  const raw = metadata['reversibility_window_seconds']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method, headers: {} } as http.IncomingMessage
}

function buildUrl(path = '/api/work-requests/obstructions'): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(
  pool: FakePool,
  role: CompanyRole = 'admin',
  userId = 'user-1',
): { ctx: ObstructionsRouteCtx; responses: Array<{ status: number; body: unknown }> } {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = {
    id: COMPANY_ID,
    slug: 'co',
    name: 'Co',
    created_at: '',
    role,
  }
  const identity: Identity = { userId, source: 'default' }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      identity,
      requireRole: (allowed) => {
        const ok = allowed.includes(role)
        if (!ok) responses.push({ status: 403, body: { error: 'forbidden' } })
        return ok
      },
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
    },
  }
}

describe('handleObstructionsRoutes', () => {
  it('returns the merged obstruction list with rollup, sorted by blocked_since', async () => {
    const pool = new FakePool()
    pool.workItems = [
      {
        id: 'wi-stale',
        title: 'Stale review',
        status: 'review_stale',
        lane: 'both',
        severity: 'high',
        route: '/projects/p-1',
        entity_type: 'estimate_push',
        entity_id: 'e-1',
        assignee_user_id: 'user-1',
        updated_at: '2026-05-20T12:00:00.000Z',
        metadata: { reversibility_window_seconds: 86_400 },
      },
      {
        id: 'wi-expired',
        title: 'Proposal expired',
        status: 'proposal_expired',
        lane: 'agent',
        severity: 'urgent',
        route: null,
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-19T12:00:00.000Z',
        metadata: {},
      },
      {
        id: 'wi-wont',
        title: 'Wont do',
        status: 'wont_do',
        lane: 'human',
        severity: null,
        route: '/projects/p-2',
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-18T12:00:00.000Z',
        metadata: {},
      },
      {
        id: 'wi-dead',
        title: 'Dead dispatch',
        status: 'agent_running',
        lane: 'agent',
        severity: 'normal',
        route: '/projects/p-3',
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-21T06:00:00.000Z',
        metadata: { reversibility_window_seconds: 3600 },
      },
      {
        id: 'wi-healthy',
        title: 'Healthy item',
        status: 'review_ready',
        lane: 'both',
        severity: 'normal',
        route: null,
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-21T11:00:00.000Z',
        metadata: {},
      },
    ]
    pool.outbox = [
      { work_item_id: 'wi-dead', status: 'dead', next_attempt_at: null, applied_at: null, attempt_count: 5 },
    ]
    pool.events = [
      {
        work_item_id: 'wi-stale',
        event_type: 'work_item.status_changed',
        actor_kind: 'system',
        recorded_at: '2026-05-20T12:00:01.000Z',
      },
    ]
    const { ctx, responses } = makeCtx(pool)

    const handled = await handleObstructionsRoutes(buildReq(), buildUrl(), ctx)

    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as ObstructionsResponse
    expect(body.total).toBe(4)
    // Sorted by blocked_since asc: wi-wont (2026-05-18), wi-expired (05-19),
    // wi-stale (05-20), wi-dead (05-21).
    expect(body.obstructions.map((row) => row.work_item_id)).toEqual([
      'wi-wont',
      'wi-expired',
      'wi-stale',
      'wi-dead',
    ])
    expect(body.by_status).toEqual({ review_stale: 1, proposal_expired: 1, wont_do: 1, dead: 1 })

    const stale = body.obstructions.find((row) => row.work_item_id === 'wi-stale')!
    expect(stale.status).toBe('review_stale')
    expect(stale.suggested_action).toContain('Resume review')
    expect(stale.blocked_reason).toContain('Review not picked up')
    expect(stale.last_event?.type).toBe('work_item.status_changed')

    const wontDo = body.obstructions.find((row) => row.work_item_id === 'wi-wont')!
    expect(wontDo.suggested_action).toContain('Archive')
    expect(wontDo.reversibility_available).toBe(false)

    const dead = body.obstructions.find((row) => row.work_item_id === 'wi-dead')!
    expect(dead.status).toBe('dead')
    expect(dead.suggested_action).toContain('Investigate dispatch outbox')

    const expired = body.obstructions.find((row) => row.work_item_id === 'wi-expired')!
    expect(expired.suggested_action).toContain('Re-dispatch')
    // wi-expired has no reversibility window in metadata → optimistically open
    expect(expired.reversibility_available).toBe(true)
  })

  it('filters by lane when the lane query param is provided', async () => {
    const pool = new FakePool()
    pool.workItems = [
      {
        id: 'wi-agent',
        title: 'agent obstructed',
        status: 'proposal_expired',
        lane: 'agent',
        severity: 'normal',
        route: null,
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-20T12:00:00.000Z',
        metadata: {},
      },
      {
        id: 'wi-human',
        title: 'human obstructed',
        status: 'review_stale',
        lane: 'human',
        severity: 'normal',
        route: null,
        entity_type: null,
        entity_id: null,
        assignee_user_id: null,
        updated_at: '2026-05-19T12:00:00.000Z',
        metadata: {},
      },
    ]
    const { ctx, responses } = makeCtx(pool)
    await handleObstructionsRoutes(
      buildReq(),
      buildUrl('/api/work-requests/obstructions?lane=human'),
      ctx,
    )
    const body = responses[0]?.body as ObstructionsResponse
    expect(body.obstructions.map((row) => row.work_item_id)).toEqual(['wi-human'])
    expect(body.by_status).toEqual({ review_stale: 1, proposal_expired: 0, wont_do: 0, dead: 0 })
  })

  it('rejects an invalid lane filter with 400', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleObstructionsRoutes(
      buildReq(),
      buildUrl('/api/work-requests/obstructions?lane=bogus'),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects callers without a triage role', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, 'member', 'member-1')
    const handled = await handleObstructionsRoutes(buildReq(), buildUrl(), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(403)
  })

  it('returns total=0 when there are no obstructed items', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleObstructionsRoutes(buildReq(), buildUrl(), ctx)
    const body = responses[0]?.body as ObstructionsResponse
    expect(body.total).toBe(0)
    expect(body.obstructions).toEqual([])
    expect(body.by_status).toEqual({ review_stale: 0, proposal_expired: 0, wont_do: 0, dead: 0 })
  })
})

// Unit tests for the dispatch-lanes admin route handlers.
//
// Three routes:
//   GET  /api/admin/dispatch-lanes
//   POST /api/admin/dispatch-lanes/:name/pause
//   POST /api/admin/dispatch-lanes/:name/resume
//
// All three are admin-only; POST requires a non-empty reason.

import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { handleDispatchLaneRoutes, type DispatchLaneRouteCtx } from './dispatch-lanes.js'

type LaneState = 'active' | 'paused' | 'degraded'

interface LaneRow {
  name: string
  state: LaneState
  pause_reason: string
  paused_at: Date | null
  resume_after: Date | null
  last_decided_by: string
  last_decided_at: Date
  metadata: Record<string, unknown>
}

function buildResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

interface PoolFixture {
  lanes: Map<string, LaneRow>
}

function makeFakePool(fx: PoolFixture): Pool {
  let txnLane: string | null = null

  const exec = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const trimmed = sql.trim().toLowerCase()
    if (trimmed.startsWith('begin') || trimmed.startsWith('commit') || trimmed.startsWith('rollback')) {
      if (trimmed.startsWith('commit') || trimmed.startsWith('rollback')) txnLane = null
      return buildResult([])
    }
    if (trimmed.startsWith('select state from dispatch_lanes')) {
      const [name] = params as [string]
      const row = fx.lanes.get(name)
      if (!row) return buildResult([])
      txnLane = name
      return buildResult([{ state: row.state } as QueryResultRow])
    }
    if (trimmed.startsWith('select name, state, pause_reason')) {
      // The list query.
      const out = Array.from(fx.lanes.values()).map(serialize)
      return buildResult(out as QueryResultRow[])
    }
    if (trimmed.startsWith('update dispatch_lanes')) {
      const [, toState, reason, pausedAt, resumeAfter, decidedBy] = params as [
        string,
        LaneState,
        string,
        Date | null,
        Date | null,
        string,
      ]
      if (txnLane) {
        const existing = fx.lanes.get(txnLane)!
        const updated: LaneRow = {
          ...existing,
          state: toState,
          pause_reason: reason,
          paused_at: pausedAt,
          resume_after: resumeAfter,
          last_decided_by: decidedBy,
          last_decided_at: new Date(),
        }
        fx.lanes.set(txnLane, updated)
        return buildResult([serialize(updated) as QueryResultRow])
      }
      return buildResult([])
    }
    if (trimmed.startsWith('insert into dispatch_lane_decisions')) {
      return buildResult([])
    }
    return buildResult([])
  }

  const client: Partial<PoolClient> = {
    query: vi.fn(exec) as unknown as PoolClient['query'],
    release: vi.fn() as unknown as PoolClient['release'],
  }
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    query: vi.fn(exec) as unknown as Pool['query'],
  }
  return pool as Pool
}

function serialize(row: LaneRow) {
  return {
    name: row.name,
    state: row.state,
    pause_reason: row.pause_reason,
    paused_at: row.paused_at?.toISOString() ?? null,
    resume_after: row.resume_after?.toISOString() ?? null,
    last_decided_by: row.last_decided_by,
    last_decided_at: row.last_decided_at.toISOString(),
    metadata: row.metadata,
  }
}

function buildCtx(opts: {
  pool: Pool
  isAdmin: boolean
  body?: Record<string, unknown>
  currentUserId?: string
}): DispatchLaneRouteCtx & { sent: Array<{ status: number; body: unknown }> } {
  const sent: Array<{ status: number; body: unknown }> = []
  return {
    pool: opts.pool,
    requireRole: () => opts.isAdmin,
    readBody: async () => opts.body ?? {},
    sendJson: (status, body) => {
      sent.push({ status, body })
    },
    getCurrentUserId: () => opts.currentUserId ?? 'user_admin_1',
    sent,
  }
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleDispatchLaneRoutes', () => {
  it('GET returns the seeded lanes for admins', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'active',
            pause_reason: '',
            paused_at: null,
            resume_after: null,
            last_decided_by: 'system:seed',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({ pool: makeFakePool(fx), isAdmin: true })
    const handled = await handleDispatchLaneRoutes(
      { method: 'GET' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(ctx.sent[0]?.status).toBe(200)
    expect((ctx.sent[0]?.body as { lanes: unknown[] }).lanes).toHaveLength(1)
  })

  it('GET denies non-admins via requireRole', async () => {
    const ctx = buildCtx({ pool: makeFakePool({ lanes: new Map() }), isAdmin: false })
    const handled = await handleDispatchLaneRoutes(
      { method: 'GET' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes'),
      ctx,
    )
    expect(handled).toBe(true) // requireRole returns true → handler returns true after denying
    // The test ctx's requireRole returns false but doesn't actually send a 403
    // (production wires that into requireRole itself). We just verify no body
    // was sent — the helper short-circuits on `if (!requireRole(...)) return true`.
    expect(ctx.sent).toHaveLength(0)
  })

  it('POST /pause requires a non-empty reason (400 on empty)', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'active',
            pause_reason: '',
            paused_at: null,
            resume_after: null,
            last_decided_by: 'system:seed',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({ pool: makeFakePool(fx), isAdmin: true, body: { reason: '   ' } })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/estimate_push/pause'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(400)
  })

  it('POST /pause transitions an active lane to paused', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'active',
            pause_reason: '',
            paused_at: null,
            resume_after: null,
            last_decided_by: 'system:seed',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({
      pool: makeFakePool(fx),
      isAdmin: true,
      body: { reason: 'qbo_live_flip:dry-run' },
      currentUserId: 'user_admin_2',
    })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/estimate_push/pause'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(200)
    const lane = (ctx.sent[0]?.body as { lane: { state: LaneState; pause_reason: string } }).lane
    expect(lane.state).toBe('paused')
    expect(lane.pause_reason).toBe('qbo_live_flip:dry-run')
    expect(fx.lanes.get('estimate_push')?.last_decided_by).toBe('user_admin_2')
  })

  it('POST /resume flips a paused lane back to active', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'paused',
            pause_reason: 'manual',
            paused_at: new Date(),
            resume_after: null,
            last_decided_by: 'user_admin_2',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({
      pool: makeFakePool(fx),
      isAdmin: true,
      body: { reason: 'resolved' },
    })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/estimate_push/resume'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(200)
    expect(fx.lanes.get('estimate_push')?.state).toBe('active')
  })

  it('POST /resume on already-active lane is idempotent (200, just records a decision)', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'active',
            pause_reason: '',
            paused_at: null,
            resume_after: null,
            last_decided_by: 'system:seed',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({
      pool: makeFakePool(fx),
      isAdmin: true,
      body: { reason: 'double-check' },
    })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/estimate_push/resume'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(200)
  })

  it('POST /pause returns 404 for an unknown lane', async () => {
    const ctx = buildCtx({
      pool: makeFakePool({ lanes: new Map() }),
      isAdmin: true,
      body: { reason: 'unknown' },
    })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/does_not_exist/pause'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(404)
  })

  it('POST /pause rejects invalid resume_after', async () => {
    const fx: PoolFixture = {
      lanes: new Map([
        [
          'estimate_push',
          {
            name: 'estimate_push',
            state: 'active',
            pause_reason: '',
            paused_at: null,
            resume_after: null,
            last_decided_by: 'system:seed',
            last_decided_at: new Date(),
            metadata: {},
          },
        ],
      ]),
    }
    const ctx = buildCtx({
      pool: makeFakePool(fx),
      isAdmin: true,
      body: { reason: 'manual', resume_after: 'not-a-date' },
    })
    await handleDispatchLaneRoutes(
      { method: 'POST' } as unknown as http.IncomingMessage,
      url('/api/admin/dispatch-lanes/estimate_push/pause'),
      ctx,
    )
    expect(ctx.sent[0]?.status).toBe(400)
  })
})

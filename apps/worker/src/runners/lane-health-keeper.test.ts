// Unit tests for the lane-health-keeper auto-pause runner.
//
// Three signal families:
//   1. QBO circuit OPEN → flip QBO_LANES to 'paused'/qbo_circuit_open
//   2. mutation_outbox/sync_events pending > HIGH_WATER → degrade ALL lanes
//   3. Recovery: circuit closed clears qbo_circuit_open pauses; backlog
//      below LOW_WATER clears outbox_backlog_high degradations
//
// FakePool mirrors only the queries the keeper actually issues:
//   - SELECT state FROM integration_circuit_state WHERE integration='qbo'
//   - SELECT count(*) FROM mutation_outbox / sync_events
//   - SELECT name, state FROM dispatch_lanes WHERE ... (stale-row cleanup)
//   - Transactional UPDATE + INSERT via setLaneState

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { __resetDispatchLaneCachesForTests } from '../dispatch-lanes.js'
import { createLaneHealthKeeper } from './lane-health-keeper.js'

const testLogger = createLogger('lane-health-keeper-test', { level: 'silent' })

type LaneState = 'active' | 'paused' | 'degraded'

interface PoolFixture {
  qboCircuitState: 'open' | 'closed' | null
  outboxPending: number
  syncPending: number
  lanes: Map<string, { state: LaneState; pause_reason: string }>
}

function buildResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

function makeFakePool(fx: PoolFixture): { pool: Pool; transitions: Array<{ name: string; to: LaneState; reason: string }> } {
  const transitions: Array<{ name: string; to: LaneState; reason: string }> = []
  let txnLane: string | null = null
  let txnFromState: LaneState | null = null

  const exec = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const trimmed = sql.trim().toLowerCase()
    if (trimmed.startsWith('begin') || trimmed.startsWith('commit') || trimmed.startsWith('rollback')) {
      if (trimmed.startsWith('commit') || trimmed.startsWith('rollback')) {
        txnLane = null
        txnFromState = null
      }
      return buildResult([])
    }

    if (trimmed.startsWith('select state from integration_circuit_state')) {
      if (fx.qboCircuitState === null) return buildResult([])
      return buildResult([{ state: fx.qboCircuitState } as QueryResultRow])
    }

    if (trimmed.includes('from mutation_outbox')) {
      return buildResult([{ pending: fx.outboxPending } as QueryResultRow])
    }
    if (trimmed.includes('from sync_events')) {
      return buildResult([{ pending: fx.syncPending } as QueryResultRow])
    }

    if (trimmed.startsWith('select state from dispatch_lanes')) {
      // setLaneState `select state ... for update`
      const [name] = params as [string]
      const lane = fx.lanes.get(name)
      if (!lane) return buildResult([])
      txnLane = name
      txnFromState = lane.state
      return buildResult([{ state: lane.state } as QueryResultRow])
    }

    if (trimmed.startsWith('select name, state from dispatch_lanes')) {
      // Stale-pause cleanup query — returns lanes whose pause_reason
      // matches the stale reason. The keeper's two stale queries differ in
      // their WHERE clauses; we recognize them by the param shape.
      // QBO recovery: WHERE name = any(...) and state='paused' and pause_reason='qbo_circuit_open'
      // Backlog clear: WHERE state='degraded' and pause_reason='outbox_backlog_high'
      if (trimmed.includes("'qbo_circuit_open'")) {
        const matching: Array<{ name: string; state: LaneState }> = []
        const qboLanes = ['estimate_push', 'rental_billing_push', 'labor_payroll_push', 'damage_charges']
        for (const name of qboLanes) {
          const row = fx.lanes.get(name)
          if (row && row.state === 'paused' && row.pause_reason === 'qbo_circuit_open') {
            matching.push({ name, state: row.state })
          }
        }
        return buildResult(matching as QueryResultRow[])
      }
      if (trimmed.includes("'outbox_backlog_high'")) {
        const matching: Array<{ name: string; state: LaneState }> = []
        for (const [name, row] of fx.lanes.entries()) {
          if (row.state === 'degraded' && row.pause_reason === 'outbox_backlog_high') {
            matching.push({ name, state: row.state })
          }
        }
        return buildResult(matching as QueryResultRow[])
      }
      return buildResult([])
    }

    if (trimmed.startsWith('update dispatch_lanes')) {
      const [, toState, reason] = params as [string, LaneState, string]
      if (txnLane) {
        fx.lanes.set(txnLane, { state: toState, pause_reason: reason })
        transitions.push({ name: txnLane, to: toState, reason })
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
  return { pool: pool as Pool, transitions }
}

describe('lane-health-keeper', () => {
  beforeEach(() => {
    __resetDispatchLaneCachesForTests()
  })

  it('forceRun pauses QBO lanes when the circuit is OPEN', async () => {
    const fx: PoolFixture = {
      qboCircuitState: 'open',
      outboxPending: 0,
      syncPending: 0,
      lanes: new Map([
        ['estimate_push', { state: 'active', pause_reason: '' }],
        ['rental_billing_push', { state: 'active', pause_reason: '' }],
        ['labor_payroll_push', { state: 'active', pause_reason: '' }],
        ['damage_charges', { state: 'active', pause_reason: '' }],
      ]),
    }
    const { pool, transitions } = makeFakePool(fx)
    const keeper = createLaneHealthKeeper({ pool, logger: testLogger })
    const summary = await keeper.forceRun()
    expect(summary.ran).toBe(true)
    expect(summary.qbo_state).toBe('open')
    const pausedNames = transitions.filter((t) => t.to === 'paused').map((t) => t.name)
    expect(pausedNames).toContain('estimate_push')
    expect(pausedNames).toContain('rental_billing_push')
    expect(pausedNames).toContain('labor_payroll_push')
    expect(pausedNames).toContain('damage_charges')
  })

  it('forceRun degrades ALL lanes when outbox backlog exceeds HIGH_WATER', async () => {
    const fx: PoolFixture = {
      qboCircuitState: 'closed',
      outboxPending: 5000,
      syncPending: 0,
      lanes: new Map([
        ['estimate_push', { state: 'active', pause_reason: '' }],
        ['notifications', { state: 'active', pause_reason: '' }],
      ]),
    }
    const { pool, transitions } = makeFakePool(fx)
    const keeper = createLaneHealthKeeper({ pool, logger: testLogger })
    const summary = await keeper.forceRun()
    expect(summary.ran).toBe(true)
    expect(summary.outbox_pending).toBe(5000)
    const degraded = transitions.filter((t) => t.to === 'degraded').map((t) => t.name)
    expect(degraded).toContain('estimate_push')
    expect(degraded).toContain('notifications')
  })

  it('forceRun clears qbo_circuit_open pauses when the circuit closes', async () => {
    const fx: PoolFixture = {
      qboCircuitState: 'closed',
      outboxPending: 0,
      syncPending: 0,
      lanes: new Map([
        ['estimate_push', { state: 'paused', pause_reason: 'qbo_circuit_open' }],
        ['rental_billing_push', { state: 'paused', pause_reason: 'manual' }], // not a keeper pause; keep it
      ]),
    }
    const { pool, transitions } = makeFakePool(fx)
    const keeper = createLaneHealthKeeper({ pool, logger: testLogger })
    await keeper.forceRun()
    // Only the qbo_circuit_open row flips back to active.
    const active = transitions.filter((t) => t.to === 'active').map((t) => t.name)
    expect(active).toContain('estimate_push')
    expect(active).not.toContain('rental_billing_push')
  })

  it('forceRun clears outbox_backlog_high degradation when backlog falls below LOW_WATER', async () => {
    const fx: PoolFixture = {
      qboCircuitState: 'closed',
      outboxPending: 100,
      syncPending: 100,
      lanes: new Map([
        ['estimate_push', { state: 'degraded', pause_reason: 'outbox_backlog_high' }],
        ['notifications', { state: 'paused', pause_reason: 'manual' }],
      ]),
    }
    const { pool, transitions } = makeFakePool(fx)
    const keeper = createLaneHealthKeeper({ pool, logger: testLogger })
    await keeper.forceRun()
    const active = transitions.filter((t) => t.to === 'active').map((t) => t.name)
    expect(active).toContain('estimate_push')
    expect(active).not.toContain('notifications') // manual pause is preserved
  })

  it('maybeRun short-circuits within the keeper interval', async () => {
    const fx: PoolFixture = {
      qboCircuitState: 'closed',
      outboxPending: 0,
      syncPending: 0,
      lanes: new Map(),
    }
    const { pool } = makeFakePool(fx)
    const keeper = createLaneHealthKeeper({ pool, logger: testLogger })
    const first = await keeper.maybeRun()
    expect(first.ran).toBe(true)
    const second = await keeper.maybeRun()
    expect(second.ran).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createAgentFeedLeaseSweepRunner } from './agent-feed-lease-sweep.js'

type FakeRow = QueryResultRow
type FakeCall = { sql: string; params: ReadonlyArray<unknown> }

function result(rows: FakeRow[] = [], rowCount = rows.length): QueryResult<FakeRow> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rows,
    rowCount,
  }
}

function makePool(expired: FakeRow[]): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  const client = {
    query: async (...args: unknown[]) => {
      const sql = String(args[0])
      const params = Array.isArray(args[1]) ? (args[1] as ReadonlyArray<unknown>) : []
      calls.push({ sql, params })
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        normalized === 'begin' ||
        normalized === 'commit' ||
        normalized === 'rollback' ||
        normalized.startsWith('select set_config')
      ) {
        return result()
      }
      if (normalized.startsWith('select id, audience, concern_ref')) return result(expired)
      if (normalized.startsWith('update agent_feed_concerns')) return result([], 1)
      if (normalized.includes('insert into context_handoff_events')) return result()
      throw new Error(`unexpected sql: ${normalized}`)
    },
    release: () => {
      released.push(true)
    },
  } as unknown as PoolClient
  return {
    pool: {
      connect: async () => client,
    } as unknown as Pool,
    calls,
    released,
  }
}

describe('createAgentFeedLeaseSweepRunner', () => {
  it('requeues claimed concerns past the lease window and stamps the work-item timeline', async () => {
    const { pool, calls, released } = makePool([
      {
        id: '00000000-0000-4000-c000-000000000001',
        audience: 'steve',
        concern_ref: 'wi:00000000-0000-4000-9000-000000000001:steve',
        work_item_id: '00000000-0000-4000-9000-000000000001',
        capture_session_id: null,
        claimed_at: '2026-06-09 12:00:00+00',
      },
    ])
    const runner = createAgentFeedLeaseSweepRunner({ pool })

    const summary = await runner.maybeSweep('company-1')

    expect(summary).toEqual({ ran: true, requeued: 1, failed: 0 })
    const select = calls.find((call) => call.sql.includes('from agent_feed_concerns'))
    expect(select?.params[0]).toBe('company-1')
    // Default lease window: AGENT_FEED_CLAIM_LEASE_MINUTES = 30.
    expect(select?.params[1]).toBe(30)
    expect(select?.sql).toContain("status = 'claimed'")
    const update = calls.find((call) => call.sql.trim().startsWith('update agent_feed_concerns'))
    expect(update?.sql).toContain("set status = 'pending'")
    expect(update?.sql).toContain('claimed_at = null')
    expect(update?.params).toEqual(['company-1', '00000000-0000-4000-c000-000000000001'])
    const insert = calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    expect(insert?.sql).toContain("'agent.callback_missing'")
    expect(insert?.params[1]).toBe('00000000-0000-4000-9000-000000000001')
    expect(insert?.params[4]).toBe(
      'agent_feed:wi:00000000-0000-4000-9000-000000000001:steve:lease_expired:2026-06-09 12:00:00+00',
    )
    expect(JSON.parse(String(insert?.params[2]))).toMatchObject({
      audience: 'steve',
      concern_ref: 'wi:00000000-0000-4000-9000-000000000001:steve',
      lease_minutes: 30,
      requeued: true,
    })
    expect(JSON.parse(String(insert?.params[3]))).toMatchObject({
      reason: 'agent_feed_claim_lease_expired',
      dispatch_surface: 'agent_feed',
    })
    expect(released).toEqual([true])
  })

  it('requeues a concern with no linked work item without a timeline write', async () => {
    const { pool, calls } = makePool([
      {
        id: '00000000-0000-4000-c000-000000000002',
        audience: 'capture-analyzer',
        concern_ref: 'capan:session-1',
        work_item_id: null,
        capture_session_id: null,
        claimed_at: '2026-06-09 12:00:00+00',
      },
    ])
    const runner = createAgentFeedLeaseSweepRunner({ pool })

    const summary = await runner.maybeSweep('company-1')

    expect(summary).toEqual({ ran: true, requeued: 1, failed: 0 })
    expect(calls.some((call) => call.sql.includes('insert into context_handoff_events'))).toBe(false)
  })

  it('throttles repeated sweeps inside the configured interval', async () => {
    const { pool, calls } = makePool([])
    const runner = createAgentFeedLeaseSweepRunner({ pool })

    expect(await runner.maybeSweep('company-1')).toEqual({ ran: true, requeued: 0, failed: 0 })
    expect(await runner.maybeSweep('company-1')).toEqual({ ran: false, requeued: 0, failed: 0 })
    expect(calls.filter((call) => call.sql.toLowerCase() === 'begin')).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createWorkRequestStaleRunner } from './work-request-stale.js'

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

function makePool(staleRows: FakeRow[]): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  const client = {
    query: async (...args: unknown[]) => {
      const sql = String(args[0])
      const params = Array.isArray(args[1]) ? (args[1] as ReadonlyArray<unknown>) : []
      calls.push({ sql, params: params ?? [] })
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        normalized === 'begin' ||
        normalized === 'commit' ||
        normalized === 'rollback' ||
        normalized.startsWith('select set_config')
      ) {
        return result()
      }
      if (normalized.startsWith('select id, status, lane from context_work_items')) return result(staleRows)
      if (normalized.includes('insert into context_handoff_events')) return result()
      if (normalized.startsWith('update context_work_items')) return result([], 1)
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

describe('createWorkRequestStaleRunner', () => {
  it('marks stale review and agent rows with append-only status events', async () => {
    const { pool, calls, released } = makePool([
      { id: '00000000-0000-4000-8000-000000000001', status: 'review_ready', lane: 'both' },
      { id: '00000000-0000-4000-8000-000000000002', status: 'agent_running', lane: 'agent' },
    ])
    const runner = createWorkRequestStaleRunner({ pool })

    const summary = await runner.maybeSweep('company-1')

    expect(summary).toEqual({ ran: true, updated: 2, failed: 0 })
    const inserts = calls.filter((call) => call.sql.includes('insert into context_handoff_events'))
    expect(inserts).toHaveLength(2)
    expect(JSON.parse(String(inserts[0]!.params[2]))).toMatchObject({
      previous_status: 'review_ready',
      status: 'review_stale',
      lane: 'both',
    })
    expect(JSON.parse(String(inserts[1]!.params[2]))).toMatchObject({
      previous_status: 'agent_running',
      status: 'proposal_expired',
      lane: 'both',
    })
    expect(calls.filter((call) => call.sql.startsWith('update context_work_items'))).toHaveLength(2)
    expect(released).toEqual([true])
  })

  it('throttles repeated sweeps inside the configured interval', async () => {
    const { pool, calls } = makePool([])
    const runner = createWorkRequestStaleRunner({ pool })

    expect(await runner.maybeSweep('company-1')).toEqual({ ran: true, updated: 0, failed: 0 })
    expect(await runner.maybeSweep('company-1')).toEqual({ ran: false, updated: 0, failed: 0 })
    expect(calls.filter((call) => call.sql.toLowerCase() === 'begin')).toHaveLength(1)
  })
})

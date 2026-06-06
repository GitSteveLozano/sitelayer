import { describe, it, expect } from 'vitest'
import {
  aggregateLaborByItem,
  aggregateLaborByWeek,
  aggregateLaborByWorker,
  listLaborByItem,
  listLaborByWeek,
  listLaborByWorker,
  parseLaborReportFilters,
  type LaborQueryClient,
  type SeedLaborEntry,
} from './labor-reports.js'

const SEED: SeedLaborEntry[] = [
  // Two workers, two items, three different weeks. Picked so each split has a
  // distinct top row and the totals reconcile to a checkable round number.
  // Week of 2026-04-06 (Mon): EPS / Alice / 8h @ $40 = $320
  {
    service_item_code: 'EPS',
    worker_id: 'w1',
    worker_name: 'Alice',
    hours: 8,
    occurred_on: '2026-04-07',
    labor_rate: 40,
  },
  // Week of 2026-04-06 (Mon): EPS / Bob / 6h @ $40 = $240
  {
    service_item_code: 'EPS',
    worker_id: 'w2',
    worker_name: 'Bob',
    hours: 6,
    occurred_on: '2026-04-08',
    labor_rate: 40,
  },
  // Week of 2026-04-13 (Mon): DRY / Alice / 4h @ $40 = $160
  {
    service_item_code: 'DRY',
    worker_id: 'w1',
    worker_name: 'Alice',
    hours: 4,
    occurred_on: '2026-04-13',
    labor_rate: 40,
  },
  // Week of 2026-04-13 (Mon): DRY / Bob / 2h @ $50 = $100 (different rate)
  {
    service_item_code: 'DRY',
    worker_id: 'w2',
    worker_name: 'Bob',
    hours: 2,
    occurred_on: '2026-04-15',
    labor_rate: 50,
  },
  // Week of 2026-04-20 (Mon): unassigned worker
  {
    service_item_code: 'EPS',
    worker_id: null,
    worker_name: '(unassigned)',
    hours: 1,
    occurred_on: '2026-04-20',
    labor_rate: 40,
  },
]

describe('parseLaborReportFilters', () => {
  it('extracts start/end and treats blanks as null', () => {
    const params = new URLSearchParams({ start: '2026-01-01', end: '2026-12-31' })
    expect(parseLaborReportFilters(params)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(parseLaborReportFilters(new URLSearchParams())).toEqual({ start: null, end: null })
    expect(parseLaborReportFilters(new URLSearchParams({ start: '   ' }))).toEqual({ start: null, end: null })
  })
})

describe('aggregate* (in-memory math, mirrors SQL grouping)', () => {
  it('aggregates labor by service item with hours+cost', () => {
    const result = aggregateLaborByItem(SEED)
    expect(result).toHaveLength(2)
    const eps = result.find((r) => r.service_item_code === 'EPS')!
    const dry = result.find((r) => r.service_item_code === 'DRY')!
    expect(eps.hours).toBe(8 + 6 + 1)
    expect(eps.cost).toBe(320 + 240 + 40)
    expect(dry.hours).toBe(4 + 2)
    expect(dry.cost).toBe(160 + 100)
    // Sorted by hours desc → EPS (15h) first.
    expect(result[0]?.service_item_code).toBe('EPS')
  })

  it('aggregates labor by worker, including unassigned bucket', () => {
    const result = aggregateLaborByWorker(SEED)
    expect(result).toHaveLength(3)
    const alice = result.find((r) => r.worker_id === 'w1')!
    const bob = result.find((r) => r.worker_id === 'w2')!
    const unassigned = result.find((r) => r.worker_id === null)!
    expect(alice.hours).toBe(8 + 4)
    expect(alice.cost).toBe(320 + 160)
    expect(bob.hours).toBe(6 + 2)
    expect(bob.cost).toBe(240 + 100)
    expect(unassigned.hours).toBe(1)
    expect(unassigned.cost).toBe(40)
  })

  it('aggregates labor by ISO week (Monday start)', () => {
    const result = aggregateLaborByWeek(SEED)
    expect(result.map((r) => r.week_start)).toEqual(['2026-04-06', '2026-04-13', '2026-04-20'])
    expect(result[0]?.hours).toBe(14)
    expect(result[0]?.cost).toBe(560)
    expect(result[1]?.hours).toBe(6)
    expect(result[1]?.cost).toBe(260)
    expect(result[2]?.hours).toBe(1)
    expect(result[2]?.cost).toBe(40)
  })
})

/**
 * Smoke test the SQL-driven helpers via a stub LaborQueryClient that returns
 * the JS aggregator output, exercising the filter passthrough and the post-
 * processing (Number coercion, week_start string normalization).
 */
function makeStubClient(): LaborQueryClient {
  return {
    query: async (sql: string) => {
      if (/group by le\.service_item_code/.test(sql)) {
        const rows = aggregateLaborByItem(SEED)
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as never
      }
      if (/group by le\.worker_id/.test(sql)) {
        const rows = aggregateLaborByWorker(SEED).map((r) => ({
          worker_id: r.worker_id,
          worker_name: r.worker_name,
          hours: r.hours,
          cost: r.cost,
        }))
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as never
      }
      if (/date_trunc\('week'/.test(sql)) {
        const rows = aggregateLaborByWeek(SEED)
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as never
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
}

describe('list* (handler-shape smoke tests with stub client)', () => {
  const client = makeStubClient()

  it('listLaborByItem returns numeric hours/cost rows sorted by hours desc', async () => {
    const rows = await listLaborByItem(client, 'co-1', { start: null, end: null })
    expect(rows[0]?.service_item_code).toBe('EPS')
    expect(typeof rows[0]?.hours).toBe('number')
    expect(typeof rows[0]?.cost).toBe('number')
  })

  it('listLaborByWorker returns numeric hours/cost rows', async () => {
    const rows = await listLaborByWorker(client, 'co-1', { start: null, end: null })
    expect(rows.length).toBe(3)
    expect(typeof rows[0]?.hours).toBe('number')
  })

  it('listLaborByWeek returns ISO date strings', async () => {
    const rows = await listLaborByWeek(client, 'co-1', { start: null, end: null })
    expect(rows.map((r) => r.week_start)).toEqual(['2026-04-06', '2026-04-13', '2026-04-20'])
  })
})

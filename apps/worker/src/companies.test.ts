import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { listActiveCompanies } from './companies.js'

/**
 * listActiveCompanies is the multi-tenant pivot: it decides WHICH companies a
 * heartbeat drains. The two contracts under test:
 *   - default (no override) → ALL companies (so company #2 actually drains).
 *   - ACTIVE_COMPANY_SLUG override → exactly that one company (targeted
 *     reprocessing / single-tenant deploy), preserving the old behavior.
 */

type FakePool = Pool & { lastSql: string; lastParams: unknown[] }

function fakePool(handler: (sql: string, params: unknown[]) => Array<{ id: string; slug: string }>): FakePool {
  const state = { lastSql: '', lastParams: [] as unknown[] }
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      state.lastSql = sql
      state.lastParams = params
      const rows = handler(sql, params)
      return { rows, rowCount: rows.length }
    },
  } as unknown as FakePool
  Object.defineProperty(pool, 'lastSql', { get: () => state.lastSql })
  Object.defineProperty(pool, 'lastParams', { get: () => state.lastParams })
  return pool
}

const ALL = [
  { id: 'id-la', slug: 'la-operations' },
  { id: 'id-two', slug: 'company-two' },
  { id: 'id-three', slug: 'company-three' },
]

describe('listActiveCompanies', () => {
  it('returns ALL companies when no override is set (default multi-tenant)', async () => {
    const pool = fakePool((sql) => {
      // The all-companies path must NOT filter by slug.
      expect(sql).not.toMatch(/where\s+slug\s*=/i)
      expect(sql).toMatch(/select\s+id,\s*slug\s+from\s+companies/i)
      return ALL
    })
    const result = await listActiveCompanies(pool)
    expect(result.map((c) => c.slug)).toEqual(['la-operations', 'company-two', 'company-three'])
    expect(pool.lastParams).toEqual([])
  })

  it('returns ALL companies when the override is empty/whitespace', async () => {
    const pool = fakePool(() => ALL)
    expect((await listActiveCompanies(pool, '')).length).toBe(3)
    expect((await listActiveCompanies(pool, '   ')).length).toBe(3)
    expect((await listActiveCompanies(pool, null)).length).toBe(3)
  })

  it('returns ONLY the override company when ACTIVE_COMPANY_SLUG is set', async () => {
    const pool = fakePool((sql, params) => {
      expect(sql).toMatch(/where\s+slug\s*=\s*\$1/i)
      const slug = params[0] as string
      return ALL.filter((c) => c.slug === slug)
    })
    const result = await listActiveCompanies(pool, 'company-two')
    expect(result).toEqual([{ id: 'id-two', slug: 'company-two' }])
    expect(pool.lastParams).toEqual(['company-two'])
  })

  it('trims whitespace around the override slug', async () => {
    const pool = fakePool((_sql, params) => ALL.filter((c) => c.slug === params[0]))
    const result = await listActiveCompanies(pool, '  la-operations  ')
    expect(result).toEqual([{ id: 'id-la', slug: 'la-operations' }])
    expect(pool.lastParams).toEqual(['la-operations'])
  })

  it('returns an empty list when the override matches no company (boot waits)', async () => {
    const pool = fakePool(() => [])
    expect(await listActiveCompanies(pool, 'does-not-exist')).toEqual([])
  })
})

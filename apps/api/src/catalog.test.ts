import { describe, expect, it, vi } from 'vitest'
import {
  assertServiceItemCatalogStatus,
  loadServiceItemCatalogIndex,
  rejectionMessageForCatalog,
  type CatalogQueryRunner,
} from './catalog.js'

/**
 * In-memory mock of the slice of pg.Pool we use. Each call inspects the SQL
 * template to decide which `exists` query is being asked and returns the
 * canned answer. We keep this hand-rolled (rather than reaching for vi.fn().
 * mockResolvedValueOnce(...)) because the consumer issues two queries and the
 * order matters — coupling test answers to call ordering hides bugs where
 * the second query is silently elided.
 */
function buildMockPool(seed: { existsForCode: boolean; existsForPair: boolean }): CatalogQueryRunner {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('and division_code')) {
        return { rows: [{ exists: seed.existsForPair }] }
      }
      return { rows: [{ exists: seed.existsForCode }] }
    }) as unknown as CatalogQueryRunner['query'],
  }
}

describe('assertServiceItemCatalogStatus', () => {
  const companyId = 'company-1'
  const serviceItemCode = 'EPS'

  it('rejects with no_curated_catalog when zero xref rows exist', async () => {
    const pool = buildMockPool({ existsForCode: false, existsForPair: false })
    const result = await assertServiceItemCatalogStatus(pool, companyId, serviceItemCode, 'D4')
    expect(result).toEqual({ ok: false, reason: 'no_curated_catalog' })
    expect(rejectionMessageForCatalog('no_curated_catalog')).toBe(
      'service item not in curated catalog for any division',
    )
  })

  it('rejects with division_not_allowed when xref rows exist but the division is not in the allowed set', async () => {
    const pool = buildMockPool({ existsForCode: true, existsForPair: false })
    const result = await assertServiceItemCatalogStatus(pool, companyId, serviceItemCode, 'D9')
    expect(result).toEqual({ ok: false, reason: 'division_not_allowed' })
    expect(rejectionMessageForCatalog('division_not_allowed')).toBe('service item not allowed in this division')
  })

  it('accepts when the (service item, division) pair is curated', async () => {
    const pool = buildMockPool({ existsForCode: true, existsForPair: true })
    const result = await assertServiceItemCatalogStatus(pool, companyId, serviceItemCode, 'D4')
    expect(result).toEqual({ ok: true })
  })

  it('accepts when no division is supplied as long as the catalog is curated', async () => {
    const pool = buildMockPool({ existsForCode: true, existsForPair: false })
    // divisionCode=null means "fall back to project default"; we still require
    // some curated row to exist for the service item.
    const result = await assertServiceItemCatalogStatus(pool, companyId, serviceItemCode, null)
    expect(result).toEqual({ ok: true })
  })

  it('still rejects when no division is supplied AND no curated catalog exists', async () => {
    const pool = buildMockPool({ existsForCode: false, existsForPair: false })
    const result = await assertServiceItemCatalogStatus(pool, companyId, serviceItemCode, null)
    expect(result).toEqual({ ok: false, reason: 'no_curated_catalog' })
  })
})

describe('loadServiceItemCatalogIndex', () => {
  const companyId = 'company-1'

  function buildBatchPool(rows: Array<{ service_item_code: string; division_code: string }>) {
    const query = vi.fn(async () => ({ rows }))
    return {
      pool: { query: query as unknown as CatalogQueryRunner['query'] },
      query,
    }
  }

  it('returns no_curated_catalog for codes with no rows', async () => {
    const { pool } = buildBatchPool([])
    const index = await loadServiceItemCatalogIndex(pool, companyId, ['EPS'])
    expect(index.check('EPS', 'D4')).toEqual({ ok: false, reason: 'no_curated_catalog' })
    expect(index.check('EPS', null)).toEqual({ ok: false, reason: 'no_curated_catalog' })
  })

  it('accepts curated pairs and rejects mismatched divisions', async () => {
    const { pool } = buildBatchPool([
      { service_item_code: 'EPS', division_code: 'D4' },
      { service_item_code: 'EPS', division_code: 'D2' },
    ])
    const index = await loadServiceItemCatalogIndex(pool, companyId, ['EPS'])
    expect(index.check('EPS', 'D4')).toEqual({ ok: true })
    expect(index.check('EPS', 'D2')).toEqual({ ok: true })
    expect(index.check('EPS', 'D9')).toEqual({ ok: false, reason: 'division_not_allowed' })
    expect(index.check('EPS', null)).toEqual({ ok: true })
  })

  it('skips the round-trip when the requested code list is empty', async () => {
    const { pool, query } = buildBatchPool([])
    const index = await loadServiceItemCatalogIndex(pool, companyId, [])
    expect(query).not.toHaveBeenCalled()
    expect(index.check('ANY', 'D4')).toEqual({ ok: false, reason: 'no_curated_catalog' })
  })

  it('deduplicates the requested codes before querying', async () => {
    const { pool, query } = buildBatchPool([{ service_item_code: 'EPS', division_code: 'D4' }])
    await loadServiceItemCatalogIndex(pool, companyId, ['EPS', 'EPS', 'EPS'])
    expect(query).toHaveBeenCalledTimes(1)
    const call = query.mock.calls[0] as unknown as [string, unknown[]] | undefined
    expect(call?.[1]?.[1]).toEqual(['EPS'])
  })
})

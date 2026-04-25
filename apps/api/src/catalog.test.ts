import { describe, expect, it, vi } from 'vitest'
import { assertServiceItemCatalogStatus, rejectionMessageForCatalog, type CatalogQueryRunner } from './catalog.js'

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

import { describe, expect, it } from 'vitest'
import type { TakeoffMeasurement } from '@/lib/api'
import { buildScopeTotals, formatQty } from './canvas-totals'

function measurement(m: Partial<TakeoffMeasurement>): TakeoffMeasurement {
  return {
    id: 'm1',
    project_id: 'p1',
    blueprint_document_id: null,
    page_id: null,
    service_item_code: 'SIDING',
    quantity: '10',
    unit: 'sqft',
    notes: null,
    elevation: null,
    image_thumbnail: null,
    geometry: {},
    version: 1,
    created_at: '2026-06-01T00:00:00Z',
    ...m,
  } as TakeoffMeasurement
}

describe('buildScopeTotals', () => {
  it('buckets by service item and sums quantities', () => {
    const totals = buildScopeTotals([
      measurement({ service_item_code: 'SIDING', quantity: '10', unit: 'sqft' }),
      measurement({ service_item_code: 'SIDING', quantity: '5', unit: 'sqft' }),
      measurement({ service_item_code: 'TRIM', quantity: '8', unit: 'lf' }),
    ])
    expect(totals).toHaveLength(2)
    // sorted by descending quantity → SIDING (15) first
    expect(totals[0]).toMatchObject({ code: 'SIDING', quantity: 15, unit: 'sqft', count: 2, mixedUnits: false })
    expect(totals[1]).toMatchObject({ code: 'TRIM', quantity: 8, unit: 'lf', count: 1 })
  })

  it('subtracts deductions from the net for the item (signed)', () => {
    const totals = buildScopeTotals([
      measurement({ service_item_code: 'SIDING', quantity: '100', unit: 'sqft' }),
      measurement({ service_item_code: 'SIDING', quantity: '15', unit: 'sqft', is_deduction: true }),
    ])
    expect(totals).toHaveLength(1)
    expect(totals[0]).toMatchObject({ code: 'SIDING', quantity: 85, count: 2 })
  })

  it('flags mixed units', () => {
    const totals = buildScopeTotals([
      measurement({ service_item_code: 'X', quantity: '1', unit: 'sqft' }),
      measurement({ service_item_code: 'X', quantity: '2', unit: 'lf' }),
    ])
    expect(totals[0]).toMatchObject({ code: 'X', unit: 'mixed', mixedUnits: true })
  })
})

describe('formatQty', () => {
  it('formats non-finite as 0', () => {
    expect(formatQty(NaN)).toBe('0')
  })
  it('drops fractions and groups thousands for large values', () => {
    expect(formatQty(1234.56)).toBe((1234.56).toLocaleString(undefined, { maximumFractionDigits: 0 }))
  })
  it('renders integers without a decimal', () => {
    expect(formatQty(42)).toBe('42')
  })
  it('renders one fraction digit for small non-integers', () => {
    expect(formatQty(3.14)).toBe((3.14).toLocaleString(undefined, { maximumFractionDigits: 1 }))
  })
})

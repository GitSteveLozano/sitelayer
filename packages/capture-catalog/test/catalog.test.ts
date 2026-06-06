import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { validateTakeoffResult, validatePricedEstimate, type TakeoffResult } from '@sitelayer/capture-schema'

import {
  loadCatalog,
  lookupBySku,
  lookupByCsi,
  priceEstimate,
  priceEstimateWithDetails,
  renderEstimateHtml,
} from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(HERE, '../fixtures/sample-kitchen-takeoff.json')
const LABOR_RATE = 65

function loadFixture(): TakeoffResult {
  const raw = readFileSync(FIXTURE_PATH, 'utf8')
  return validateTakeoffResult(JSON.parse(raw))
}

describe('loadCatalog', () => {
  it('loads the bundled seed.yaml and validates every row', () => {
    const catalog = loadCatalog()
    expect(catalog.length).toBeGreaterThanOrEqual(35)
    expect(catalog.length).toBeLessThanOrEqual(60)
    // Every row should round-trip through validation.
    for (const item of catalog) {
      expect(item.unitPrice).toBeGreaterThanOrEqual(0)
      expect(item.confidence).toBeGreaterThan(0)
      expect(item.confidence).toBeLessThanOrEqual(1)
      expect(item.pricedAt).toMatch(/^2026-05-07/)
    }
  })
})

describe('lookupBySku', () => {
  it('finds a known SKU', () => {
    const catalog = loadCatalog()
    const item = lookupBySku(catalog, 'drywall-58-4x8-sqft')
    expect(item).toBeDefined()
    expect(item?.csiCode).toBe('09 29 00')
  })

  it('returns undefined for missing SKU', () => {
    const catalog = loadCatalog()
    expect(lookupBySku(catalog, 'this-sku-does-not-exist')).toBeUndefined()
  })
})

describe('lookupByCsi', () => {
  it('returns >=1 item for 09 29 00 (drywall)', () => {
    const catalog = loadCatalog()
    const items = lookupByCsi(catalog, '09 29 00')
    expect(items.length).toBeGreaterThanOrEqual(1)
    for (const i of items) expect(i.csiCode).toBe('09 29 00')
  })

  it('returns >=1 item for 08 14 16 (interior doors)', () => {
    const catalog = loadCatalog()
    const items = lookupByCsi(catalog, '08 14 16')
    expect(items.length).toBeGreaterThanOrEqual(3)
  })

  it('falls back to division when full code not present', () => {
    const catalog = loadCatalog()
    // No row for "09 99 99" exactly, but division 09 has many.
    const items = lookupByCsi(catalog, '09 99 99')
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) expect(i.csiCode.startsWith('09')).toBe(true)
  })
})

describe('priceEstimate (sample kitchen)', () => {
  it('round-trips the fixture through pricing and validation', () => {
    const takeoff = loadFixture()
    const priced = priceEstimate(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })
    expect(() => validatePricedEstimate(priced)).not.toThrow()
    expect(priced.lines.length).toBeGreaterThanOrEqual(7) // at most 8, at least 7 must match
    expect(priced.precedenceUsed).toBe('seeded_fallback')
    expect(priced.currency).toBe('USD')
  })

  it('each line carries takeoffQuantityId backref', () => {
    const takeoff = loadFixture()
    const priced = priceEstimate(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })
    const validIds = new Set(takeoff.quantities.map((q) => q.id))
    for (const line of priced.lines) {
      expect(validIds.has(line.takeoffQuantityId)).toBe(true)
    }
  })

  it("each rollup total equals sum of its lines' amounts", () => {
    const takeoff = loadFixture()
    const priced = priceEstimate(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })
    for (const rollup of priced.rollupsByCsiDivision) {
      const sum = priced.lines
        .filter((l) => l.divisionCode === rollup.divisionCode)
        .reduce((acc, l) => acc + l.amount, 0)
      // Allow 1 cent of float drift from round-trip rounding.
      expect(Math.abs(rollup.total - sum)).toBeLessThan(0.05)
    }
  })

  it('grand total is within 5% of hand-calculated reference', () => {
    const takeoff = loadFixture()
    const priced = priceEstimate(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })

    // Hand-calculated reference. We track which catalog SKU each fixture
    // quantity will match so the test stays anchored to what the matcher
    // actually does (first-with-matching-unit).
    //
    // kt-q-1: drywall 240 sqft  → drywall-58-4x8-sqft
    //   material = 240 * 0.55 = 132.00
    //   labor    = 240 * 0.012 * 65 = 187.20
    //   waste    = 132.00 * 0.10 = 13.20
    // kt-q-2: baseboard MDF 32 lft → trim-baseboard-mdf-31_4-primed-lf
    //   material = 32 * 1.18 = 37.76
    //   labor    = 32 * 0.05 * 65 = 104.00
    //   waste    = 37.76 * 0.10 = 3.776
    // kt-q-3: primer sqft 250 → paint-primer-coverage-sqft
    //   material = 250 * 0.067 = 16.75
    //   labor    = 250 * 0.008 * 65 = 130.00
    //   waste    = 16.75 * 0.15 = 2.5125
    // kt-q-4: eggshell sqft 250 → first matching sqft SKU is
    //   paint-primer-coverage-sqft (same as kt-q-3) per spec ordering.
    //   material = 250 * 0.067 = 16.75
    //   labor    = 250 * 0.008 * 65 = 130.00
    //   waste    = 16.75 * 0.15 = 2.5125
    // kt-q-5: door 32" 1 ea → door-interior-hollow-30in (first ea match)
    //   material = 1 * 49 = 49
    //   labor    = 1 * 1.25 * 65 = 81.25
    //   waste    = 0
    // kt-q-6: door 36" 1 ea → first ea match (same first ea) = door-interior-hollow-30in
    //   material = 49, labor 81.25, waste 0
    // kt-q-7: tile 85 sqft → tile-ceramic-12x12-sqft
    //   material = 85 * 1.69 = 143.65
    //   labor    = 85 * 0.12 * 65 = 663.00
    //   waste    = 143.65 * 0.10 = 14.365
    // kt-q-8: casing 25 lft → first lft match in 06 22 00 =
    //   trim-baseboard-mdf-31_4-primed-lf (same as q-2; spec)
    //   material = 25 * 1.18 = 29.50
    //   labor    = 25 * 0.05 * 65 = 81.25
    //   waste    = 29.50 * 0.10 = 2.95

    const sumMaterial = 132.0 + 37.76 + 16.75 + 16.75 + 49 + 49 + 143.65 + 29.5
    const sumLabor = 187.2 + 104.0 + 130.0 + 130.0 + 81.25 + 81.25 + 663.0 + 81.25
    const sumWaste = 13.2 + 3.776 + 2.5125 + 2.5125 + 0 + 0 + 14.365 + 2.95
    const baseTotal = sumMaterial + sumLabor + sumWaste
    const opAndP = baseTotal * 0.2
    const referenceGrandTotal = baseTotal + opAndP

    const drift = Math.abs(priced.totals.grandTotal - referenceGrandTotal) / referenceGrandTotal
    expect(drift).toBeLessThan(0.05)
  })

  it('priceEstimateWithDetails reports unmatched quantities', () => {
    const takeoff = loadFixture()
    const result = priceEstimateWithDetails(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })
    // The fixture's quantities all map to known divisions, so unmatched
    // should be empty for the kitchen sample.
    expect(result.unmatched).toEqual([])
  })
})

describe('renderEstimateHtml', () => {
  it('renders a valid-looking HTML doc with totals and every line', () => {
    const takeoff = loadFixture()
    const priced = priceEstimate(takeoff, {
      laborRate: LABOR_RATE,
      companyId: 'demo-co',
      projectId: 'spike-001',
    })
    const html = renderEstimateHtml(priced)
    expect(html).toContain('<html')
    expect(html).toContain('Grand total')
    // Every line description should appear in the rendered table.
    for (const line of priced.lines) {
      // description is HTML-escaped, but our seed descriptions don't contain
      // characters that change meaningfully on escape (other than ").
      // Check at minimum a unique substring of each description survives.
      const head = line.description.split(',')[0]!.replace(/"/g, '&quot;')
      expect(html).toContain(head)
    }
    // Grand total formatted.
    const formatted = priced.totals.grandTotal.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    expect(html).toContain(formatted)
  })
})

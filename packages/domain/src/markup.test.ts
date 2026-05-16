import { describe, expect, it } from 'vitest'
import { DEFAULT_MARKUP_CONFIG, applyMarkup, normalizeMarkupConfig, type MarkupProfileConfig } from './markup.js'

describe('normalizeMarkupConfig', () => {
  it('returns the defaults for null / non-object input', () => {
    expect(normalizeMarkupConfig(null)).toEqual(DEFAULT_MARKUP_CONFIG)
    expect(normalizeMarkupConfig(undefined)).toEqual(DEFAULT_MARKUP_CONFIG)
    expect(normalizeMarkupConfig(42)).toEqual(DEFAULT_MARKUP_CONFIG)
    expect(normalizeMarkupConfig('nope')).toEqual(DEFAULT_MARKUP_CONFIG)
  })

  it('overrides only the keys that parse as finite numbers', () => {
    const merged = normalizeMarkupConfig({
      material_waste_pct: 12,
      labor_burden_pct: '18',
      sub_markup_pct: 'abc',
      profit_margin_pct: 25,
    })
    expect(merged).toEqual({
      material_waste_pct: 12,
      labor_burden_pct: 18,
      sub_markup_pct: DEFAULT_MARKUP_CONFIG.sub_markup_pct,
      freight_markup_pct: DEFAULT_MARKUP_CONFIG.freight_markup_pct,
      profit_margin_pct: 25,
    })
  })

  it('preserves siblings — does not touch unrelated config keys', () => {
    // Caller passes the whole jsonb; normalize must not see the extras
    // as a problem. (The EXTEND-not-REPLACE contract is enforced by the
    // caller serialising the profile back through unchanged.)
    const cfg = normalizeMarkupConfig({
      template: 'la-operations',
      divisions: { D1: { rate_standard: 65 } },
      material_waste_pct: 7,
    })
    expect(cfg.material_waste_pct).toBe(7)
    // Defaults still in place for the rest.
    expect(cfg.labor_burden_pct).toBe(DEFAULT_MARKUP_CONFIG.labor_burden_pct)
  })

  it('rejects negative and obviously-broken percentages', () => {
    const cfg = normalizeMarkupConfig({
      material_waste_pct: -5,
      labor_burden_pct: 99999,
      sub_markup_pct: 200,
    })
    expect(cfg.material_waste_pct).toBe(DEFAULT_MARKUP_CONFIG.material_waste_pct)
    expect(cfg.labor_burden_pct).toBe(DEFAULT_MARKUP_CONFIG.labor_burden_pct)
    expect(cfg.sub_markup_pct).toBe(200)
  })

  it('accepts a custom defaults argument', () => {
    const customDefaults: Required<MarkupProfileConfig> = {
      material_waste_pct: 0,
      labor_burden_pct: 0,
      sub_markup_pct: 0,
      freight_markup_pct: 0,
      profit_margin_pct: 0,
    }
    expect(normalizeMarkupConfig({}, customDefaults)).toEqual(customDefaults)
  })
})

describe('applyMarkup', () => {
  it('returns zero total for an empty subtotal map', () => {
    const result = applyMarkup({}, null)
    expect(result.total).toBe(0)
    expect(result.subtotal_before_profit).toBe(0)
    expect(result.lines).toEqual([])
  })

  it('multiplies each kind by (1 + pct/100) and labels it', () => {
    // Labor $1200 × 1.15 burden = $1380
    // Materials $2500 × 1.10 waste = $2750
    // Subtotal before profit = $4130
    const result = applyMarkup(
      { material: 2500, labor: 1200 },
      { material_waste_pct: 10, labor_burden_pct: 15, profit_margin_pct: 0 },
    )
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toMatchObject({
      basis: 'material',
      multiplier: 1.1,
      before: 2500,
      after: 2750,
    })
    expect(result.lines[0]!.label).toMatch(/Materials.*\+10%/)
    expect(result.lines[1]).toMatchObject({
      basis: 'labor',
      multiplier: 1.15,
      before: 1200,
      after: 1380,
    })
    expect(result.lines[1]!.label).toMatch(/Labor.*\+15%/)
    expect(result.subtotal_before_profit).toBe(4130)
    expect(result.total).toBe(4130)
  })

  it('emits a separate profit row using the revenue-margin formula', () => {
    // margin=20% => multiplier = 1/(1-0.20) = 1.25
    // (labor $1000 × 1.15 = $1150) × 1.25 = $1437.50
    const result = applyMarkup({ labor: 1000 }, { labor_burden_pct: 15, profit_margin_pct: 20 })
    expect(result.lines).toHaveLength(2)
    const profit = result.lines[1]!
    expect(profit.basis).toBe('profit')
    expect(profit.multiplier).toBe(1.25)
    expect(profit.before).toBe(1150)
    expect(profit.after).toBe(1437.5)
    expect(result.subtotal_before_profit).toBe(1150)
    expect(result.total).toBe(1437.5)
  })

  it('skips kinds with zero subtotal but keeps the rest', () => {
    const result = applyMarkup(
      { material: 0, labor: 800, sub: 0, freight: 100 },
      { labor_burden_pct: 15, freight_markup_pct: 5, profit_margin_pct: 0 },
    )
    expect(result.lines.map((r) => r.basis)).toEqual(['labor', 'freight'])
  })

  it('treats non-finite subtotals as zero', () => {
    const result = applyMarkup(
      { material: Number.NaN as unknown as number, labor: 100 },
      { labor_burden_pct: 10, profit_margin_pct: 0 },
    )
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.basis).toBe('labor')
    expect(result.total).toBe(110)
  })

  it('honours kind ordering — material, labor, sub, freight, profit', () => {
    const result = applyMarkup(
      { freight: 100, sub: 100, labor: 100, material: 100 },
      {
        material_waste_pct: 1,
        labor_burden_pct: 2,
        sub_markup_pct: 3,
        freight_markup_pct: 4,
        profit_margin_pct: 10,
      },
    )
    expect(result.lines.map((r) => r.basis)).toEqual(['material', 'labor', 'sub', 'freight', 'profit'])
  })

  it('uses the documented defaults when the profile config is empty', () => {
    // Pure defaults: material 10%, labor 15%, sub 8%, freight 5%, profit 0.
    // 100 material → 110; 100 labor → 115; 100 sub → 108; 100 freight → 105.
    // Total = 438.
    const result = applyMarkup({ material: 100, labor: 100, sub: 100, freight: 100 }, {})
    expect(result.total).toBe(438)
    expect(result.config).toEqual(DEFAULT_MARKUP_CONFIG)
  })

  it('caps a misconfigured 100% margin so the math stays finite', () => {
    const result = applyMarkup({ labor: 100 }, { labor_burden_pct: 0, profit_margin_pct: 100 })
    // margin clamped to 99%, so multiplier = 1/(1-0.99) = 100.
    expect(result.lines[1]!.multiplier).toBe(100)
    expect(result.total).toBe(10_000)
  })

  it('no profit row when subtotal_before_profit is zero', () => {
    const result = applyMarkup({}, { profit_margin_pct: 25 })
    expect(result.lines).toEqual([])
    expect(result.total).toBe(0)
  })

  it('labels a zero-pct kind as pass-through', () => {
    const result = applyMarkup(
      { sub: 500 },
      { sub_markup_pct: 0, labor_burden_pct: 0, material_waste_pct: 0, freight_markup_pct: 0, profit_margin_pct: 0 },
    )
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.label).toMatch(/pass-through/)
    expect(result.lines[0]!.after).toBe(500)
  })
})

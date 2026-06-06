import { describe, expect, it } from 'vitest'
import { resolveAssembly, selectActiveAssembly, type AssemblyComponent, type AssemblyHeader } from './assembly.js'

const baseAssembly: AssemblyHeader = {
  id: 'a-1',
  service_item_code: 'EIFS-STD',
  name: 'EIFS standard wall',
  unit: 'sqft',
}

function comp(overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return {
    id: `c-${Math.random().toString(16).slice(2)}`,
    assembly_id: 'a-1',
    kind: 'material',
    name: 'EPS board',
    quantity_per_unit: 1,
    unit: 'sqft',
    unit_cost: 1,
    waste_pct: 0,
    sort_order: 0,
    ...overrides,
  }
}

describe('resolveAssembly', () => {
  it('produces the empty-recipe case', () => {
    const result = resolveAssembly(100, baseAssembly, [])
    expect(result.total).toBe(0)
    expect(result.lines).toEqual([])
    expect(result.by_kind).toEqual({ material: 0, labor: 0, sub: 0, freight: 0 })
  })

  it('multiplies quantity × per-unit × unit-cost', () => {
    // 100 sqft of wall × 1 sqft EPS/sqft wall × $4.85/sqft = $485
    const result = resolveAssembly(100, baseAssembly, [
      comp({ kind: 'material', name: 'EPS board', quantity_per_unit: 1, unit_cost: 4.85 }),
    ])
    expect(result.total).toBe(485)
    expect(result.by_kind.material).toBe(485)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.quantity).toBe(100)
    expect(result.lines[0]!.amount).toBe(485)
  })

  it('applies waste_pct multiplicatively after quantity_per_unit', () => {
    // 100 sqft × 1.0 × (1 + 5%) × $4.85 = $509.25
    const result = resolveAssembly(100, baseAssembly, [
      comp({ kind: 'material', quantity_per_unit: 1, unit_cost: 4.85, waste_pct: 5 }),
    ])
    expect(result.total).toBe(509.25)
    expect(result.lines[0]!.quantity).toBe(105)
  })

  it('aggregates across kinds without cross-contamination', () => {
    const result = resolveAssembly(1000, baseAssembly, [
      comp({ kind: 'material', name: 'EPS', quantity_per_unit: 1, unit_cost: 4.85, sort_order: 1 }),
      comp({ kind: 'material', name: 'mesh', quantity_per_unit: 1.1, unit_cost: 0.35, sort_order: 2 }),
      comp({ kind: 'labor', name: 'install', quantity_per_unit: 0.05, unit_cost: 65, sort_order: 3 }),
      comp({ kind: 'freight', name: 'delivery', quantity_per_unit: 1, unit_cost: 0.15, sort_order: 4 }),
    ])
    // material: 1000×1×4.85 + 1000×1.1×0.35 = 4850 + 385 = 5235
    expect(result.by_kind.material).toBe(5235)
    // labor: 1000×0.05×65 = 3250
    expect(result.by_kind.labor).toBe(3250)
    // freight: 1000×1×0.15 = 150
    expect(result.by_kind.freight).toBe(150)
    expect(result.by_kind.sub).toBe(0)
    expect(result.total).toBe(8635)
    expect(result.lines).toHaveLength(4)
  })

  it('respects sort_order in output line order', () => {
    const result = resolveAssembly(10, baseAssembly, [
      comp({ id: 'c-2', name: 'B', sort_order: 2 }),
      comp({ id: 'c-1', name: 'A', sort_order: 1 }),
      comp({ id: 'c-3', name: 'C', sort_order: 3 }),
    ])
    expect(result.lines.map((l) => l.name)).toEqual(['A', 'B', 'C'])
  })

  it('skips components that belong to a different assembly id (defensive)', () => {
    const result = resolveAssembly(100, baseAssembly, [
      comp({ assembly_id: 'a-1', kind: 'material', unit_cost: 1 }),
      comp({ assembly_id: 'other', kind: 'material', unit_cost: 999 }),
    ])
    expect(result.total).toBe(100)
  })

  it('throws on negative quantity', () => {
    expect(() => resolveAssembly(-5, baseAssembly, [])).toThrow(/invalid measurementQuantity/)
  })

  it('a resolvedQuantities override beats the static quantity_per_unit', () => {
    // static qty_per_unit is 1, but the formula resolved 2 per unit.
    const c = comp({ id: 'c-formula', kind: 'material', quantity_per_unit: 1, unit_cost: 10 })
    const overrides = new Map<string, number>([['c-formula', 2]])
    const result = resolveAssembly(100, baseAssembly, [c], overrides)
    // 100 × 2 (override) × $10 = $2000 (not 100 × 1 × 10 = 1000)
    expect(result.lines[0]!.quantity).toBe(200)
    expect(result.total).toBe(2000)
  })

  it('waste_pct still applies on top of an overridden per-unit quantity', () => {
    const c = comp({ id: 'c-formula', kind: 'material', quantity_per_unit: 1, unit_cost: 10, waste_pct: 10 })
    const overrides = new Map<string, number>([['c-formula', 2]])
    const result = resolveAssembly(100, baseAssembly, [c], overrides)
    // 100 × 2 × (1 + 10%) = 220 qty; × $10 = $2200
    expect(result.lines[0]!.quantity).toBe(220)
    expect(result.total).toBe(2200)
  })

  it('components absent from the override map keep the static path', () => {
    const formulaC = comp({ id: 'c-formula', kind: 'material', quantity_per_unit: 1, unit_cost: 10, sort_order: 1 })
    const staticC = comp({ id: 'c-static', kind: 'labor', quantity_per_unit: 0.05, unit_cost: 60, sort_order: 2 })
    const overrides = new Map<string, number>([['c-formula', 2]])
    const result = resolveAssembly(100, baseAssembly, [formulaC, staticC], overrides)
    expect(result.by_kind.material).toBe(2000) // 100 × 2 × 10
    expect(result.by_kind.labor).toBe(300) // 100 × 0.05 × 60 (unchanged static path)
  })

  it('models a cladding assembly (EIFS Complete) at 1000 sqft → expected per-kind subtotals', () => {
    // Static seed-style recipe (no formulas): EPS board + base coat + mesh +
    // finish (material), install (labor), delivery (freight).
    const result = resolveAssembly(1000, baseAssembly, [
      comp({ kind: 'material', name: 'EPS board', quantity_per_unit: 1, unit_cost: 1.2, waste_pct: 5, sort_order: 1 }),
      comp({ kind: 'material', name: 'base coat', quantity_per_unit: 1, unit_cost: 0.55, waste_pct: 5, sort_order: 2 }),
      comp({ kind: 'material', name: 'mesh', quantity_per_unit: 1.1, unit_cost: 0.35, waste_pct: 0, sort_order: 3 }),
      comp({ kind: 'labor', name: 'install', quantity_per_unit: 0.04, unit_cost: 65, waste_pct: 0, sort_order: 4 }),
      comp({ kind: 'freight', name: 'delivery', quantity_per_unit: 1, unit_cost: 0.08, waste_pct: 0, sort_order: 5 }),
    ])
    // material: 1000×1×1.05×1.2 + 1000×1×1.05×0.55 + 1000×1.1×0.35
    //         = 1260 + 577.5 + 385 = 2222.5
    expect(result.by_kind.material).toBe(2222.5)
    // labor: 1000×0.04×65 = 2600
    expect(result.by_kind.labor).toBe(2600)
    // freight: 1000×1×0.08 = 80
    expect(result.by_kind.freight).toBe(80)
    expect(result.total).toBe(2222.5 + 2600 + 80)
  })
})

describe('selectActiveAssembly', () => {
  it('returns null when nothing matches', () => {
    expect(selectActiveAssembly('XYZ', [])).toBeNull()
  })

  it('picks the newest version when multiple actives exist', () => {
    const result = selectActiveAssembly('EIFS-STD', [
      { ...baseAssembly, id: 'old', version: 1, deleted_at: null },
      { ...baseAssembly, id: 'new', version: 3, deleted_at: null },
      { ...baseAssembly, id: 'mid', version: 2, deleted_at: null },
    ])
    expect(result?.id).toBe('new')
  })

  it('skips deleted assemblies even if their version is higher', () => {
    const result = selectActiveAssembly('EIFS-STD', [
      { ...baseAssembly, id: 'active', version: 1, deleted_at: null },
      { ...baseAssembly, id: 'deleted', version: 99, deleted_at: '2026-05-01T00:00:00Z' },
    ])
    expect(result?.id).toBe('active')
  })
})

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

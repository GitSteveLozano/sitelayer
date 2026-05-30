import { describe, expect, it } from 'vitest'
import { explodeMeasurement, resolveComponentFormulas, type LoadedAssembly } from './assembly-explode.js'
import { HttpError } from './http-utils.js'

function loaded(components: LoadedAssembly['components']): LoadedAssembly {
  return {
    header: { id: 'a-1', service_item_code: 'EIFS', name: 'EIFS Complete', unit: 'sqft' },
    components,
  }
}

const baseComp = (
  overrides: Partial<LoadedAssembly['components'][number]> = {},
): LoadedAssembly['components'][number] => ({
  id: `c-${Math.random().toString(16).slice(2)}`,
  assembly_id: 'a-1',
  kind: 'material',
  name: 'EPS board',
  quantity_per_unit: 1,
  unit: 'sqft',
  unit_cost: 1,
  waste_pct: 0,
  sort_order: 0,
  quantity_formula: null,
  formula_vars: null,
  ...overrides,
})

describe('resolveComponentFormulas', () => {
  it('evaluates a formula against measurement_quantity + formula_vars', () => {
    const a = loaded([
      baseComp({
        id: 'c-1',
        quantity_formula: 'measurement_quantity * 1.1 / coverage_rate',
        formula_vars: { coverage_rate: 32 },
      }),
    ])
    const resolved = resolveComponentFormulas(a, 500, 'sqft')
    // 500 * 1.1 / 32 = 17.1875
    expect(resolved.get('c-1')).toBeCloseTo(17.1875, 4)
  })

  it('skips components with no formula', () => {
    const a = loaded([baseComp({ id: 'c-static', quantity_formula: null })])
    expect(resolveComponentFormulas(a, 100, 'sqft').size).toBe(0)
  })

  it('throws HttpError(400) on an undefined variable', () => {
    const a = loaded([baseComp({ id: 'c-bad', quantity_formula: 'measurement_quantity * missing_var' })])
    expect(() => resolveComponentFormulas(a, 100, 'sqft')).toThrow(HttpError)
    expect(() => resolveComponentFormulas(a, 100, 'sqft')).toThrow(/component "EPS board"/)
  })

  it('throws HttpError(400) on divide by zero', () => {
    const a = loaded([
      baseComp({
        id: 'c-div0',
        quantity_formula: 'measurement_quantity / coverage_rate',
        formula_vars: { coverage_rate: 0 },
      }),
    ])
    expect(() => resolveComponentFormulas(a, 100, 'sqft')).toThrow(HttpError)
  })
})

describe('explodeMeasurement', () => {
  it('emits one priced line per component with assembly provenance + kind', () => {
    const a = loaded([
      baseComp({ id: 'm1', kind: 'material', quantity_per_unit: 1, unit_cost: 4.85, sort_order: 1 }),
      baseComp({ id: 'l1', kind: 'labor', name: 'install', quantity_per_unit: 0.05, unit_cost: 60, sort_order: 2 }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 1000,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: 'D1',
      fallbackServiceItemCode: 'EIFS',
      profileConfig: null, // → DEFAULT_MARKUP_CONFIG (material +10% waste, labor +15% burden, profit 0)
    })
    expect(out.lines).toHaveLength(2)
    const mat = out.lines.find((l) => l.kind === 'material')!
    const lab = out.lines.find((l) => l.kind === 'labor')!
    expect(mat.assembly_id).toBe('a-1')
    expect(mat.assembly_component_id).toBe('m1')
    expect(mat.division_code).toBe('D1')
    expect(mat.service_item_code).toBe('EIFS')
    // material raw: 1000 × 1 × 4.85 = 4850; ×1.10 waste = 5335
    expect(mat.amount).toBe(5335)
    // labor raw: 1000 × 0.05 × 60 = 3000; ×1.15 burden = 3450
    expect(lab.amount).toBe(3450)
    // sum of stored amounts equals the markup total (baked-in)
    const sum = out.lines.reduce((s, l) => s + l.amount, 0)
    expect(sum).toBeCloseTo(out.markup.total, 2)
  })

  it('signs every quantity + amount when is_deduction is true', () => {
    const a = loaded([baseComp({ id: 'm1', kind: 'material', quantity_per_unit: 1, unit_cost: 10 })])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: true,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: null,
    })
    expect(out.lines[0]!.quantity).toBeLessThan(0)
    expect(out.lines[0]!.amount).toBeLessThan(0)
    // 100 × 1 × 10 = 1000; ×1.10 waste = 1100; negated
    expect(out.lines[0]!.amount).toBe(-1100)
  })

  it('bakes a profit margin into every line so the sum matches markup.total', () => {
    const a = loaded([
      baseComp({ id: 'm1', kind: 'material', quantity_per_unit: 1, unit_cost: 10, sort_order: 1 }),
      baseComp({ id: 'l1', kind: 'labor', quantity_per_unit: 0.1, unit_cost: 50, sort_order: 2 }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: { material_waste_pct: 0, labor_burden_pct: 0, profit_margin_pct: 20 },
    })
    // raw subtotal: material 1000 + labor 500 = 1500; profit ×1.25 = 1875
    expect(out.markup.total).toBe(1875)
    const sum = out.lines.reduce((s, l) => s + l.amount, 0)
    expect(sum).toBeCloseTo(1875, 2)
  })

  it('evaluates a formula component end-to-end through the explode pipeline', () => {
    const a = loaded([
      baseComp({
        id: 'c-formula',
        kind: 'material',
        name: 'finish coat',
        quantity_formula: 'measurement_quantity / coverage_rate',
        formula_vars: { coverage_rate: 100 },
        unit_cost: 40,
      }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 1000,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
    })
    // resolved per-unit = 1000/100 = 10; physical qty = 1000 × 10 = 10000; × $40 = 400000
    expect(out.lines[0]!.quantity).toBe(10000)
    expect(out.lines[0]!.amount).toBe(400000)
  })
})

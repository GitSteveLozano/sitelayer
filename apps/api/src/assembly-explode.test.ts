import { describe, expect, it } from 'vitest'
import {
  explodeMeasurement,
  includeComponent,
  resolveComponentFormulas,
  type LoadedAssembly,
} from './assembly-explode.js'
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
  include_when: null,
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

describe('measurement drivers (M2)', () => {
  it('binds height/width/perimeter/sides into a component formula', () => {
    // A 200 sqft wall (perimeter 60 ft) drives three distinct quantities off one
    // measurement: plate-LF from perimeter, stud-count from height, sheet-count
    // from area. Each is a separate component formula referencing a driver.
    const a = loaded([
      baseComp({
        id: 'plate',
        kind: 'material',
        name: 'bottom plate',
        // LF of plate = perimeter (1 pass).
        quantity_formula: 'perimeter',
        unit: 'lf',
        unit_cost: 1,
      }),
      baseComp({
        id: 'studs',
        kind: 'material',
        name: 'studs',
        // studs = wall length (width) / 16"OC spacing; height unused here but bound.
        quantity_formula: 'width / spacing_ft + 1',
        formula_vars: { spacing_ft: 1.3333 },
        unit: 'ea',
        unit_cost: 1,
        sort_order: 2,
      }),
    ])
    const resolved = resolveComponentFormulas(a, 200, 'sqft', {
      width: 20,
      height: 10,
      perimeter: 60,
      sides: 4,
    })
    // per-unit-of-assembly resolved values (multiplied by measurement_quantity
    // inside resolveAssembly, so these are the RAW formula outputs).
    expect(resolved.get('plate')).toBeCloseTo(60, 4)
    expect(resolved.get('studs')).toBeCloseTo(20 / 1.3333 + 1, 3)
  })

  it('defaults an absent driver to 0 instead of erroring', () => {
    // A formula referencing `height` on a measurement with no height driver
    // (e.g. a flat count) must not throw "undefined variable" — it binds to 0.
    const a = loaded([baseComp({ id: 'c-h', quantity_formula: 'measurement_quantity + height' })])
    const resolved = resolveComponentFormulas(a, 100, 'ea' /* no drivers arg */)
    expect(resolved.get('c-h')).toBe(100)
  })

  it('explodes a multi-driver assembly end-to-end', () => {
    const a = loaded([
      baseComp({
        id: 'plate',
        kind: 'material',
        name: 'plate',
        quantity_formula: 'perimeter',
        unit: 'lf',
        unit_cost: 2,
        sort_order: 1,
      }),
      baseComp({
        id: 'sheets',
        kind: 'material',
        name: 'sheathing',
        // sheets = area / 32 sqft per sheet; area === measurement_quantity.
        quantity_formula: 'measurement_quantity / 32',
        unit: 'ea',
        unit_cost: 12,
        sort_order: 2,
      }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 320, // 320 sqft wall
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'WALL',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
      drivers: { perimeter: 60, width: 20, height: 16, sides: 4 },
    })
    const plate = out.lines.find((l) => l.assembly_component_id === 'plate')!
    const sheets = out.lines.find((l) => l.assembly_component_id === 'sheets')!
    // plate: per-unit 60 × measurement 320 = 19200 lf × $2 = 38400
    expect(plate.quantity).toBe(19200)
    expect(plate.amount).toBe(38400)
    // sheets: per-unit 320/32 = 10 × measurement 320 = 3200 ea × $12 = 38400
    expect(sheets.quantity).toBe(3200)
    expect(sheets.amount).toBe(38400)
  })
})

describe('dimensional guard (§4 units — non-fatal)', () => {
  it('surfaces a unit_warning when a recognised component unit is incompatible with the measurement unit', () => {
    // A sqft measurement exploding through a per-LF component is the exact
    // silent-error class §4 calls out. The line still emits (non-fatal) but
    // carries a warning.
    const a = loaded([
      baseComp({ id: 'sf', name: 'mesh', kind: 'material', unit: 'sqft', unit_cost: 1, sort_order: 1 }),
      baseComp({ id: 'lf', name: 'corner bead', kind: 'material', unit: 'lf', unit_cost: 2, sort_order: 2 }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
    })
    expect(out.lines).toHaveLength(2)
    const sf = out.lines.find((l) => l.assembly_component_id === 'sf')!
    const lf = out.lines.find((l) => l.assembly_component_id === 'lf')!
    // sqft-vs-sqft is compatible → no warning.
    expect(sf.unit_warning).toBeUndefined()
    // sqft-vs-lf is dimensionally incompatible → warning present, but the line
    // is still emitted (non-fatal).
    expect(lf.unit_warning).toBeDefined()
    expect(lf.unit_warning).toMatch(/dimensionally incorrect/)
    expect(lf.amount).toBe(200) // 100 × 2, still produced
  })

  it('does NOT warn when either unit is free text we cannot type (tolerant default)', () => {
    const a = loaded([
      baseComp({ id: 'freetext', name: 'special widget', kind: 'material', unit: 'per wall', unit_cost: 3 }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
    })
    expect(out.lines[0]!.unit_warning).toBeUndefined()
  })

  it('does NOT warn on aliased-but-compatible spellings (SF measurement, sq ft component)', () => {
    const a = loaded([baseComp({ id: 'c', name: 'board', kind: 'material', unit: 'sq ft', unit_cost: 1 })])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'SF',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'EIFS',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
    })
    expect(out.lines[0]!.unit_warning).toBeUndefined()
  })
})

describe('include_when (M2)', () => {
  it('includeComponent: null/empty expr always includes', () => {
    const a = loaded([baseComp({ id: 'c1', include_when: null })])
    expect(includeComponent(a, a.components[0]!, 100, 'sqft')).toBe(true)
    const b = loaded([baseComp({ id: 'c2', include_when: '   ' })])
    expect(includeComponent(b, b.components[0]!, 100, 'sqft')).toBe(true)
  })

  it('includeComponent: a falsy expr skips, a truthy expr keeps', () => {
    const a = loaded([baseComp({ id: 'tall', include_when: 'height >= 8' })])
    expect(includeComponent(a, a.components[0]!, 100, 'sqft', { height: 10 })).toBe(true)
    expect(includeComponent(a, a.components[0]!, 100, 'sqft', { height: 6 })).toBe(false)
    // absent driver binds to 0 → 0 >= 8 is false → skipped.
    expect(includeComponent(a, a.components[0]!, 100, 'sqft')).toBe(false)
  })

  it('explode skips an include_when-false component entirely', () => {
    const a = loaded([
      baseComp({ id: 'studs', name: 'studs', kind: 'material', unit_cost: 3, sort_order: 1 }),
      baseComp({
        id: 'blocking',
        name: 'fire blocking',
        kind: 'material',
        unit_cost: 5,
        sort_order: 2,
        // only include blocking when the wall is tall enough.
        include_when: 'height > 9',
      }),
    ])
    const out = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'WALL',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
      drivers: { height: 8 }, // 8 > 9 is false → blocking skipped
    })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]!.assembly_component_id).toBe('studs')
    expect(out.resolution.total).toBe(100 * 3)
    // and when the wall IS tall enough, blocking is back in.
    const tall = explodeMeasurement({
      assembly: a,
      measurementQuantity: 100,
      measurementUnit: 'sqft',
      isDeduction: false,
      divisionCode: null,
      fallbackServiceItemCode: 'WALL',
      profileConfig: { material_waste_pct: 0, profit_margin_pct: 0 },
      drivers: { height: 12 },
    })
    expect(tall.lines).toHaveLength(2)
    expect(tall.resolution.total).toBe(100 * 3 + 100 * 5)
  })

  it('throws HttpError(400) on a bad include_when expression', () => {
    const a = loaded([baseComp({ id: 'bad', include_when: 'unknown_var > 1' })])
    expect(() =>
      explodeMeasurement({
        assembly: a,
        measurementQuantity: 100,
        measurementUnit: 'sqft',
        isDeduction: false,
        divisionCode: null,
        fallbackServiceItemCode: 'WALL',
        profileConfig: null,
      }),
    ).toThrow(HttpError)
    expect(() => includeComponent(a, a.components[0]!, 100, 'sqft')).toThrow(/include_when/)
  })
})

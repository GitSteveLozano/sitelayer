import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { LedgerExecutor } from '../mutation-tx.js'
import { createEstimateFromMeasurements } from './estimate.js'

// ---------------------------------------------------------------------------
// PlanSwift Phase 2 integration proof: assembly explosion inside the recompute
// path (createEstimateFromMeasurements).
//
//   - measurement with assembly_id NULL  → ONE flat line (regression).
//   - measurement with assembly_id set   → N component lines carrying
//     assembly_id / kind / amount; sum(amount) matches the explode math.
//   - soft-deleted assembly attached      → falls back to the flat line.
//   - formula error in a component        → recompute throws (HttpError 400);
//     the captured INSERT never runs (tx-rollback semantics — the executor
//     here is the raw fake, the route wraps it in withMutationTx).
//
// The fake `executor` answers each query by substring; the estimate_lines
// INSERT is captured so we can assert the exploded rows.
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co-1'
const PROJECT_ID = 'p-1'
const DRAFT_ID = 'd-1'
const ASSEMBLY_ID = 'a-1'

type Measurement = {
  service_item_code: string
  quantity: string
  unit: string
  notes: string | null
  division_code: string | null
  is_deduction: boolean
  assembly_id: string | null
  condition_id?: string | null
  geometry?: unknown
}

/** A takeoff_conditions row the fake executor returns from loadConditionsByMeasurement. */
type FakeCondition = {
  id: string
  measurement_kind: string
  height_value: string | number | null
  thickness_value: string | number | null
  emit_linear: boolean
  emit_area: boolean
  emit_volume: boolean
}

type FakeComponent = {
  id: string
  assembly_id: string
  kind: string
  name: string
  quantity_per_unit: number
  unit: string
  unit_cost: number
  waste_pct: number
  sort_order: number
  quantity_formula: string | null
  formula_vars: Record<string, unknown> | null
}

function makeExecutor(opts: {
  measurements: Measurement[]
  assemblyDeleted?: boolean
  components?: FakeComponent[]
  pricingConfig?: unknown
  conditions?: FakeCondition[]
}) {
  const inserted: { rows: Array<Record<string, unknown>> } = { rows: [] }
  const components = opts.components ?? []

  const executor = {
    async query(sqlRaw: string, params: unknown[] = []) {
      const sql = sqlRaw.trim()

      // project lookup
      if (/^select id, customer_id, bid_total/i.test(sql)) {
        return {
          rows: [
            {
              id: PROJECT_ID,
              customer_id: null,
              bid_total: 0,
              labor_rate: 50,
              bonus_pool: 0,
              division_code: 'D1',
            },
          ],
        }
      }
      // measurements
      if (/from takeoff_measurements/i.test(sql) && /select service_item_code/i.test(sql)) {
        return { rows: opts.measurements }
      }
      // loadConditionsByMeasurement
      if (/from takeoff_conditions/i.test(sql) && /select id, measurement_kind/i.test(sql)) {
        return { rows: opts.conditions ?? [] }
      }
      // resolvePrices CTE
      if (/with[\s\S]*project_layer as/i.test(sql)) {
        return {
          rows: [{ service_item_code: 'EIFS', source: 'fallback', source_id: 'si-1', rate: '4.85', unit: 'sqft' }],
        }
      }
      // delete estimate_lines
      if (/^delete from estimate_lines/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      // loadAssembliesByMeasurement — headers
      if (/^select id, service_item_code, name, unit\s+from service_item_assemblies/i.test(sql)) {
        if (opts.assemblyDeleted) return { rows: [] }
        return { rows: [{ id: ASSEMBLY_ID, service_item_code: 'EIFS', name: 'EIFS Complete', unit: 'sqft' }] }
      }
      // loadAssembliesByMeasurement — components
      if (/from service_item_assembly_components/i.test(sql)) {
        return { rows: components }
      }
      // default pricing profile config
      if (/^select\s+config\s+from\s+pricing_profiles/i.test(sql)) {
        return { rows: [{ config: opts.pricingConfig ?? null }] }
      }
      // estimate_lines INSERT (unnest)
      if (/^insert into estimate_lines/i.test(sql)) {
        // Reconstruct the rows from the parallel arrays so we can assert them.
        const [, , codes, quantities, units, rates, amounts, divisions, , assemblyIds, componentIds, kinds] =
          params as [
            string,
            string,
            string[],
            string[],
            string[],
            string[],
            string[],
            (string | null)[],
            string | null,
            string[],
            string[],
            (string | null)[],
          ]
        const rows = codes.map((code, i) => ({
          service_item_code: code,
          quantity: quantities[i],
          unit: units[i],
          rate: rates[i],
          amount: amounts[i],
          division_code: divisions[i],
          assembly_id: assemblyIds[i] === '' ? null : assemblyIds[i],
          assembly_component_id: componentIds[i] === '' ? null : componentIds[i],
          kind: kinds[i],
          created_at: '2026-01-01T00:00:00.000Z',
        }))
        inserted.rows = rows
        return { rows }
      }
      // projects update (bid_total / version bump)
      if (/^update projects/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`)
    },
  }

  return { executor: executor as unknown as LedgerExecutor, inserted }
}

const flatMeasurement: Measurement = {
  service_item_code: 'EIFS',
  quantity: '1000',
  unit: 'sqft',
  notes: null,
  division_code: 'D1',
  is_deduction: false,
  assembly_id: null,
}
const assemblyMeasurement: Measurement = { ...flatMeasurement, assembly_id: ASSEMBLY_ID }

const eifsComponents: FakeComponent[] = [
  {
    id: 'm1',
    assembly_id: ASSEMBLY_ID,
    kind: 'material',
    name: 'EPS board',
    quantity_per_unit: 1,
    unit: 'sqft',
    unit_cost: 4.85,
    waste_pct: 0,
    sort_order: 1,
    quantity_formula: null,
    formula_vars: null,
  },
  {
    id: 'l1',
    assembly_id: ASSEMBLY_ID,
    kind: 'labor',
    name: 'install',
    quantity_per_unit: 0.05,
    unit: 'hr',
    unit_cost: 60,
    waste_pct: 0,
    sort_order: 2,
    quantity_formula: null,
    formula_vars: null,
  },
]

describe('createEstimateFromMeasurements assembly explosion', () => {
  it('flat measurement (no assembly) → one flat line, no assembly provenance', async () => {
    const { executor, inserted } = makeExecutor({ measurements: [flatMeasurement] })
    const result = await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(result).not.toBeNull()
    expect(inserted.rows).toHaveLength(1)
    expect(inserted.rows[0]!.assembly_id).toBeNull()
    expect(inserted.rows[0]!.kind).toBeNull()
    // 1000 × 4.85 = 4850
    expect(Number(inserted.rows[0]!.amount)).toBe(4850)
  })

  it('assembly measurement → N component lines with provenance; sum matches the explode math', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [assemblyMeasurement],
      components: eifsComponents,
      pricingConfig: { material_waste_pct: 0, labor_burden_pct: 0, profit_margin_pct: 0 },
    })
    const result = await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(2)
    for (const r of inserted.rows) {
      expect(r.assembly_id).toBe(ASSEMBLY_ID)
      expect(['material', 'labor']).toContain(r.kind)
      expect(r.division_code).toBe('D1')
    }
    const sum = inserted.rows.reduce((s, r) => s + Number(r.amount), 0)
    // material 1000×4.85=4850 + labor 1000×0.05×60=3000 = 7850 (no markup uplift)
    expect(sum).toBe(7850)
    expect(result!.assemblyBreakdowns).toHaveLength(1)
    expect(result!.assemblyBreakdowns[0]!.assembly_id).toBe(ASSEMBLY_ID)
  })

  it('soft-deleted assembly attached → falls back to the flat line', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [assemblyMeasurement],
      assemblyDeleted: true,
      components: eifsComponents,
    })
    await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(1)
    expect(inserted.rows[0]!.assembly_id).toBeNull()
    expect(Number(inserted.rows[0]!.amount)).toBe(4850)
  })

  it('a bad component formula aborts recompute with HttpError(400) — no INSERT', async () => {
    const badComponents: FakeComponent[] = [
      { ...eifsComponents[0]!, quantity_formula: 'measurement_quantity * missing_var' },
    ]
    const { executor, inserted } = makeExecutor({
      measurements: [assemblyMeasurement],
      components: badComponents,
    })
    await expect(
      createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
        draftId: DRAFT_ID,
        executor,
      }),
    ).rejects.toThrow(/component "EPS board"/)
    expect(inserted.rows).toHaveLength(0)
  })

  it('a deduction assembly measurement flips signs on every component line', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [{ ...assemblyMeasurement, is_deduction: true }],
      components: eifsComponents,
      pricingConfig: { material_waste_pct: 0, labor_burden_pct: 0, profit_margin_pct: 0 },
    })
    await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    for (const r of inserted.rows) {
      expect(Number(r.amount)).toBeLessThan(0)
      expect(Number(r.quantity)).toBeLessThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Deep Dive H1 integration proof: condition_id is LOAD-BEARING in the recompute
// path. A measurement tagged with an emitting condition fans into multiple
// typed estimate_lines (area + linear + volume) instead of one ignored flat
// line. Conditions with no emit flags fall through to the flat path unchanged.
// The same fake executor drives the real createEstimateFromMeasurements.
// ---------------------------------------------------------------------------

const WALL_POLYGON = {
  kind: 'polygon',
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 0, y: 5 },
  ],
}

// service_item_code 'EIFS' resolves to rate 4.85 in the fake pricing CTE.
const conditionMeasurement: Measurement = {
  service_item_code: 'EIFS',
  quantity: '50', // an area measurement: stored qty = polygon area
  unit: 'sqft',
  notes: null,
  division_code: 'D1',
  is_deduction: false,
  assembly_id: null,
  condition_id: 'cond-1',
  geometry: WALL_POLYGON,
}

const wallCondition: FakeCondition = {
  id: 'cond-1',
  measurement_kind: 'area',
  height_value: null,
  thickness_value: '0.5',
  emit_linear: true,
  emit_area: true,
  emit_volume: true,
}

describe('createEstimateFromMeasurements condition emission', () => {
  it('a wall condition (area+linear+volume) fans ONE shape into THREE typed lines', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [conditionMeasurement],
      conditions: [wallCondition],
    })
    const result = await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(3)
    const byUnit = new Map(inserted.rows.map((r) => [r.unit, r]))
    // area 50 sqft, perimeter 30 lf, volume 50×0.5 = 25 cuft
    expect(Number(byUnit.get('sqft')!.quantity)).toBeCloseTo(50, 2)
    expect(Number(byUnit.get('lf')!.quantity)).toBeCloseTo(30, 2)
    expect(Number(byUnit.get('cuft')!.quantity)).toBeCloseTo(25, 2)
    // every emitted line is flat-priced (kind null, no assembly provenance) at
    // the resolved EIFS rate 4.85.
    for (const r of inserted.rows) {
      expect(r.kind).toBeNull()
      expect(r.assembly_id).toBeNull()
      expect(Number(r.rate)).toBeCloseTo(4.85, 2)
      expect(r.division_code).toBe('D1')
    }
    // recompute response carries the typed provenance breakdown.
    expect(result!.conditionBreakdowns).toHaveLength(3)
    expect(result!.conditionBreakdowns.map((b) => b.emit_kind).sort()).toEqual(['area', 'linear', 'volume'])
    expect(result!.conditionBreakdowns.every((b) => b.condition_id === 'cond-1')).toBe(true)
  })

  it('a deduction wall condition signs every emitted line negative', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [{ ...conditionMeasurement, is_deduction: true }],
      conditions: [wallCondition],
    })
    await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(3)
    for (const r of inserted.rows) {
      expect(Number(r.quantity)).toBeLessThan(0)
      expect(Number(r.amount)).toBeLessThan(0)
    }
  })

  it('a condition with NO emit flags falls back to ONE flat line', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [conditionMeasurement],
      conditions: [{ ...wallCondition, emit_area: false, emit_linear: false, emit_volume: false }],
    })
    const result = await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(1)
    expect(Number(inserted.rows[0]!.quantity)).toBeCloseTo(50, 2)
    expect(inserted.rows[0]!.unit).toBe('sqft')
    expect(inserted.rows[0]!.assembly_id).toBeNull()
    expect(result!.conditionBreakdowns).toHaveLength(0)
  })

  it('a soft-deleted / missing condition row falls back to the flat line', async () => {
    const { executor, inserted } = makeExecutor({
      measurements: [conditionMeasurement],
      conditions: [], // condition_id set but not returned (deleted)
    })
    await createEstimateFromMeasurements(undefined as unknown as Pool, COMPANY_ID, PROJECT_ID, {
      draftId: DRAFT_ID,
      executor,
    })
    expect(inserted.rows).toHaveLength(1)
    expect(Number(inserted.rows[0]!.quantity)).toBeCloseTo(50, 2)
    expect(inserted.rows[0]!.unit).toBe('sqft')
  })
})

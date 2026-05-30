/**
 * Assembly explosion — the API-side wiring of the PlanSwift Phase 2 parts /
 * assembly engine (docs/PLANSWIFT_PHASE2_PLAN.md §3b).
 *
 * The pure math lives in @sitelayer/domain (`resolveAssembly`, `applyMarkup`)
 * and the formula sandbox in @sitelayer/formula-evaluator. This module owns the
 * I/O + glue:
 *
 *   - loadAssembliesByMeasurement — one query that hydrates the headers +
 *     components for the distinct assembly ids attached to a draft's
 *     measurements.
 *   - explodeMeasurement — for a single measurement that carries an assembly:
 *     evaluate each component's optional quantity_formula, run resolveAssembly,
 *     apply the per-kind markup multipliers from the pricing profile, sign by
 *     is_deduction, and emit N estimate-line rows (one per component) with the
 *     baked-in (waste + burden + profit) amount and the assembly provenance.
 *
 * Both the recompute path (estimate.ts) and the preview route
 * (assemblies.ts → POST /api/assemblies/:id/explode) call into here so the math
 * is identical in both surfaces.
 */

import {
  applyMarkup,
  resolveAssembly,
  type AssemblyComponent,
  type AssemblyHeader,
  type AssemblyKind,
  type AssemblyResolution,
  type MarkupBreakdown,
  type SubtotalsByKind,
} from '@sitelayer/domain'
import { evaluateFormulaUnsafe, type FormulaContext } from '@sitelayer/formula-evaluator'
import type { LedgerExecutor } from './mutation-tx.js'
import { HttpError } from './http-utils.js'

/** A hydrated assembly: its header plus the active component recipe rows. */
export interface LoadedAssembly {
  header: AssemblyHeader & { unit: string; name: string }
  components: AssemblyComponent[]
}

type AssemblyHeaderRow = {
  id: string
  service_item_code: string
  name: string
  unit: string
}

type AssemblyComponentRow = {
  id: string
  assembly_id: string
  kind: AssemblyKind
  name: string
  quantity_per_unit: string | number
  unit: string
  unit_cost: string | number
  waste_pct: string | number
  sort_order: number
  quantity_formula: string | null
  formula_vars: Record<string, unknown> | null
}

/**
 * Hydrate the distinct, active assemblies attached to a set of measurement
 * rows. Returns a Map keyed by assembly id. Soft-deleted assemblies and any
 * assembly whose header is gone are simply absent from the map — the caller
 * falls back to the flat-line path for those (the safe default).
 */
export async function loadAssembliesByMeasurement(
  executor: LedgerExecutor,
  companyId: string,
  measurementRows: ReadonlyArray<{ assembly_id?: string | null }>,
): Promise<Map<string, LoadedAssembly>> {
  const assemblyIds = Array.from(
    new Set(measurementRows.map((m) => m.assembly_id ?? null).filter((id): id is string => Boolean(id))),
  )
  const byId = new Map<string, LoadedAssembly>()
  if (assemblyIds.length === 0) return byId

  const headers = await executor.query<AssemblyHeaderRow>(
    `select id, service_item_code, name, unit
       from service_item_assemblies
      where company_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [companyId, assemblyIds],
  )
  if (headers.rows.length === 0) return byId

  const presentIds = headers.rows.map((h) => h.id)
  const components = await executor.query<AssemblyComponentRow>(
    `select id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost, waste_pct,
            sort_order, quantity_formula, formula_vars
       from service_item_assembly_components
      where company_id = $1 and assembly_id = any($2::uuid[])
      order by sort_order asc, created_at asc`,
    [companyId, presentIds],
  )

  for (const h of headers.rows) {
    byId.set(h.id, {
      header: { id: h.id, service_item_code: h.service_item_code, name: h.name, unit: h.unit },
      components: [],
    })
  }
  for (const c of components.rows) {
    const entry = byId.get(c.assembly_id)
    if (!entry) continue
    entry.components.push({
      id: c.id,
      assembly_id: c.assembly_id,
      kind: c.kind,
      name: c.name,
      quantity_per_unit: Number(c.quantity_per_unit),
      unit: c.unit,
      unit_cost: Number(c.unit_cost),
      waste_pct: Number(c.waste_pct),
      sort_order: c.sort_order,
      quantity_formula: c.quantity_formula,
      formula_vars: normalizeFormulaVars(c.formula_vars),
    })
  }
  return byId
}

/** Coerce a jsonb formula_vars blob into the number|string scope the evaluator accepts. */
function normalizeFormulaVars(raw: Record<string, unknown> | null): Record<string, number | string> | null {
  if (raw === null || typeof raw !== 'object') return null
  const out: Record<string, number | string> = {}
  for (const key of Object.keys(raw)) {
    const v = raw[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'string') out[key] = v
    // anything else is dropped — the evaluator would reject it anyway.
  }
  return out
}

/**
 * Evaluate every component's optional quantity_formula against the concrete
 * measurement quantity, returning the per-component resolved per-unit map that
 * {@link resolveAssembly} consumes. Throws HttpError(400) on the first bad
 * formula so the surrounding recompute transaction aborts cleanly with no
 * partial write.
 */
export function resolveComponentFormulas(
  assembly: LoadedAssembly,
  measurementQuantity: number,
  measurementUnit: string,
): Map<string, number> {
  const resolved = new Map<string, number>()
  for (const c of assembly.components) {
    const formula = c.quantity_formula
    if (!formula) continue
    const ctx: FormulaContext = {
      measurement_quantity: measurementQuantity,
      measurement_unit: measurementUnit,
      ...(c.formula_vars ?? {}),
    }
    const result = evaluateFormulaUnsafe(formula, ctx)
    if (!result.ok || result.value === undefined) {
      throw new HttpError(
        400,
        `Assembly "${assembly.header.name}" component "${c.name}": ${result.error?.message ?? 'formula evaluation failed'}`,
      )
    }
    resolved.set(c.id, result.value)
  }
  return resolved
}

/** One exploded estimate-line row, ready for the recompute unnest() INSERT. */
export interface ExplodedLine {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
  assembly_id: string
  assembly_component_id: string
  kind: AssemblyKind
}

export interface ExplodeResult {
  resolution: AssemblyResolution
  markup: MarkupBreakdown
  lines: ExplodedLine[]
}

/**
 * Explode one measurement's assembly into priced, signed estimate lines.
 *
 * Pipeline (per docs/PLANSWIFT_PHASE2_PLAN.md §3b):
 *   1. formula → resolvedQuantities (per component, formula-evaluator).
 *   2. resolveAssembly → per-component raw COST (quantity × waste × unit_cost).
 *   3. applyMarkup over the per-kind subtotals → per-kind multipliers + profit.
 *   4. bake the per-kind multiplier into each component line amount so every
 *      downstream consumer (scope-vs-bid, PDF, QBO push) that just sum()s
 *      `amount` stays correct with zero changes. Profit is layered as a single
 *      pseudo-line on the resolution `total` (see note below).
 *   5. sign every quantity + amount by `is_deduction` so deductions net out.
 *
 * Profit handling: `applyMarkup` lifts the post-waste/burden subtotal by a
 * single profit multiplier. Rather than fabricate an extra profit estimate
 * line, we fold the profit multiplier into every component line's amount so the
 * stored line totals sum to `markup.total`. (When profit_margin_pct === 0 — the
 * default — this is a no-op.)
 */
export function explodeMeasurement(args: {
  assembly: LoadedAssembly
  measurementQuantity: number
  measurementUnit: string
  isDeduction: boolean
  divisionCode: string | null
  /** Falls back to the measurement's service_item_code when a component carries none. */
  fallbackServiceItemCode: string
  /** Raw pricing-profile `config` jsonb (markup buckets). Defaults applied inside applyMarkup. */
  profileConfig: unknown
}): ExplodeResult {
  const { assembly, measurementQuantity, measurementUnit, isDeduction, divisionCode, fallbackServiceItemCode } = args

  const resolvedQuantities = resolveComponentFormulas(assembly, measurementQuantity, measurementUnit)
  const resolution = resolveAssembly(measurementQuantity, assembly.header, assembly.components, resolvedQuantities)

  const subtotals: SubtotalsByKind = resolution.by_kind
  const markup = applyMarkup(subtotals, args.profileConfig)

  // Per-kind multiplier (waste/burden) keyed by kind. applyMarkup omits zero
  // kinds, so a kind with no rows defaults to multiplier 1.
  const kindMultiplier: Partial<Record<AssemblyKind, number>> = {}
  for (const row of markup.lines) {
    if (row.basis === 'profit') continue
    kindMultiplier[row.basis as AssemblyKind] = row.multiplier
  }
  // The single profit multiplier (1 when margin is 0) lifts every line equally.
  const profitRow = markup.lines.find((r) => r.basis === 'profit')
  const profitMultiplier = profitRow ? profitRow.multiplier : 1

  const sign = isDeduction ? -1 : 1
  const lines: ExplodedLine[] = []
  for (const line of resolution.lines) {
    const km = kindMultiplier[line.kind] ?? 1
    // Bake waste/burden into the rate (so rate × qty === stored amount) and the
    // profit uplift into the amount only. Quantity stays the resolved physical
    // quantity (already includes per-component waste_pct).
    const bakedRate = round4(line.unit_cost * km * profitMultiplier)
    const bakedAmount = round2(line.amount * km * profitMultiplier)
    lines.push({
      service_item_code: fallbackServiceItemCode,
      quantity: sign * line.quantity,
      unit: line.unit,
      rate: bakedRate,
      amount: sign * bakedAmount,
      division_code: divisionCode,
      assembly_id: assembly.header.id,
      assembly_component_id: line.component_id,
      kind: line.kind,
    })
  }

  return { resolution, markup, lines }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

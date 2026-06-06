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
  assertCompatible,
  resolveAssembly,
  type AssemblyComponent,
  type AssemblyHeader,
  type AssemblyKind,
  type AssemblyResolution,
  type MarkupBreakdown,
  type MeasurementDrivers,
  type SubtotalsByKind,
} from '@sitelayer/domain'
import { evaluateBooleanFormulaUnsafe, evaluateFormulaUnsafe, type FormulaContext } from '@sitelayer/formula-evaluator'
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
  include_when: string | null
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
            sort_order, quantity_formula, formula_vars, include_when
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
      include_when: c.include_when,
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
 * Build the formula-evaluator context for one component: the always-bound
 * measurement quantity + unit, the five measurement DRIVERS (each defaulted to
 * `0` when the geometry carried none, so a referencing formula stays defined),
 * then the component's own `formula_vars` last (a component var may intentionally
 * shadow a driver of the same name). Pure — no I/O.
 */
function buildFormulaContext(
  component: AssemblyComponent,
  measurementQuantity: number,
  measurementUnit: string,
  drivers: MeasurementDrivers | undefined,
): FormulaContext {
  return {
    measurement_quantity: measurementQuantity,
    measurement_unit: measurementUnit,
    // Absent drivers bind to 0 so `height > 8` / `perimeter * 2` never error
    // with "undefined variable" on an uncalibrated or count geometry.
    height: drivers?.height ?? 0,
    width: drivers?.width ?? 0,
    thickness: drivers?.thickness ?? 0,
    perimeter: drivers?.perimeter ?? 0,
    sides: drivers?.sides ?? 0,
    ...(component.formula_vars ?? {}),
  }
}

/**
 * Decide whether a component is included in the explosion. A component with no
 * `include_when` is always included (unchanged behavior). When present, the
 * expression is evaluated against the same driver context and the component is
 * included only when the numeric result is truthy (non-zero). Throws
 * HttpError(400) on a bad expression so the recompute transaction aborts cleanly
 * with no partial write — same failure discipline as a bad quantity_formula.
 */
export function includeComponent(
  assembly: LoadedAssembly,
  component: AssemblyComponent,
  measurementQuantity: number,
  measurementUnit: string,
  drivers?: MeasurementDrivers,
): boolean {
  const expr = component.include_when
  if (!expr || expr.trim() === '') return true
  const ctx = buildFormulaContext(component, measurementQuantity, measurementUnit, drivers)
  // Boolean-aware eval: a bare comparison (`height > 8`) yields a boolean, an
  // arithmetic expr (`sides`) yields a number reduced to truthiness. Same
  // hardened sandbox as quantity_formula.
  const result = evaluateBooleanFormulaUnsafe(expr, ctx)
  if (!result.ok || result.value === undefined) {
    throw new HttpError(
      400,
      `Assembly "${assembly.header.name}" component "${component.name}" include_when: ${
        result.error?.message ?? 'expression evaluation failed'
      }`,
    )
  }
  return result.value
}

/**
 * Evaluate every component's optional quantity_formula against the concrete
 * measurement quantity + drivers, returning the per-component resolved per-unit
 * map that {@link resolveAssembly} consumes. Components skipped by `include_when`
 * are not evaluated. Throws HttpError(400) on the first bad formula so the
 * surrounding recompute transaction aborts cleanly with no partial write.
 */
export function resolveComponentFormulas(
  assembly: LoadedAssembly,
  measurementQuantity: number,
  measurementUnit: string,
  drivers?: MeasurementDrivers,
): Map<string, number> {
  const resolved = new Map<string, number>()
  for (const c of assembly.components) {
    if (!includeComponent(assembly, c, measurementQuantity, measurementUnit, drivers)) continue
    const formula = c.quantity_formula
    if (!formula) continue
    const ctx = buildFormulaContext(c, measurementQuantity, measurementUnit, drivers)
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
  /**
   * NON-FATAL dimensional guard (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §4
   * "Units"). Populated ONLY when BOTH the measurement's unit AND this
   * component's unit normalize to a recognised canonical unit AND they are in
   * different physical dimensions (e.g. a sqft measurement driving a per-LF
   * component — a dimensionally-incorrect, silently-wrong line). Absent for
   * compatible pairs and for any pair where either unit is free text we can't
   * type (the additive, free-text-tolerant default — we do NOT reject existing
   * rows). The recompute/preview surfaces this so the estimator can see the
   * mismatch instead of it being silent; it does NOT block the explosion.
   */
  unit_warning?: string
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
 *   0. include_when → drop components whose boolean expression evaluates falsy
 *      (M2; against the measurement-driver context). NULL include_when always
 *      keeps the component, so the legacy path is unchanged.
 *   1. formula → resolvedQuantities (per component, formula-evaluator), with the
 *      measurement DRIVERS (height/width/thickness/perimeter/sides) bound so one
 *      drawn object can drive several component quantities.
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
  /**
   * Measurement DRIVERS (height/width/thickness/perimeter/sides) bound into the
   * component formula + include_when context. Optional: an absent map binds
   * every driver to 0 (pre-M2 behavior — formulas referencing only
   * measurement_quantity are unaffected).
   */
  drivers?: MeasurementDrivers
}): ExplodeResult {
  const {
    assembly,
    measurementQuantity,
    measurementUnit,
    isDeduction,
    divisionCode,
    fallbackServiceItemCode,
    drivers,
  } = args

  // M2: drop components whose include_when evaluates falsy BEFORE the formula +
  // cost passes, so a skipped component contributes no resolved quantity, no
  // cost subtotal, and no estimate line.
  const includedComponents = assembly.components.filter((c) =>
    includeComponent(assembly, c, measurementQuantity, measurementUnit, drivers),
  )
  const includedAssembly: LoadedAssembly = { header: assembly.header, components: includedComponents }

  const resolvedQuantities = resolveComponentFormulas(includedAssembly, measurementQuantity, measurementUnit, drivers)
  const resolution = resolveAssembly(
    measurementQuantity,
    includedAssembly.header,
    includedAssembly.components,
    resolvedQuantities,
  )

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
    // §4 NON-FATAL dimensional guard: only fires when BOTH units are recognised
    // and dimensionally incompatible (e.g. a sqft measurement exploding through
    // a per-LF component). Unknown free text on either side -> ok=true,
    // recognized=false -> no warning (the additive, tolerant default).
    const compat = assertCompatible(measurementUnit, line.unit)
    const unitWarning =
      !compat.ok && compat.recognized
        ? `Component "${line.name}" is ${compat.b} (${compat.toDimension}) but the measurement is ${compat.a} (${compat.fromDimension}); the exploded quantity may be dimensionally incorrect.`
        : undefined
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
      // exactOptionalPropertyTypes: spread the field only when present so we
      // never assign `undefined` to an optional property.
      ...(unitWarning !== undefined ? { unit_warning: unitWarning } : {}),
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

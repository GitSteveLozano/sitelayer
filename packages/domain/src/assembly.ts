/**
 * Assembly resolver — turn a measurement into a cost breakdown.
 *
 * An assembly is a recipe: a service-item code paired with the
 * materials + labor + sub + freight components that go into one unit
 * (sqft, lf, ea, …) of that scope. The resolver multiplies each
 * component by the measurement quantity and the component-specific
 * waste % to produce per-line dollar totals.
 *
 * This is the PlanSwift gap referenced in the merger pitch: a takeoff
 * of "10,000 sqft of EIFS" should not require the estimator to enter
 * 5 separate cost lines (board, mesh, mesh tape, base coat, labor)
 * with hand-typed quantities. The assembly knows the recipe; the
 * estimator just enters the measurement.
 *
 * Pure function on plain data — no DB, no I/O. Routes hydrate the
 * inputs from `service_item_assemblies` + `service_item_assembly_components`,
 * call this, and write the result to `estimate_lines`.
 */

export type AssemblyKind = 'material' | 'labor' | 'sub' | 'freight'

export interface AssemblyComponent {
  id: string
  assembly_id: string
  kind: AssemblyKind
  name: string
  /** Per-unit-of-assembly quantity (e.g. 1.05 sqft of EPS per sqft of wall). */
  quantity_per_unit: number
  unit: string
  /** Cost per unit of THIS component (not per unit of the assembly). */
  unit_cost: number
  /** Optional waste %, applied multiplicatively after quantity_per_unit. */
  waste_pct: number
  sort_order: number
  /**
   * Optional quantity formula (e.g. "measurement_quantity * 1.1 / coverage_rate").
   * Evaluated by the CALLER (the explode path) via @sitelayer/formula-evaluator —
   * domain stays dependency-light, so the resolved value is passed back in via
   * the `resolvedQuantities` arg to {@link resolveAssembly}. NULL => static
   * `quantity_per_unit` path.
   */
  quantity_formula?: string | null
  /** Named vars bound when evaluating `quantity_formula` (e.g. {"coverage_rate": 32}). */
  formula_vars?: Record<string, number | string> | null
}

export interface AssemblyHeader {
  id: string
  service_item_code: string
  name: string
  unit: string
}

export interface AssemblyResolutionLine {
  component_id: string
  kind: AssemblyKind
  name: string
  unit: string
  /** Resolved quantity for this measurement (qty_per_unit × measurement × (1 + waste)). */
  quantity: number
  unit_cost: number
  /** Line subtotal — quantity × unit_cost. Rounded to 4 decimals to match the DB column. */
  amount: number
}

export interface AssemblyResolution {
  assembly_id: string
  service_item_code: string
  /** Total dollar cost across all components. */
  total: number
  /** Per-kind subtotals so estimate UIs can group by material vs labor. */
  by_kind: Record<AssemblyKind, number>
  lines: AssemblyResolutionLine[]
}

/**
 * Round to 4 decimal places. Matches `numeric(12,4)` storage; using
 * cents (2dp) here would compound rounding errors across 30+ components.
 */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

export function resolveAssembly(
  measurementQuantity: number,
  assembly: AssemblyHeader,
  components: readonly AssemblyComponent[],
  /**
   * Optional per-component resolved per-unit quantity overrides, keyed by
   * component id. When a component id is present in the map, its value REPLACES
   * `c.quantity_per_unit` as the per-unit-of-assembly quantity (the caller has
   * already evaluated the component's `quantity_formula` against the concrete
   * measurement). `waste_pct` still applies on top. When a component id is
   * absent, the static `c.quantity_per_unit` path runs unchanged — keeping the
   * formula-evaluator dependency out of @sitelayer/domain and this function pure.
   */
  resolvedQuantities?: ReadonlyMap<string, number>,
): AssemblyResolution {
  if (!Number.isFinite(measurementQuantity) || measurementQuantity < 0) {
    throw new Error(`resolveAssembly: invalid measurementQuantity ${measurementQuantity}`)
  }

  const byKind: Record<AssemblyKind, number> = {
    material: 0,
    labor: 0,
    sub: 0,
    freight: 0,
  }
  const lines: AssemblyResolutionLine[] = []
  let total = 0

  const sorted = [...components].sort((a, b) => a.sort_order - b.sort_order)
  for (const c of sorted) {
    if (c.assembly_id !== assembly.id) continue
    // A caller-supplied resolved per-unit quantity (from a formula) wins over
    // the static one; waste_pct still applies on top either way.
    const perUnit = resolvedQuantities?.has(c.id) ? resolvedQuantities.get(c.id)! : c.quantity_per_unit
    const qty = round4(measurementQuantity * perUnit * (1 + c.waste_pct / 100))
    const amount = round4(qty * c.unit_cost)
    byKind[c.kind] = round4(byKind[c.kind] + amount)
    total = round4(total + amount)
    lines.push({
      component_id: c.id,
      kind: c.kind,
      name: c.name,
      unit: c.unit,
      quantity: qty,
      unit_cost: c.unit_cost,
      amount,
    })
  }

  return {
    assembly_id: assembly.id,
    service_item_code: assembly.service_item_code,
    total,
    by_kind: byKind,
    lines,
  }
}

/**
 * Pick the most recent active assembly for a service-item code. Routes
 * use this when an estimator-facing UI lists the assembly options for a
 * scope item; if more than one exists, the highest `version` wins so a
 * deprecated assembly never silently outranks the canonical one.
 */
export function selectActiveAssembly<T extends AssemblyHeader & { version: number; deleted_at: string | null }>(
  serviceItemCode: string,
  assemblies: readonly T[],
): T | null {
  const active = assemblies
    .filter((a) => a.service_item_code === serviceItemCode && a.deleted_at === null)
    .sort((a, b) => b.version - a.version)
  return active[0] ?? null
}

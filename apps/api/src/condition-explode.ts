/**
 * Condition explosion — make a takeoff measurement's `condition_id` LOAD-BEARING
 * in the estimate derivation (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md H1, result
 * emission).
 *
 * Today a measurement with no assembly flat-lines to exactly ONE estimate line
 * (service_item_code + resolved rate → 1 row). A Condition (`takeoff_conditions`)
 * fixes the measurement's typed kind + drivers and carries result-emission flags
 * — `emit_area` / `emit_linear` / `emit_volume`. When set, one drawn shape should
 * yield SEVERAL typed quantities (a wall trace → wall AREA sqft + perimeter LF +
 * volume cuft), not a single ignored line.
 *
 * This module owns the PURE math of that fan-out. Given a measurement, its
 * Condition, and the real-world DRIVERS already derived from the geometry
 * (`deriveMeasurementDrivers`), it emits one {@link EstimateLineIntent} per
 * enabled emit flag, each with the correct typed quantity + unit + a stable
 * provenance tag (condition_id + the emit kind). No I/O — the caller
 * (estimate.ts `createEstimateFromMeasurements`) resolves the per-line rate and
 * persists the rows, exactly like the flat path it replaces.
 *
 * SAFE + ADDITIVE: a Condition with NO emit flags falls back to a single line
 * (identical to the flat path). The flat path (no condition) and the assembly
 * path are untouched by this module.
 */

import {
  calculatePolygonAreaScaled,
  normalizeGeometry,
  slopeFactor,
  type MeasurementDrivers,
  type TakeoffGeometry,
} from '@sitelayer/domain'
import type { LedgerExecutor } from './mutation-tx.js'

/** The emit kind a condition line was derived from — stable provenance. */
export type ConditionEmitKind = 'area' | 'linear' | 'volume'

/** The Condition fields this module reads. Mirrors `takeoff_conditions`. */
export interface ConditionLike {
  id: string
  measurement_kind: string
  /** Wall height (ft) — a volume driver when no thickness is set. numeric|string|null from pg. */
  height_value: string | number | null
  /** Slab/wall thickness (ft) — the preferred volume driver. numeric|string|null from pg. */
  thickness_value: string | number | null
  emit_linear: boolean
  emit_area: boolean
  emit_volume: boolean
}

/** The measurement fields this module reads. Mirrors `takeoff_measurements`. */
export interface ConditionMeasurementLike {
  service_item_code: string
  /** The primary derived quantity for the measurement's geometry kind (area sqft / run LF / volume cuft). */
  quantity: string | number
  unit: string
  is_deduction: boolean
  /** Raw JSONB geometry; used to recover the true polygon AREA for the volume base. */
  geometry: unknown
}

/**
 * One typed line a condition emits, BEFORE pricing. The caller resolves the
 * rate (same chain the flat path uses) and appends the row. `quantity` is
 * already SIGNED by `is_deduction` so deductions net out everywhere downstream,
 * matching the flat + assembly paths.
 */
export interface EstimateLineIntent {
  service_item_code: string
  /** Signed by is_deduction (negative for a deduction). */
  quantity: number
  unit: string
  /** Stable provenance: the Condition this line was derived from. */
  condition_id: string
  /** Stable provenance: which emit flag produced this line. */
  emit_kind: ConditionEmitKind
}

const UNIT_BY_EMIT: Record<ConditionEmitKind, string> = {
  area: 'sqft',
  linear: 'lf',
  volume: 'cuft',
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Coerce a pg numeric|string|null driver into a finite non-negative number, or null. */
function numericOrNull(raw: string | number | null): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function positiveOr1(value: number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * The true scaled polygon AREA (sqft) the area + volume lines are derived from.
 *
 * A polygon yields its scaled shoelace area (same math `calculateGeometryQuantity`
 * uses, including pitch); a volume yields length × width. For any other geometry
 * we fall back to the measurement's own stored quantity ONLY when its unit reads
 * as an area (sqft / "area"), else there is no reliable area base (0).
 */
function resolveAreaBase(measurement: ConditionMeasurementLike, geometry: TakeoffGeometry | null): number {
  if (geometry?.kind === 'polygon') {
    const wx = positiveOr1(geometry.world_per_board_x ?? geometry.sheet_scale)
    const wy = positiveOr1(geometry.world_per_board_y ?? geometry.sheet_scale)
    return round2(calculatePolygonAreaScaled(geometry.points, wx, wy, slopeFactor(geometry.pitch)))
  }
  if (geometry?.kind === 'volume') {
    return round2(geometry.length * geometry.width)
  }
  const q = Number(measurement.quantity)
  if (measurement.unit && /sq|area/i.test(measurement.unit) && Number.isFinite(q)) return Math.abs(q)
  return 0
}

/**
 * Explode one condition-tagged measurement into typed estimate-line intents —
 * one per enabled emit flag. Pure.
 *
 *   - emit_area   → AREA quantity (sqft). Source: the polygon's scaled shoelace
 *                   area / a volume's footprint / an area measurement's stored
 *                   quantity, else 0.
 *   - emit_linear → LENGTH quantity (lf). Source: the perimeter driver (a
 *                   polygon's scaled perimeter, a lineal's run length).
 *   - emit_volume → VOLUME quantity (cuft) = area × depth, where depth is the
 *                   condition's thickness_value, else its height_value, else the
 *                   `thickness` driver. Emitted only when a positive depth exists.
 *
 * Each emitted quantity is SIGNED by `is_deduction`. When the condition has NO
 * emit flag set (or no emitted line survives — e.g. emit_volume with no depth
 * and nothing else enabled), a SINGLE fallback line is returned using the
 * measurement's own quantity + unit, identical to the flat path. So the caller
 * always gets at least one line and the no-flags condition stays neutral.
 */
export function explodeConditionMeasurement(
  measurement: ConditionMeasurementLike,
  condition: ConditionLike,
  drivers: MeasurementDrivers | undefined,
): EstimateLineIntent[] {
  const sign = measurement.is_deduction ? -1 : 1
  const code = measurement.service_item_code
  const geometry = normalizeGeometry(measurement.geometry)

  const intents: EstimateLineIntent[] = []

  if (condition.emit_area) {
    const area = resolveAreaBase(measurement, geometry)
    intents.push({
      service_item_code: code,
      quantity: sign * round2(area),
      unit: UNIT_BY_EMIT.area,
      condition_id: condition.id,
      emit_kind: 'area',
    })
  }

  if (condition.emit_linear) {
    // The perimeter driver is the scaled polygon perimeter (closed loop) or the
    // lineal run length — exactly the LF an estimator wants from a wall trace.
    const length = drivers?.perimeter ?? 0
    intents.push({
      service_item_code: code,
      quantity: sign * round2(length),
      unit: UNIT_BY_EMIT.linear,
      condition_id: condition.id,
      emit_kind: 'linear',
    })
  }

  if (condition.emit_volume) {
    // Depth precedence: explicit thickness > wall height > derived thickness driver.
    const depth =
      numericOrNull(condition.thickness_value) ?? numericOrNull(condition.height_value) ?? drivers?.thickness ?? null
    if (depth !== null && depth > 0) {
      const area = resolveAreaBase(measurement, geometry)
      intents.push({
        service_item_code: code,
        quantity: sign * round2(area * depth),
        unit: UNIT_BY_EMIT.volume,
        condition_id: condition.id,
        emit_kind: 'volume',
      })
    }
  }

  if (intents.length === 0) {
    // No emit flag fired (or volume had no depth): behave exactly like the flat
    // path — one line at the measurement's own quantity + unit. Still tagged
    // with the condition for provenance; emit_kind reflects the condition's own
    // measurement_kind so the fallback line is still typed.
    const q = Number(measurement.quantity)
    intents.push({
      service_item_code: code,
      quantity: sign * (Number.isFinite(q) ? q : 0),
      unit: measurement.unit,
      condition_id: condition.id,
      emit_kind: emitKindForMeasurementKind(condition.measurement_kind),
    })
  }

  return intents
}

/** Map a condition's measurement_kind onto the fallback line's emit_kind. */
function emitKindForMeasurementKind(kind: string): ConditionEmitKind {
  if (kind === 'linear') return 'linear'
  if (kind === 'volume') return 'volume'
  return 'area'
}

/**
 * Whether a Condition has ANY result-emission flag set. A condition with no
 * emit flag is neutral — the caller keeps the legacy single flat line for that
 * measurement rather than routing it through the fan-out (which would also
 * collapse to one line anyway). Pure.
 */
export function conditionHasEmitFlags(condition: ConditionLike): boolean {
  return condition.emit_area || condition.emit_linear || condition.emit_volume
}

/**
 * Hydrate the distinct, live conditions referenced by a set of measurement rows.
 * Returns a Map keyed by condition id. Soft-deleted conditions (and any whose
 * row is gone) are simply absent — the caller falls back to the flat-line path
 * for those measurements (the safe default), exactly like the assembly loader.
 *
 * I/O glue (not pure) — kept here next to {@link explodeConditionMeasurement}
 * the way `loadAssembliesByMeasurement` sits beside `explodeMeasurement`. The
 * unit tests import only the pure function above, so no DB is required to test
 * the fan-out math.
 */
export async function loadConditionsByMeasurement(
  executor: LedgerExecutor,
  companyId: string,
  measurementRows: ReadonlyArray<{ condition_id?: string | null }>,
): Promise<Map<string, ConditionLike>> {
  const conditionIds = Array.from(
    new Set(measurementRows.map((m) => m.condition_id ?? null).filter((id): id is string => Boolean(id))),
  )
  const byId = new Map<string, ConditionLike>()
  if (conditionIds.length === 0) return byId

  const result = await executor.query<{
    id: string
    measurement_kind: string
    height_value: string | number | null
    thickness_value: string | number | null
    emit_linear: boolean
    emit_area: boolean
    emit_volume: boolean
  }>(
    `select id, measurement_kind, height_value, thickness_value, emit_linear, emit_area, emit_volume
       from takeoff_conditions
      where company_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [companyId, conditionIds],
  )
  for (const row of result.rows) {
    byId.set(row.id, {
      id: row.id,
      measurement_kind: row.measurement_kind,
      height_value: row.height_value,
      thickness_value: row.thickness_value,
      emit_linear: row.emit_linear,
      emit_area: row.emit_area,
      emit_volume: row.emit_volume,
    })
  }
  return byId
}

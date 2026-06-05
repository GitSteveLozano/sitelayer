/**
 * Takeoff geometry — pure board-space + scaled measurement math.
 *
 * Split out of `index.ts` (Blocker 2 in docs/PROJECT_DECOMPOSITION_PLAN.md
 * §3.5 / docs/TAKEOFF_DEEP_DIVE_2026-06-01.md H2). The barrel (`index.ts`)
 * re-exports everything here, so the public `@sitelayer/domain` surface is
 * unchanged and no import site moves. This file isolates the takeoff-quantities
 * seam: shoelace area, polyline length, the per-axis world-scale resolver, the
 * geometry normalizers, and the pitch/slope factor.
 *
 * Pitch (H2): all plan-view math is a flat footprint. A sloped surface
 * (gable, mansard, sloped soffit, roof-adjacent cladding) covers MORE real
 * area than its footprint. The slope factor `√(rise² + run²) / run` is the
 * secant of the roof angle — 6:12 = √(36+144)/12 = √180/12 ≈ 1.118 — and
 * multiplies the SCALED area + lineal length so a 1500 SF footprint reads
 * ~1677 SF actual. A flat/vertical run (no pitch) is 1.0 and unchanged.
 */

export interface TakeoffPoint {
  x: number
  y: number
}

/**
 * Optional roof/slope driver stored inside the JSONB geometry (no migration —
 * additive field). `rise:run` is the standard construction pitch notation
 * (6:12 = "six in twelve"). Applying `slopeFactor` converts a plan-view
 * footprint into true sloped surface area / length. Absent ⇒ flat/vertical ⇒
 * factor 1.0 (legacy behavior preserved).
 */
export interface PitchDriver {
  rise: number
  run: number
}

/**
 * Real-world DRIVER scalars derived from (or explicitly attached to) a
 * measurement so an assembly component's `quantity_formula` / `include_when`
 * can reference them — the parent→child propagation PlanSwift exposes as
 * `[..\Height]`, `[..\Width]`, etc. (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3
 * M2). Every field is optional; an absent driver is bound to `0` in the
 * formula context so a referencing formula stays defined rather than erroring
 * on an undefined variable.
 *
 * These come from the drawn geometry: a polygon yields its scaled bounding-box
 * width/height, scaled perimeter, and vertex count (`sides`); a lineal yields
 * its scaled run length as `perimeter`/`width` and its segment count; a volume
 * yields its stored width/height/length. A measurement (or a Condition) may also
 * carry an explicit `drivers` override which, when present, wins per-field.
 */
export interface MeasurementDrivers {
  height?: number
  width?: number
  thickness?: number
  perimeter?: number
  sides?: number
}

export interface PolygonGeometry {
  kind: 'polygon'
  points: TakeoffPoint[]
  sheet_scale?: number | null
  calibration_length?: number | null
  calibration_unit?: string | null
  /**
   * Real-world distance per board-space unit, PER AXIS. The drawing surface is
   * a 0–100 board space stretched to the page's aspect ratio (anisotropic), so
   * x and y board units cover different real distances. Storing both lets the
   * quantity math produce true sqft/lf: area = boardArea·wx·wy, length =
   * Σ hypot(Δx·wx, Δy·wy). Absent = uncalibrated → board-space quantity (legacy).
   */
  world_per_board_x?: number | null
  world_per_board_y?: number | null
  /**
   * Optional pitch driver (rise:run). When present, the SCALED area is
   * multiplied by `slopeFactor` so a sloped plane reads its true surface area.
   * Absent ⇒ flat ⇒ factor 1.0. Stored inside this JSONB geometry — no column.
   */
  pitch?: PitchDriver | null
  /**
   * Optional explicit driver overrides (e.g. a typed wall height, or values a
   * Condition stamps on the measurement). When present, each field wins over
   * the value `deriveMeasurementDrivers` would compute from the geometry.
   */
  drivers?: MeasurementDrivers | null
}

export interface LinealGeometry {
  kind: 'lineal'
  points: TakeoffPoint[]
  sheet_scale?: number | null
  calibration_length?: number | null
  calibration_unit?: string | null
  /** See PolygonGeometry.world_per_board_x — per-axis real-world scale. */
  world_per_board_x?: number | null
  world_per_board_y?: number | null
  /** See PolygonGeometry.pitch — sloped-run length multiplier. */
  pitch?: PitchDriver | null
  /** See PolygonGeometry.drivers — explicit per-field driver overrides. */
  drivers?: MeasurementDrivers | null
}

export interface VolumeGeometry {
  kind: 'volume'
  length: number
  width: number
  height: number
  unit?: string | null
  /** See PolygonGeometry.drivers — explicit per-field driver overrides. */
  drivers?: MeasurementDrivers | null
}

export type TakeoffGeometry = PolygonGeometry | LinealGeometry | VolumeGeometry

export function roundMeasurement(value: number): number {
  return Math.round(value * 100) / 100
}

export function clampBoardCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Roof/slope secant from a rise:run pitch — `√(rise² + run²) / run`. The
 * length of the sloped hypotenuse per unit of horizontal run, which is exactly
 * how much MORE surface a sloped plane covers vs its plan-view footprint.
 * 6:12 ≈ 1.118; 12:12 ≈ 1.414. A flat run (rise 0) or a missing/invalid pitch
 * returns 1.0 so uncalibrated/flat takeoff is unchanged.
 */
export function slopeFactor(pitch?: PitchDriver | null): number {
  if (!pitch) return 1
  const rise = Number(pitch.rise)
  const run = Number(pitch.run)
  if (!Number.isFinite(rise) || !Number.isFinite(run)) return 1
  if (run <= 0) return 1
  if (rise < 0) return 1
  const factor = Math.sqrt(rise * rise + run * run) / run
  return Number.isFinite(factor) && factor >= 1 ? factor : 1
}

export function calculatePolygonArea(points: readonly TakeoffPoint[]): number {
  if (points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum / 2)
}

export function calculatePolygonCentroid(points: readonly TakeoffPoint[]): TakeoffPoint | null {
  if (points.length < 3) return null
  let areaFactor = 0
  let cx = 0
  let cy = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    const cross = current.x * next.y - next.x * current.y
    areaFactor += cross
    cx += (current.x + next.x) * cross
    cy += (current.y + next.y) * cross
  }
  const area = areaFactor / 2
  if (area === 0) return null
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

export function calculateTakeoffQuantity(points: readonly TakeoffPoint[], multiplier = 1): number {
  const resolvedMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return roundMeasurement(calculatePolygonArea(points) * resolvedMultiplier)
}

export function normalizePolygonGeometry(input: unknown): PolygonGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'polygon') return null
  if (!Array.isArray(input.points)) return null

  const points = input.points.map(normalizeBoardPoint)
  if (points.some((point) => point === null)) return null
  const normalizedPoints = points.filter((point): point is TakeoffPoint => point !== null)
  if (normalizedPoints.length < 3) return null

  const geometry: PolygonGeometry = {
    kind: 'polygon',
    points: normalizedPoints,
  }
  const sheetScale = positiveNumberOrNull(input.sheet_scale)
  const calibrationLength = positiveNumberOrNull(input.calibration_length)
  const calibrationUnit = typeof input.calibration_unit === 'string' ? input.calibration_unit.trim() : ''

  if (sheetScale !== null) geometry.sheet_scale = sheetScale
  if (calibrationLength !== null) geometry.calibration_length = calibrationLength
  if (calibrationUnit) geometry.calibration_unit = calibrationUnit.slice(0, 32)

  const worldX = positiveNumberOrNull(input.world_per_board_x)
  const worldY = positiveNumberOrNull(input.world_per_board_y)
  if (worldX !== null) geometry.world_per_board_x = worldX
  if (worldY !== null) geometry.world_per_board_y = worldY

  const pitch = normalizePitch(input.pitch)
  if (pitch !== null) geometry.pitch = pitch

  const drivers = normalizeDrivers(input.drivers)
  if (drivers) geometry.drivers = drivers

  return geometry
}

function normalizeBoardPoint(input: unknown): TakeoffPoint | null {
  if (!isRecord(input)) return null
  const x = Number(input.x)
  const y = Number(input.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 100 || y < 0 || y > 100) return null
  return { x: roundMeasurement(x), y: roundMeasurement(y) }
}

function positiveNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Validate an untrusted pitch driver from the JSONB body. Requires a positive
 * finite run and a non-negative finite rise; anything else (missing, garbage,
 * run ≤ 0) ⇒ null ⇒ flat (factor 1.0). Values are rounded so the stored
 * geometry stays compact and round-trips cleanly.
 */
function normalizePitch(input: unknown): PitchDriver | null {
  if (!isRecord(input)) return null
  const rise = Number(input.rise)
  const run = Number(input.run)
  if (!Number.isFinite(rise) || !Number.isFinite(run)) return null
  if (rise < 0 || run <= 0) return null
  return { rise: roundMeasurement(rise), run: roundMeasurement(run) }
}

/**
 * Coerce a raw `drivers` blob into a clean {@link MeasurementDrivers}. Only the
 * five known fields are kept, each only when it parses to a finite, non-negative
 * number (negative drivers are meaningless geometry). Returns `null` when no
 * usable field survives so callers can omit the key entirely.
 */
function normalizeDrivers(input: unknown): MeasurementDrivers | null {
  if (!isRecord(input)) return null
  const out: MeasurementDrivers = {}
  const keys: (keyof MeasurementDrivers)[] = ['height', 'width', 'thickness', 'perimeter', 'sides']
  for (const key of keys) {
    const parsed = Number(input[key])
    if (Number.isFinite(parsed) && parsed >= 0) out[key] = roundMeasurement(parsed)
  }
  return Object.keys(out).length > 0 ? out : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeLinealGeometry(input: unknown): LinealGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'lineal') return null
  if (!Array.isArray(input.points)) return null

  const points = input.points.map(normalizeBoardPoint)
  if (points.some((point) => point === null)) return null
  const normalizedPoints = points.filter((point): point is TakeoffPoint => point !== null)
  if (normalizedPoints.length < 2) return null

  const geometry: LinealGeometry = {
    kind: 'lineal',
    points: normalizedPoints,
  }
  const sheetScale = positiveNumberOrNull(input.sheet_scale)
  const calibrationLength = positiveNumberOrNull(input.calibration_length)
  const calibrationUnit = typeof input.calibration_unit === 'string' ? input.calibration_unit.trim() : ''

  if (sheetScale !== null) geometry.sheet_scale = sheetScale
  if (calibrationLength !== null) geometry.calibration_length = calibrationLength
  if (calibrationUnit) geometry.calibration_unit = calibrationUnit.slice(0, 32)

  const worldX = positiveNumberOrNull(input.world_per_board_x)
  const worldY = positiveNumberOrNull(input.world_per_board_y)
  if (worldX !== null) geometry.world_per_board_x = worldX
  if (worldY !== null) geometry.world_per_board_y = worldY

  const pitch = normalizePitch(input.pitch)
  if (pitch !== null) geometry.pitch = pitch

  const drivers = normalizeDrivers(input.drivers)
  if (drivers) geometry.drivers = drivers

  return geometry
}

export function normalizeVolumeGeometry(input: unknown): VolumeGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind !== 'volume') return null

  const length = Number(input.length)
  const width = Number(input.width)
  const height = Number(input.height)
  if (!Number.isFinite(length) || length <= 0) return null
  if (!Number.isFinite(width) || width <= 0) return null
  if (!Number.isFinite(height) || height <= 0) return null

  const geometry: VolumeGeometry = {
    kind: 'volume',
    length: roundMeasurement(length),
    width: roundMeasurement(width),
    height: roundMeasurement(height),
  }
  const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
  if (unit) geometry.unit = unit.slice(0, 32)

  const drivers = normalizeDrivers(input.drivers)
  if (drivers) geometry.drivers = drivers

  return geometry
}

export function normalizeGeometry(input: unknown): TakeoffGeometry | null {
  if (!isRecord(input)) return null
  if (input.kind === 'polygon') return normalizePolygonGeometry(input)
  if (input.kind === 'lineal') return normalizeLinealGeometry(input)
  if (input.kind === 'volume') return normalizeVolumeGeometry(input)
  return null
}

export function calculateLinealLength(points: readonly TakeoffPoint[]): number {
  if (points.length < 2) return 0
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    const dx = next.x - current.x
    const dy = next.y - current.y
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

export function calculateLinealQuantity(points: readonly TakeoffPoint[], multiplier = 1): number {
  const resolvedMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return roundMeasurement(calculateLinealLength(points) * resolvedMultiplier)
}

export function calculateVolumeQuantity(input: { length: number; width: number; height: number }): number {
  const { length, width, height } = input
  if (!Number.isFinite(length) || !Number.isFinite(width) || !Number.isFinite(height)) return 0
  if (length <= 0 || width <= 0 || height <= 0) return 0
  return roundMeasurement(length * width * height)
}

/**
 * Resolve the per-axis real-world scale from a geometry. Prefers the explicit
 * per-axis `world_per_board_x/y` (set at save time from page calibration +
 * page aspect). Falls back to a legacy isotropic `sheet_scale`, then to 1
 * (board space — what uncalibrated pages produce today).
 */
function resolveWorldScale(geometry: PolygonGeometry | LinealGeometry): { wx: number; wy: number } {
  const wx = positiveNumberOrNull(geometry.world_per_board_x)
  const wy = positiveNumberOrNull(geometry.world_per_board_y)
  if (wx !== null && wy !== null) return { wx, wy }
  const scale = positiveNumberOrNull(geometry.sheet_scale)
  if (scale !== null) return { wx: scale, wy: scale }
  return { wx: 1, wy: 1 }
}

/**
 * Polygon area under an anisotropic linear map (x·wx, y·wy), times an optional
 * `factor` (pitch slope-factor; default 1.0 = flat). The shoelace area scales
 * by exactly wx·wy under independent per-axis scaling, so we can scale the
 * board-space area directly, then apply the slope multiplier for sloped planes.
 */
export function calculatePolygonAreaScaled(
  points: readonly TakeoffPoint[],
  wx: number,
  wy: number,
  factor = 1,
): number {
  const resolvedFactor = Number.isFinite(factor) && factor > 0 ? factor : 1
  return calculatePolygonArea(points) * wx * wy * resolvedFactor
}

/**
 * Polyline length under an anisotropic linear map (x·wx, y·wy), times an
 * optional `factor` (pitch slope-factor; default 1.0 = flat/vertical run).
 */
export function calculateLinealLengthScaled(
  points: readonly TakeoffPoint[],
  wx: number,
  wy: number,
  factor = 1,
): number {
  if (points.length < 2) return 0
  const resolvedFactor = Number.isFinite(factor) && factor > 0 ? factor : 1
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    const dx = (next.x - current.x) * wx
    const dy = (next.y - current.y) * wy
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total * resolvedFactor
}

export function calculateGeometryQuantity(geometry: TakeoffGeometry): number {
  if (geometry.kind === 'polygon') {
    const { wx, wy } = resolveWorldScale(geometry)
    return roundMeasurement(calculatePolygonAreaScaled(geometry.points, wx, wy, slopeFactor(geometry.pitch)))
  }
  if (geometry.kind === 'lineal') {
    const { wx, wy } = resolveWorldScale(geometry)
    return roundMeasurement(calculateLinealLengthScaled(geometry.points, wx, wy, slopeFactor(geometry.pitch)))
  }
  return calculateVolumeQuantity(geometry)
}

/** Scaled perimeter of a closed polygon (Σ edge length, last vertex → first). */
function calculatePolygonPerimeterScaled(points: readonly TakeoffPoint[], wx: number, wy: number): number {
  if (points.length < 2) return 0
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (!current || !next) continue
    const dx = (next.x - current.x) * wx
    const dy = (next.y - current.y) * wy
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

/**
 * Derive the real-world measurement DRIVERS (height/width/thickness/perimeter/
 * sides) an assembly formula or `include_when` expression can reference, so one
 * drawn object drives plate-LF from its run, stud-count from its height, and
 * sheet-count from its area (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3 M2).
 *
 * Source of truth, per field, is:
 *   1. an explicit `geometry.drivers` override (a typed wall height, or values a
 *      Condition stamps on the measurement) — wins when finite; else
 *   2. a value computed from the drawn geometry under the per-axis world scale:
 *        - polygon  → scaled bounding-box width/height, scaled perimeter,
 *                     vertex count as `sides`. thickness has no geometric source.
 *        - lineal   → scaled run length as both `perimeter` and `width`, the
 *                     segment count as `sides`. No height/thickness source.
 *        - volume   → stored width/height as `width`/`height`, stored length as
 *                     `perimeter`, and `thickness` = the smaller of width/height
 *                     (the depth proxy).
 *
 * Every returned field is a finite, non-negative number; a field with no source
 * is simply omitted (the explode path then binds it to `0`). Pure — no I/O.
 */
export function deriveMeasurementDrivers(geometry: TakeoffGeometry): MeasurementDrivers {
  const computed: MeasurementDrivers = {}

  if (geometry.kind === 'polygon') {
    const { wx, wy } = resolveWorldScale(geometry)
    const { points } = geometry
    if (points.length > 0) {
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      computed.width = roundMeasurement((Math.max(...xs) - Math.min(...xs)) * wx)
      computed.height = roundMeasurement((Math.max(...ys) - Math.min(...ys)) * wy)
      computed.perimeter = roundMeasurement(calculatePolygonPerimeterScaled(points, wx, wy))
      computed.sides = points.length
    }
  } else if (geometry.kind === 'lineal') {
    const { wx, wy } = resolveWorldScale(geometry)
    const length = roundMeasurement(calculateLinealLengthScaled(geometry.points, wx, wy))
    computed.perimeter = length
    computed.width = length
    computed.sides = Math.max(geometry.points.length - 1, 0)
  } else {
    // volume
    computed.width = roundMeasurement(geometry.width)
    computed.height = roundMeasurement(geometry.height)
    computed.perimeter = roundMeasurement(geometry.length)
    computed.thickness = roundMeasurement(Math.min(geometry.width, geometry.height))
  }

  // Explicit per-field overrides win over the geometry-derived value.
  const override = geometry.drivers
  if (override) {
    for (const key of ['height', 'width', 'thickness', 'perimeter', 'sides'] as const) {
      const value = override[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        computed[key] = roundMeasurement(value)
      }
    }
  }

  return computed
}

// --- Polygon overlap detection (gap G8: cutout/deduction de-dup) -------------
//
// Today a deduction (cutout) just nets its quantity off the gross — two cutouts
// that overlap (e.g. a window drawn twice, or a door inside a window opening)
// double-subtract their shared area, deflating the net takeoff. These pure
// primitives detect those overlaps so the caller can warn / dedup. Board-space
// (0–100) polygons on the same page only; geometry is general-purpose.

const EPS = 1e-9

/** Ray-cast point-in-polygon. Boundary is treated as outside (good enough for
 *  the overlap test, which also checks edge crossings + the other direction). */
export function pointInPolygon(point: TakeoffPoint, polygon: readonly TakeoffPoint[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if (!a || !b) continue
    const intersects = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

function orientation(p: TakeoffPoint, q: TakeoffPoint, r: TakeoffPoint): number {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  if (Math.abs(v) < EPS) return 0
  return v > 0 ? 1 : 2
}

function onSegment(p: TakeoffPoint, q: TakeoffPoint, r: TakeoffPoint): boolean {
  return (
    q.x <= Math.max(p.x, r.x) + EPS &&
    q.x >= Math.min(p.x, r.x) - EPS &&
    q.y <= Math.max(p.y, r.y) + EPS &&
    q.y >= Math.min(p.y, r.y) - EPS
  )
}

/** Do segments p1p2 and p3p4 intersect (including collinear touching)? */
export function segmentsIntersect(p1: TakeoffPoint, p2: TakeoffPoint, p3: TakeoffPoint, p4: TakeoffPoint): boolean {
  const o1 = orientation(p1, p2, p3)
  const o2 = orientation(p1, p2, p4)
  const o3 = orientation(p3, p4, p1)
  const o4 = orientation(p3, p4, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p3, p2)) return true
  if (o2 === 0 && onSegment(p1, p4, p2)) return true
  if (o3 === 0 && onSegment(p3, p1, p4)) return true
  if (o4 === 0 && onSegment(p3, p2, p4)) return true
  return false
}

/**
 * Do two polygons share interior area? True when any edges cross, OR one
 * polygon fully contains a vertex of the other (covers containment with no edge
 * crossings). Conservative on boundary-touch — for cutout de-dup, flagging a
 * boundary-touch for review is the safe side.
 */
export function polygonsOverlap(a: readonly TakeoffPoint[], b: readonly TakeoffPoint[]): boolean {
  if (a.length < 3 || b.length < 3) return false
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    if (!a1 || !a2) continue
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j]
      const b2 = b[(j + 1) % b.length]
      if (!b1 || !b2) continue
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  // No edges cross — check full containment in either direction.
  const a0 = a[0]
  const b0 = b[0]
  if (a0 && pointInPolygon(a0, b)) return true
  if (b0 && pointInPolygon(b0, a)) return true
  return false
}

function signedArea(pts: readonly TakeoffPoint[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    if (!a || !b) continue
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function leftOf(p: TakeoffPoint, a: TakeoffPoint, b: TakeoffPoint): boolean {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -EPS
}

function lineIntersect(p1: TakeoffPoint, p2: TakeoffPoint, a: TakeoffPoint, b: TakeoffPoint): TakeoffPoint {
  const a1 = p2.y - p1.y
  const b1 = p1.x - p2.x
  const c1 = a1 * p1.x + b1 * p1.y
  const a2 = b.y - a.y
  const b2 = a.x - b.x
  const c2 = a2 * a.x + b2 * a.y
  const det = a1 * b2 - a2 * b1
  if (Math.abs(det) < EPS) return p2
  return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det }
}

/**
 * Sutherland–Hodgman: clip `subject` (any simple polygon) by `clipConvex`
 * (treated as convex; auto-normalized to CCW). Returns the clipped vertices
 * (possibly empty). Exact for a convex clip — takeoff cutouts are rectangles,
 * so this is accurate; a non-convex clip yields a conservative approximation.
 */
export function clipPolygonConvex(
  subject: readonly TakeoffPoint[],
  clipConvex: readonly TakeoffPoint[],
): TakeoffPoint[] {
  if (subject.length < 3 || clipConvex.length < 3) return []
  const clip = signedArea(clipConvex) < 0 ? [...clipConvex].reverse() : [...clipConvex]
  let output: TakeoffPoint[] = [...subject]
  for (let i = 0; i < clip.length; i += 1) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    if (!a || !b) continue
    const input = output
    output = []
    for (let j = 0; j < input.length; j += 1) {
      const cur = input[j]
      const prev = input[(j + input.length - 1) % input.length]
      if (!cur || !prev) continue
      const curIn = leftOf(cur, a, b)
      const prevIn = leftOf(prev, a, b)
      if (curIn) {
        if (!prevIn) output.push(lineIntersect(prev, cur, a, b))
        output.push(cur)
      } else if (prevIn) {
        output.push(lineIntersect(prev, cur, a, b))
      }
    }
    if (output.length === 0) break
  }
  return output
}

/** Board-space area of the intersection a ∩ b. Treats `b` as the convex clip;
 *  exact for convex b (rectangular cutouts), conservative otherwise. */
export function polygonIntersectionArea(a: readonly TakeoffPoint[], b: readonly TakeoffPoint[]): number {
  const clipped = clipPolygonConvex(a, b)
  return clipped.length < 3 ? 0 : calculatePolygonArea(clipped)
}

export interface OverlapCandidate {
  id: string
  pageId?: string | null
  isDeduction: boolean
  geometry: unknown
}
export interface OverlapPair {
  a: string
  b: string
  pageId: string | null
  /** Board-space area the two cutouts share (the double-subtracted amount). */
  overlapArea: number
}

/**
 * Find overlapping DEDUCTION (cutout) polygons among a measurement set (gap G8:
 * "overlaps not deduplicated"). Only polygon deductions ON THE SAME PAGE are
 * compared — different pages are different board spaces. Returns the id pairs
 * that overlap so the caller can warn or net-dedup.
 */
export function detectDeductionOverlaps(measurements: readonly OverlapCandidate[]): OverlapPair[] {
  const cutouts: Array<{ id: string; pageId: string | null; points: TakeoffPoint[] }> = []
  for (const m of measurements) {
    if (!m.isDeduction) continue
    const poly = normalizePolygonGeometry(m.geometry)
    if (!poly || poly.points.length < 3) continue
    cutouts.push({ id: m.id, pageId: m.pageId ?? null, points: poly.points })
  }
  const pairs: OverlapPair[] = []
  for (let i = 0; i < cutouts.length; i += 1) {
    for (let j = i + 1; j < cutouts.length; j += 1) {
      const ci = cutouts[i]
      const cj = cutouts[j]
      if (!ci || !cj || ci.pageId !== cj.pageId) continue
      if (polygonsOverlap(ci.points, cj.points)) {
        pairs.push({
          a: ci.id,
          b: cj.id,
          pageId: ci.pageId,
          overlapArea: roundMeasurement(polygonIntersectionArea(ci.points, cj.points)),
        })
      }
    }
  }
  return pairs
}

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
}

export interface VolumeGeometry {
  kind: 'volume'
  length: number
  width: number
  height: number
  unit?: string | null
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

import type { BlueprintPage, MeasurementGeometry, TakeoffMeasurement } from '@/lib/api'

export type TakeoffPreviewKind = 'polygon' | 'lineal' | 'count' | 'volume'

export interface TakeoffPreviewPoint {
  x: number
  z: number
  boardX: number
  boardY: number
}

export interface TakeoffPreviewItem {
  id: string
  kind: TakeoffPreviewKind
  serviceItemCode: string
  quantity: number
  unit: string
  elevation: string | null
  color: string
  points: TakeoffPreviewPoint[]
  heightFt: number
  widthFt?: number
  depthFt?: number
  notes: string | null
}

export interface TakeoffPreviewScene {
  items: TakeoffPreviewItem[]
  warnings: string[]
  hasCalibration: boolean
  worldPerBoardUnit: number
  unitLabel: 'ft' | 'board'
  bounds: {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
  }
  skippedCount: number
}

export interface BuildTakeoffPreviewSceneOptions {
  activeBlueprintId?: string | null
  activePage?: BlueprintPage | null
  defaultWallHeightFt?: number
}

const DEFAULT_WORLD_PER_BOARD_UNIT = 1
const DEFAULT_WALL_HEIGHT_FT = 9
const POLYGON_VISUAL_THICKNESS_FT = 0.08
const PALETTE = ['#d9904a', '#4f9f89', '#6d7ed7', '#c75f75', '#8e735b', '#4b9ed6', '#9b7bd8', '#7d9253'] as const
// Captured geometry (blueprint-vision/drone/etc.) arrives in source-specific
// coordinates (image pixels, lat/lon, …) with no shared board-space scale, so
// we normalize the whole capture set to roughly this many feet across.
const CAPTURE_TARGET_SPAN_FT = 60

export function buildTakeoffPreviewScene(
  measurements: TakeoffMeasurement[],
  options: BuildTakeoffPreviewSceneOptions = {},
): TakeoffPreviewScene {
  const warnings = new Set<string>()
  const calibration = readPageCalibration(options.activePage)
  const hasCalibration = calibration != null
  const worldPerBoardUnit = calibration ?? DEFAULT_WORLD_PER_BOARD_UNIT
  const defaultWallHeightFt = options.defaultWallHeightFt ?? DEFAULT_WALL_HEIGHT_FT
  const activeBlueprintId = options.activeBlueprintId ?? null

  if (!hasCalibration) {
    warnings.add('No page calibration found. The 3D preview is using board-space scale, not feet.')
  }

  const items: TakeoffPreviewItem[] = []
  let skippedCount = 0
  let legacyPageOneCount = 0

  for (const [index, measurement] of measurements.entries()) {
    // Captured geometry isn't tied to a board-space sheet; it's handled in
    // the dedicated capture phase below (and bypasses the blueprint/page
    // filters since it carries no blueprint_document_id / page_id).
    if (isCaptureGeometry(measurement.geometry)) continue
    if (activeBlueprintId && measurement.blueprint_document_id !== activeBlueprintId) continue
    if (options.activePage && !measurementBelongsToPage(measurement, options.activePage)) continue
    if (options.activePage && measurement.page_id == null && options.activePage.page_number === 1) {
      legacyPageOneCount += 1
    }
    const geometry = readGeometry(measurement.geometry)
    if (!geometry) {
      skippedCount += 1
      continue
    }

    const base = buildBase(measurement)

    if (geometry.kind === 'polygon') {
      const points = pointsToWorld(geometry.points, worldPerBoardUnit)
      if (points.length < 3) {
        skippedCount += 1
        continue
      }
      items.push({
        ...base,
        kind: 'polygon',
        points,
        heightFt: POLYGON_VISUAL_THICKNESS_FT,
      })
      continue
    }

    if (geometry.kind === 'lineal') {
      const points = pointsToWorld(geometry.points, worldPerBoardUnit)
      if (points.length < 2) {
        skippedCount += 1
        continue
      }
      items.push({
        ...base,
        kind: 'lineal',
        points,
        heightFt: defaultWallHeightFt,
      })
      continue
    }

    if (geometry.kind === 'count') {
      const points = pointsToWorld(geometry.points, worldPerBoardUnit)
      if (points.length === 0) {
        skippedCount += 1
        continue
      }
      items.push({
        ...base,
        kind: 'count',
        points,
        heightFt: countVisualHeight(base.serviceItemCode, defaultWallHeightFt),
      })
      continue
    }

    if (geometry.kind === 'volume') {
      const length = finitePositive(geometry.length)
      const width = finitePositive(geometry.width)
      const height = finitePositive(geometry.height)
      if (length == null || width == null || height == null) {
        skippedCount += 1
        continue
      }
      warnings.add('Volume rows do not have board placement, so they are shown as dimension boxes near the origin.')
      const column = index % 4
      const row = Math.floor(index / 4)
      items.push({
        ...base,
        kind: 'volume',
        points: [
          {
            x: (column - 1.5) * Math.max(6, length),
            z: 18 + row * Math.max(6, width),
            boardX: 50,
            boardY: 50,
          },
        ],
        heightFt: height,
        widthFt: width,
        depthFt: length,
      })
    }
  }

  // Capture phase: render promoted capture-pipeline polygons (blueprint
  // vision, drone, …). They carry no board calibration, so we normalize the
  // whole set by its shared bounds — the SHAPE and relative placement are
  // correct; absolute scale is not, hence the warning.
  const captureEntries: Array<{ measurement: TakeoffMeasurement; points: Array<[number, number]> }> = []
  for (const measurement of measurements) {
    const polygon = readCapturePolygon(measurement.geometry)
    if (polygon) captureEntries.push({ measurement, points: polygon })
  }
  const captureTransform = computeCaptureTransform(captureEntries)
  if (captureTransform) {
    for (const entry of captureEntries) {
      const points: TakeoffPreviewPoint[] = entry.points.map(([x, y]) => ({
        x: (x - captureTransform.centerX) * captureTransform.scale,
        z: (y - captureTransform.centerY) * captureTransform.scale,
        boardX: x,
        boardY: y,
      }))
      items.push({ ...buildBase(entry.measurement), kind: 'polygon', points, heightFt: POLYGON_VISUAL_THICKNESS_FT })
    }
    warnings.add(
      'Captured geometry is shown at normalized (relative) scale — absolute per-source calibration is not yet wired.',
    )
  }

  if (skippedCount > 0) {
    warnings.add(`${skippedCount} measurement${skippedCount === 1 ? '' : 's'} had unsupported or incomplete geometry.`)
  }
  if (legacyPageOneCount > 0) {
    warnings.add(
      `${legacyPageOneCount} legacy measurement${legacyPageOneCount === 1 ? '' : 's'} had no page_id and were shown on page 1 by convention.`,
    )
  }
  if (items.length === 0) {
    warnings.add('No drawable measurements found for this blueprint and draft.')
  }

  return {
    items,
    warnings: Array.from(warnings),
    hasCalibration,
    worldPerBoardUnit,
    unitLabel: hasCalibration ? 'ft' : 'board',
    bounds: computeBounds(items),
    skippedCount,
  }
}

function buildBase(measurement: TakeoffMeasurement) {
  const quantity = Number(measurement.quantity)
  return {
    id: measurement.id,
    serviceItemCode: measurement.service_item_code,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unit: measurement.unit,
    elevation: measurement.elevation,
    color: colorForKey(measurement.service_item_code),
    notes: measurement.notes,
  }
}

function isCaptureGeometry(raw: TakeoffMeasurement['geometry']): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'capture')
}

/**
 * Read a promoted capture measurement's polygon (`{ kind: 'capture', polygon:
 * number[][] }`, written by takeoff-drafts promote). Returns `[x, y]` pairs in
 * the source's own coordinate space (image pixels, lat/lon, …) or null.
 */
function readCapturePolygon(raw: TakeoffMeasurement['geometry']): Array<[number, number]> | null {
  if (!isCaptureGeometry(raw)) return null
  const polygon = (raw as { polygon?: unknown }).polygon
  if (!Array.isArray(polygon)) return null
  const points: Array<[number, number]> = []
  for (const point of polygon) {
    if (!Array.isArray(point) || point.length < 2) continue
    const x = finiteNumber(point[0])
    const y = finiteNumber(point[1])
    if (x != null && y != null) points.push([x, y])
  }
  return points.length >= 3 ? points : null
}

/**
 * Shared bounds → world transform for the whole capture set, so multiple
 * captured surfaces keep their relative size/position. Scales the largest
 * dimension to CAPTURE_TARGET_SPAN_FT and centers at the origin.
 */
function computeCaptureTransform(
  entries: Array<{ points: Array<[number, number]> }>,
): { centerX: number; centerY: number; scale: number } | null {
  if (entries.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const entry of entries) {
    for (const [x, y] of entry.points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  const span = Math.max(maxX - minX, maxY - minY)
  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    scale: span > 0 ? CAPTURE_TARGET_SPAN_FT / span : 1,
  }
}

function measurementBelongsToPage(measurement: TakeoffMeasurement, page: BlueprintPage): boolean {
  if (measurement.page_id) return measurement.page_id === page.id
  return page.page_number === 1
}

function readPageCalibration(page: BlueprintPage | null | undefined): number | null {
  if (!page) return null
  const distance = finitePositive(page.calibration_world_distance)
  const x1 = finiteNumber(page.calibration_x1)
  const y1 = finiteNumber(page.calibration_y1)
  const x2 = finiteNumber(page.calibration_x2)
  const y2 = finiteNumber(page.calibration_y2)
  if (distance == null || x1 == null || y1 == null || x2 == null || y2 == null) return null
  const boardDistance = Math.hypot(x2 - x1, y2 - y1)
  if (!Number.isFinite(boardDistance) || boardDistance <= 0) return null
  return distance / boardDistance
}

function readGeometry(raw: TakeoffMeasurement['geometry']): MeasurementGeometry | null {
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return null
  const geometry = raw as MeasurementGeometry
  if (!['polygon', 'lineal', 'count', 'volume'].includes(geometry.kind)) return null
  return geometry
}

function pointsToWorld(
  points: Array<{ x: number; y: number }> | undefined,
  worldPerBoardUnit: number,
): TakeoffPreviewPoint[] {
  if (!points) return []
  return points
    .map((point) => {
      const x = finiteNumber(point.x)
      const y = finiteNumber(point.y)
      if (x == null || y == null) return null
      return {
        x: (x - 50) * worldPerBoardUnit,
        z: (y - 50) * worldPerBoardUnit,
        boardX: x,
        boardY: y,
      }
    })
    .filter((point): point is TakeoffPreviewPoint => point != null)
}

function countVisualHeight(serviceItemCode: string, defaultWallHeightFt: number): number {
  if (serviceItemCode.startsWith('08 14')) return Math.max(6.5, defaultWallHeightFt * 0.72)
  if (serviceItemCode.startsWith('08 50')) return Math.max(3, defaultWallHeightFt * 0.36)
  return Math.max(0.8, defaultWallHeightFt * 0.12)
}

function finitePositive(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function colorForKey(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]
}

function computeBounds(items: TakeoffPreviewItem[]): TakeoffPreviewScene['bounds'] {
  const xs: number[] = []
  const zs: number[] = []
  for (const item of items) {
    for (const point of item.points) {
      xs.push(point.x)
      zs.push(point.z)
    }
  }
  if (xs.length === 0 || zs.length === 0) {
    return { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  }
}

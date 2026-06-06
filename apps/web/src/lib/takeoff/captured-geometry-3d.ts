// Adapter: captured draft `TakeoffGeometry` → 3D preview scene.
//
// The `buildTakeoffPreviewScene` builder (geometry-3d.ts) renders committed
// `takeoff_measurements` — manually-drawn board-space polygons plus PROMOTED
// captures (those already written back as `takeoff_measurements` with
// `geometry.kind === 'capture'`). This adapter renders captured geometry
// BEFORE promotion: it reads the `TakeoffGeometry` block stashed on a
// `takeoff_draft`'s `TakeoffResult` (rooms / surfaces / objects) and converts
// the drawable surfaces into `TakeoffPreviewItem`s so the operator can preview
// a fresh AI/photogrammetry/drone/RoomPlan capture in 3D without committing a
// single measurement. It is strictly read-only — no writes, no promote.
//
// Coordinate handling mirrors the promoted-capture path: a captured draft has
// no board-space calibration, so the whole surface set is projected to centered
// world feet by its shared bounds. Drone footprints arrive as GeoJSON [lon,lat]
// and are projected at true scale; everything else is bounds-normalized to a
// relative span (shape + relative placement are correct, absolute scale is not).

import type { CapturedGeometry } from '@/lib/api'
import {
  DEFAULT_WALL_HEIGHT_FT,
  POLYGON_VISUAL_THICKNESS_FT,
  colorForKey,
  computeBounds,
  finiteNumber,
  projectCaptureEntriesToWorld,
  type TakeoffPreviewItem,
  type TakeoffPreviewKind,
  type TakeoffPreviewScene,
} from './geometry-3d'

export interface BuildCapturedGeometrySceneOptions {
  /** Capture pipeline that produced the draft (`drone` projects GeoJSON
   *  lon/lat footprints at true scale; everything else bounds-normalizes). */
  source?: string | null
  /** Wall / facade extrusion height in feet. Defaults to {@link DEFAULT_WALL_HEIGHT_FT}. */
  defaultWallHeightFt?: number
}

// MasterFormat-ish synthetic codes so the scene list + the count-marker height
// heuristics in geometry-3d.ts (which key off `08 14` / `08 50` prefixes) stay
// meaningful for captured surfaces, which carry no service-item code yet.
const SURFACE_KIND_CODE: Record<CapturedSurfaceKind, string> = {
  floor: 'CAP·FLOOR',
  ceiling: 'CAP·CEILING',
  roof: 'CAP·ROOF',
  facade: 'CAP·FACADE',
  wall: 'CAP·WALL',
  opening: 'CAP·OPENING',
}

type CapturedSurfaceKind = NonNullable<CapturedGeometry['surfaces']>[number]['kind']

// Captured items render alongside committed measurements; namespace their ids
// so a capture surface id (e.g. `s1`) can never collide with a measurement id
// when both scenes are overlaid.
const CAPTURED_ID_PREFIX = 'cap:'

/** True when an id was produced by this adapter (so callers can tell a captured
 *  preview item apart from a committed measurement after a merge). */
export function isCapturedPreviewId(id: string): boolean {
  return id.startsWith(CAPTURED_ID_PREFIX)
}

// A surface polygon participates in the shared projection so every drawn item
// keeps the same scale + centering. Each pending item remembers the indices of
// its points inside the flat entry list so we can stitch projected coordinates
// back onto it once the whole set is centered.
interface PendingItem {
  id: string
  kind: TakeoffPreviewKind
  code: string
  label: string
  heightFt: number
  entryIndex: number
}

/**
 * Convert a captured draft's `TakeoffGeometry` into a renderable preview scene.
 *
 * Surfaces carrying a `polygon` are the drawable footprint:
 *   - floor / ceiling / roof / facade → flat `polygon` items
 *   - wall                            → a `lineal` run (rendered as a wall box)
 *   - opening                         → a `count` marker at the polygon centroid
 * `objects[]` with a bbox become `count` markers (RoomPlan fixtures, blueprint
 *  symbol instances). Rooms carry only metrics (no coordinates) and are reported
 *  in the warnings rather than fabricated as polygons.
 *
 * Returns `null` when there is nothing drawable, so the caller can fall back to
 * the manual-measurement scene unchanged.
 */
export function buildCapturedGeometryScene(
  geometry: CapturedGeometry | null | undefined,
  options: BuildCapturedGeometrySceneOptions = {},
): TakeoffPreviewScene | null {
  if (!geometry) return null
  const defaultWallHeightFt = options.defaultWallHeightFt ?? DEFAULT_WALL_HEIGHT_FT
  const warnings = new Set<string>()

  const entries: Array<{ points: Array<[number, number]> }> = []
  const pending: PendingItem[] = []
  let skipped = 0

  for (const surface of geometry.surfaces ?? []) {
    const polygon = readPolygon(surface.polygon)
    if (!polygon) {
      // A surface with no drawable boundary still counted toward the capture,
      // so report it rather than silently dropping it.
      skipped += 1
      continue
    }
    const kind = surface.kind
    if (kind === 'opening') {
      // Openings have no extruded footprint; place a single marker at the
      // polygon centroid so doors/windows read as count symbols.
      entries.push({ points: [centroid(polygon)] })
    } else {
      entries.push({ points: polygon })
    }
    pending.push({
      id: `${CAPTURED_ID_PREFIX}surface:${surface.id}`,
      kind: previewKindForSurface(kind),
      code: SURFACE_KIND_CODE[kind],
      label: kind,
      heightFt: heightForSurface(kind, defaultWallHeightFt),
      entryIndex: entries.length - 1,
    })
  }

  for (const object of geometry.objects ?? []) {
    const point = readBboxOrigin(object.bbox)
    if (!point) {
      skipped += 1
      continue
    }
    entries.push({ points: [point] })
    pending.push({
      id: `${CAPTURED_ID_PREFIX}object:${object.id}`,
      kind: 'count',
      code: 'CAP·OBJECT',
      label: object.category || 'object',
      heightFt: Math.max(0.8, defaultWallHeightFt * 0.12),
      entryIndex: entries.length - 1,
    })
  }

  if (pending.length === 0) {
    const roomCount = geometry.rooms?.length ?? 0
    if (roomCount > 0) {
      warnings.add(
        `Captured draft has ${roomCount} room${roomCount === 1 ? '' : 's'} but no drawable surface or object geometry to render.`,
      )
    }
    return null
  }

  const lonLat = isLonLatCapture(options.source, entries)
  const projected = projectCaptureEntriesToWorld(entries, null, lonLat)
  if (!projected) return null

  const items: TakeoffPreviewItem[] = pending.map((item) => ({
    id: item.id,
    kind: item.kind,
    serviceItemCode: item.code,
    quantity: 0,
    unit: 'ft',
    elevation: item.label,
    color: colorForKey(item.code),
    points: projected.worldByEntry[item.entryIndex] ?? [],
    heightFt: item.kind === 'polygon' ? POLYGON_VISUAL_THICKNESS_FT : item.heightFt,
    notes: null,
  }))

  warnings.add(
    projected.mode === 'lonlat'
      ? 'Captured draft geometry is shown at true scale from drone GPS coordinates.'
      : 'Captured draft geometry is shown at normalized (relative) scale — it has no board calibration yet.',
  )
  if (skipped > 0) {
    warnings.add(`${skipped} captured surface/object${skipped === 1 ? '' : 's'} had no drawable geometry.`)
  }
  const roomCount = geometry.rooms?.length ?? 0
  if (roomCount > 0) {
    warnings.add(`${roomCount} captured room${roomCount === 1 ? '' : 's'} contributed metrics only (no polygon).`)
  }

  return {
    items,
    warnings: Array.from(warnings),
    hasCalibration: false,
    worldPerBoardUnit: 1,
    unitLabel: projected.mode === 'lonlat' ? 'ft' : 'board',
    bounds: computeBounds(items),
    skippedCount: skipped,
  }
}

/**
 * Overlay a captured-geometry scene on top of the manual-measurement scene so
 * the 3D preview renders both. Manual items keep their calibrated coordinates;
 * captured items are appended (their ids are namespaced upstream so they never
 * collide with measurement ids). Returns `base` untouched when there is no
 * captured geometry to add.
 */
export function mergeCapturedSceneIntoBase(
  base: TakeoffPreviewScene,
  captured: TakeoffPreviewScene | null,
): TakeoffPreviewScene {
  if (!captured || captured.items.length === 0) return base
  const items = [...base.items, ...captured.items]
  return {
    ...base,
    items,
    warnings: Array.from(new Set([...base.warnings, ...captured.warnings])),
    bounds: computeBounds(items),
    skippedCount: base.skippedCount + captured.skippedCount,
  }
}

function previewKindForSurface(kind: CapturedSurfaceKind): TakeoffPreviewKind {
  if (kind === 'wall') return 'lineal'
  if (kind === 'opening') return 'count'
  return 'polygon'
}

function heightForSurface(kind: CapturedSurfaceKind, defaultWallHeightFt: number): number {
  if (kind === 'wall' || kind === 'facade') return defaultWallHeightFt
  return POLYGON_VISUAL_THICKNESS_FT
}

/** Parse a surface `polygon` (array of `[x, y]` pairs, source-space coords)
 *  into finite `[x, y]` tuples. Returns null when fewer than 2 valid points
 *  remain (nothing drawable). */
function readPolygon(polygon: number[][] | undefined): Array<[number, number]> | null {
  if (!Array.isArray(polygon)) return null
  const points: Array<[number, number]> = []
  for (const point of polygon) {
    if (!Array.isArray(point) || point.length < 2) continue
    const x = finiteNumber(point[0])
    const y = finiteNumber(point[1])
    if (x != null && y != null) points.push([x, y])
  }
  return points.length >= 2 ? points : null
}

/** Origin (`[x, y]`) of an object bbox (`[x, y, ...]`), or null if not finite. */
function readBboxOrigin(bbox: number[] | undefined): [number, number] | null {
  if (!Array.isArray(bbox) || bbox.length < 2) return null
  const x = finiteNumber(bbox[0])
  const y = finiteNumber(bbox[1])
  if (x == null || y == null) return null
  return [x, y]
}

function centroid(points: Array<[number, number]>): [number, number] {
  let sumX = 0
  let sumY = 0
  for (const [x, y] of points) {
    sumX += x
    sumY += y
  }
  return [sumX / points.length, sumY / points.length]
}

// Drone footprints are GeoJSON [lon, lat]. Detect either from the explicit
// source tag or, defensively, from the coordinate magnitude (|lon| ≤ 180,
// |lat| ≤ 90 across the whole set) so a drone draft projects to true scale.
function isLonLatCapture(
  source: string | null | undefined,
  entries: Array<{ points: Array<[number, number]> }>,
): boolean {
  if (source === 'drone' || source === 'drone.photogrammetry') return true
  if (source != null && source !== '') return false
  let sawPoint = false
  for (const entry of entries) {
    for (const [lon, lat] of entry.points) {
      sawPoint = true
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return false
    }
  }
  return sawPoint
}

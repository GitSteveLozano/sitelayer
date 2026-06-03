/**
 * Pure board-space geometry builders for the scenario seeder.
 *
 * A seeded `takeoff_measurements.geometry` JSONB must be the SAME normalized
 * 0–100 board-space shape the API's `normalizeGeometry`
 * (`packages/domain/src/geometry.ts`) would accept and persist — so a seeded
 * takeoff opens to a real, renderable canvas instead of `{}`.
 *
 * This file deliberately does NOT import `@sitelayer/domain`: this package only
 * depends on `@sitelayer/workflows`, and pulling in `domain` would add a new
 * cross-package edge just to reuse three small validators. Instead we keep a
 * tiny local normalizer that matches the documented contract exactly:
 *   - polygon → kind:'polygon', ≥3 points, each {x,y} in 0..100
 *   - lineal  → kind:'lineal',  ≥2 points, each {x,y} in 0..100
 *   - count   → kind:'count',   point list (one {x,y} per counted symbol)
 *   - volume  → kind:'volume',  positive length/width/height
 *
 * The output is plain JSON (what gets `JSON.stringify`'d into the `geometry`
 * column), so plans stay byte-deterministic.
 */

export interface BoardPoint {
  x: number
  y: number
}

export type GeometryKind = 'polygon' | 'lineal' | 'count' | 'volume'

/** A permissive seed input — `pages`/`measurements` accept this loose shape and
 *  the builder below normalizes it into a canonical board-space geometry. */
export interface GeometryInput {
  kind?: GeometryKind | undefined
  points?: Array<{ x: number; y: number }> | undefined
  length?: number | undefined
  width?: number | undefined
  height?: number | undefined
  unit?: string | undefined
}

export interface PolygonGeometryJson {
  kind: 'polygon'
  points: BoardPoint[]
}
export interface LinealGeometryJson {
  kind: 'lineal'
  points: BoardPoint[]
}
export interface CountGeometryJson {
  kind: 'count'
  points: BoardPoint[]
}
export interface VolumeGeometryJson {
  kind: 'volume'
  length: number
  width: number
  height: number
  unit?: string
}
export type GeometryJson = PolygonGeometryJson | LinealGeometryJson | CountGeometryJson | VolumeGeometryJson

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Clamp + round one point into 0..100 board space (drops non-finite). */
function normalizePoint(input: { x: number; y: number } | undefined): BoardPoint | null {
  if (!input) return null
  const x = Number(input.x)
  const y = Number(input.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: round(Math.min(100, Math.max(0, x))), y: round(Math.min(100, Math.max(0, y))) }
}

function normalizePoints(points: Array<{ x: number; y: number }> | undefined): BoardPoint[] {
  if (!Array.isArray(points)) return []
  const out: BoardPoint[] = []
  for (const p of points) {
    const n = normalizePoint(p)
    if (n) out.push(n)
  }
  return out
}

/**
 * Build a canonical board-space geometry JSON from a permissive seed input.
 *
 * Throws if the input cannot form a valid geometry of its kind (so a bad seed
 * fails fast at plan time rather than writing an `{}`-shaped row the API would
 * reject). The `kind` defaults to `'polygon'`.
 */
export function buildGeometry(input: GeometryInput): GeometryJson {
  const kind: GeometryKind = input.kind ?? 'polygon'

  if (kind === 'volume') {
    const length = Number(input.length)
    const width = Number(input.width)
    const height = Number(input.height)
    if (!(length > 0) || !(width > 0) || !(height > 0)) {
      throw new Error('scenario volume geometry requires positive length/width/height')
    }
    const geometry: VolumeGeometryJson = {
      kind: 'volume',
      length: round(length),
      width: round(width),
      height: round(height),
    }
    if (typeof input.unit === 'string' && input.unit.trim()) geometry.unit = input.unit.trim().slice(0, 32)
    return geometry
  }

  const points = normalizePoints(input.points)
  if (kind === 'polygon') {
    if (points.length < 3) throw new Error('scenario polygon geometry requires at least 3 points')
    return { kind: 'polygon', points }
  }
  if (kind === 'lineal') {
    if (points.length < 2) throw new Error('scenario lineal geometry requires at least 2 points')
    return { kind: 'lineal', points }
  }
  // count
  if (points.length < 1) throw new Error('scenario count geometry requires at least 1 point')
  return { kind: 'count', points }
}

/** Convenience: `[x, y]` tuples → board points. */
export function pts(tuples: Array<[number, number]>): BoardPoint[] {
  return normalizePoints(tuples.map(([x, y]) => ({ x, y })))
}

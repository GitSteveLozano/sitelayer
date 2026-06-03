// Snap-to-content for the takeoff drawing surface.
//
// Snap-to-content is the single biggest digitizing-accuracy lever: when an
// estimator draws a new wall/polygon next to one they already drew, the new
// vertex should LATCH onto the existing geometry instead of landing a fraction
// of a board unit off and leaving an open seam. This module extracts snap
// candidates from the existing measurement geometries, indexes them for fast
// nearest-point lookup, and resolves a raw board point to the nearest
// endpoint / midpoint / on-segment projection within a tolerance.
//
// Everything here is PURE board-space math in the canvas's 0–100 coordinate
// system using `{ x, y }` points (the existing `TakeoffPoint`). No DOM, no
// network, no React — except the one thin `useSnapping` memo hook at the
// bottom. The screen→board mapping stays in `canvas-math.ts`; callers map a
// pointer to a board point first, then run it through `snapPoint`.

import { useMemo } from 'react'
import type { TakeoffPoint } from '@sitelayer/domain'
import type { TakeoffMeasurement } from '@/lib/api'

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

/** A point a raw cursor position can latch onto, tagged with what it is. */
export interface SnapPointCandidate {
  kind: 'endpoint' | 'midpoint'
  point: TakeoffPoint
}

/** A segment a raw cursor position can project onto (closest point on a wall). */
export interface SnapSegment {
  a: TakeoffPoint
  b: TakeoffPoint
}

/** The structured snap candidates extracted from a set of measurements. */
export interface SnapCandidates {
  /** Vertex endpoints and segment midpoints (the discrete latch points). */
  points: SnapPointCandidate[]
  /** Every drawn segment, for on-segment projection. */
  segments: SnapSegment[]
}

function isFinitePoint(p: unknown): p is TakeoffPoint {
  return (
    typeof p === 'object' &&
    p !== null &&
    Number.isFinite((p as TakeoffPoint).x) &&
    Number.isFinite((p as TakeoffPoint).y)
  )
}

/**
 * Pull the board-space polyline vertices out of one measurement's geometry, or
 * `null` when the geometry has no board-space points (volume, count, capture, or
 * a malformed blob). Only `polygon` and `lineal` carry the `{ x, y }[]` board
 * points this module snaps to; a polygon is treated as CLOSED (its last vertex
 * connects back to its first) while a lineal is an open polyline.
 */
function readBoardVertices(measurement: TakeoffMeasurement): { points: TakeoffPoint[]; closed: boolean } | null {
  const geometry = measurement.geometry as { kind?: unknown; points?: unknown }
  if (!geometry || (geometry.kind !== 'polygon' && geometry.kind !== 'lineal')) return null
  if (!Array.isArray(geometry.points)) return null
  const points = geometry.points.filter(isFinitePoint).map((p) => ({ x: p.x, y: p.y }))
  if (points.length === 0) return null
  return { points, closed: geometry.kind === 'polygon' }
}

/**
 * Extract every snap candidate from a set of existing measurements: each
 * vertex becomes an `endpoint` candidate, each segment is recorded for
 * on-segment projection, and each segment's midpoint becomes a `midpoint`
 * candidate. A polygon contributes its closing edge (last vertex → first); a
 * lineal does not. Degenerate (zero-length) segments are skipped so they don't
 * pollute the midpoint set or the projection search. Pure.
 */
export function collectSnapCandidates(measurements: readonly TakeoffMeasurement[]): SnapCandidates {
  const points: SnapPointCandidate[] = []
  const segments: SnapSegment[] = []

  for (const measurement of measurements) {
    const parsed = readBoardVertices(measurement)
    if (!parsed) continue
    const { points: verts, closed } = parsed

    // Every vertex is an endpoint latch point.
    for (const v of verts) {
      points.push({ kind: 'endpoint', point: { x: v.x, y: v.y } })
    }

    // Walk the edges. For a closed polygon, the last edge wraps to vertex 0.
    const edgeCount = closed ? verts.length : verts.length - 1
    for (let i = 0; i < edgeCount; i += 1) {
      const a = verts[i]!
      const b = verts[(i + 1) % verts.length]!
      // Skip degenerate edges (a duplicated vertex) — no segment, no midpoint.
      if (a.x === b.x && a.y === b.y) continue
      segments.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
      points.push({ kind: 'midpoint', point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } })
    }
  }

  return { points, segments }
}

// ---------------------------------------------------------------------------
// Uniform-grid spatial index
// ---------------------------------------------------------------------------

/**
 * Board-space cell size for the uniform grid. The board is 0–100; a cell size
 * of 2 gives a 50×50 grid (2500 buckets) so a typical tolerance (≈1–2 board
 * units) touches only a handful of cells, and a query inspects the 3×3 block
 * around the cursor's cell — bounded work regardless of candidate count.
 */
export const SNAP_GRID_CELL = 2

/**
 * Uniform-grid bucket index over the snap candidates. Point candidates are
 * bucketed by their own cell; segments are bucketed into EVERY cell their
 * bounding box overlaps so a projection query that inspects the neighbourhood
 * around the cursor can't miss a segment whose body crosses a cell its
 * endpoints don't sit in. Built once per candidate set and reused per cursor
 * move. Plain data — no methods, so it's trivially serializable/testable.
 */
export interface SnapIndex {
  cell: number
  pointBuckets: Map<string, SnapPointCandidate[]>
  segmentBuckets: Map<string, SnapSegment[]>
  /** Kept so callers (and the projection fallback) can see the raw candidates. */
  candidates: SnapCandidates
}

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`
}

/** Floor a board coordinate into its grid-cell index for `cell` size. */
function cellIndex(coord: number, cell: number): number {
  return Math.floor(coord / cell)
}

export function buildSnapIndex(candidates: SnapCandidates, cell: number = SNAP_GRID_CELL): SnapIndex {
  const size = Number.isFinite(cell) && cell > 0 ? cell : SNAP_GRID_CELL
  const pointBuckets = new Map<string, SnapPointCandidate[]>()
  const segmentBuckets = new Map<string, SnapSegment[]>()

  for (const candidate of candidates.points) {
    const key = cellKey(cellIndex(candidate.point.x, size), cellIndex(candidate.point.y, size))
    const bucket = pointBuckets.get(key)
    if (bucket) bucket.push(candidate)
    else pointBuckets.set(key, [candidate])
  }

  for (const segment of candidates.segments) {
    const minCx = cellIndex(Math.min(segment.a.x, segment.b.x), size)
    const maxCx = cellIndex(Math.max(segment.a.x, segment.b.x), size)
    const minCy = cellIndex(Math.min(segment.a.y, segment.b.y), size)
    const maxCy = cellIndex(Math.max(segment.a.y, segment.b.y), size)
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = cellKey(cx, cy)
        const bucket = segmentBuckets.get(key)
        if (bucket) bucket.push(segment)
        else segmentBuckets.set(key, [segment])
      }
    }
  }

  return { cell: size, pointBuckets, segmentBuckets, candidates }
}

/**
 * Collect the candidates whose cell is within `radius` cells of the cursor's
 * cell — the cells that could hold anything inside the tolerance. `radius` is
 * `ceil(tolerance / cell)` so the inspected block always covers the tolerance
 * disc. Returns deduped arrays (a segment indexed into several cells appears
 * once).
 */
function neighbourhood(
  index: SnapIndex,
  raw: TakeoffPoint,
  radius: number,
): { points: SnapPointCandidate[]; segments: SnapSegment[] } {
  const cx = cellIndex(raw.x, index.cell)
  const cy = cellIndex(raw.y, index.cell)
  const points: SnapPointCandidate[] = []
  const segments: SnapSegment[] = []
  const seenSegments = new Set<SnapSegment>()
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const key = cellKey(cx + dx, cy + dy)
      const pb = index.pointBuckets.get(key)
      if (pb) points.push(...pb)
      const sb = index.segmentBuckets.get(key)
      if (sb) {
        for (const seg of sb) {
          if (!seenSegments.has(seg)) {
            seenSegments.add(seg)
            segments.push(seg)
          }
        }
      }
    }
  }
  return { points, segments }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function distance(a: TakeoffPoint, b: TakeoffPoint): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Closest point to `p` on the segment `a`→`b`, clamped to the segment's ends.
 * For a degenerate (zero-length) segment this is `a`. Pure.
 */
export function closestPointOnSegment(p: TakeoffPoint, a: TakeoffPoint, b: TakeoffPoint): TakeoffPoint {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby
  if (lenSq === 0) return { x: a.x, y: a.y }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return { x: a.x + t * abx, y: a.y + t * aby }
}

// ---------------------------------------------------------------------------
// Snap resolution
// ---------------------------------------------------------------------------

/** The result of snapping a raw board point. */
export interface SnapResult {
  /** The resolved point — a snapped candidate, or the raw point unchanged. */
  point: TakeoffPoint
  /** What it snapped to, or `null` when nothing was within tolerance. */
  kind: 'endpoint' | 'midpoint' | 'segment' | null
  /** Whether the point actually moved to a candidate. */
  snapped: boolean
}

/**
 * Snap `raw` to the nearest snap candidate within `toleranceBoard` board units.
 *
 * Priority is endpoint > midpoint > on-segment: an endpoint within tolerance
 * always wins (vertex-to-vertex closure is the most important latch), then a
 * midpoint, then a projection onto the nearest segment. WITHIN a kind, the
 * closest candidate wins. Nothing within tolerance ⇒ the raw point is returned
 * unchanged with `snapped: false`. Pure — reads only the prebuilt index.
 */
export function snapPoint(raw: TakeoffPoint, index: SnapIndex, toleranceBoard: number): SnapResult {
  const tolerance = Number.isFinite(toleranceBoard) && toleranceBoard > 0 ? toleranceBoard : 0
  const noSnap: SnapResult = { point: { x: raw.x, y: raw.y }, kind: null, snapped: false }
  if (tolerance === 0) return noSnap

  const radius = Math.max(1, Math.ceil(tolerance / index.cell))
  const { points, segments } = neighbourhood(index, raw, radius)

  // Endpoints first — the highest-priority latch. Within the kind, nearest wins.
  let bestEndpoint: { point: TakeoffPoint; dist: number } | null = null
  let bestMidpoint: { point: TakeoffPoint; dist: number } | null = null
  for (const candidate of points) {
    const d = distance(raw, candidate.point)
    if (d > tolerance) continue
    if (candidate.kind === 'endpoint') {
      if (!bestEndpoint || d < bestEndpoint.dist) bestEndpoint = { point: candidate.point, dist: d }
    } else if (!bestMidpoint || d < bestMidpoint.dist) {
      bestMidpoint = { point: candidate.point, dist: d }
    }
  }

  if (bestEndpoint) {
    return { point: { x: bestEndpoint.point.x, y: bestEndpoint.point.y }, kind: 'endpoint', snapped: true }
  }
  if (bestMidpoint) {
    return { point: { x: bestMidpoint.point.x, y: bestMidpoint.point.y }, kind: 'midpoint', snapped: true }
  }

  // On-segment projection — lowest priority. Nearest projected point wins.
  let bestProjection: { point: TakeoffPoint; dist: number } | null = null
  for (const segment of segments) {
    const proj = closestPointOnSegment(raw, segment.a, segment.b)
    const d = distance(raw, proj)
    if (d > tolerance) continue
    if (!bestProjection || d < bestProjection.dist) bestProjection = { point: proj, dist: d }
  }
  if (bestProjection) {
    return { point: { x: bestProjection.point.x, y: bestProjection.point.y }, kind: 'segment', snapped: true }
  }

  return noSnap
}

// ---------------------------------------------------------------------------
// Ortho lock
// ---------------------------------------------------------------------------

/**
 * Lock `raw` to a horizontal, vertical, or 45° axis relative to `prev` when the
 * segment `prev`→`raw` is within `thresholdDeg` of that axis. This is the
 * "hold to draw a straight wall" assist: a near-horizontal drag snaps to dead
 * horizontal, a near-45° drag snaps to a clean diagonal. When the segment is
 * off every axis (or `prev`/`raw` coincide) the raw point passes through
 * unchanged. Pure.
 *
 * The lock projects `raw` onto the chosen axis line through `prev` (rather than
 * rotating the vector) so the locked point stays as close as possible to where
 * the cursor actually is along that axis.
 */
export function applyOrtho(prev: TakeoffPoint, raw: TakeoffPoint, thresholdDeg: number): TakeoffPoint {
  const dx = raw.x - prev.x
  const dy = raw.y - prev.y
  if (dx === 0 && dy === 0) return { x: raw.x, y: raw.y }

  const threshold = Number.isFinite(thresholdDeg) && thresholdDeg > 0 ? thresholdDeg : 0
  if (threshold === 0) return { x: raw.x, y: raw.y }

  // Candidate axes at 0/45/90/135 degrees, as unit direction vectors.
  const angle = Math.atan2(dy, dx)
  const axes = [
    { x: 1, y: 0 }, // horizontal
    { x: 0, y: 1 }, // vertical
    { x: Math.SQRT1_2, y: Math.SQRT1_2 }, // 45°
    { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, // -45° / 135°
  ]

  let best: { axis: { x: number; y: number }; deltaDeg: number } | null = null
  for (const axis of axes) {
    const axisAngle = Math.atan2(axis.y, axis.x)
    // Smallest angular gap to this axis OR its opposite (a line, not a ray).
    let delta = Math.abs(angle - axisAngle) % Math.PI
    if (delta > Math.PI / 2) delta = Math.PI - delta
    const deltaDeg = (delta * 180) / Math.PI
    if (!best || deltaDeg < best.deltaDeg) best = { axis, deltaDeg }
  }

  if (!best || best.deltaDeg > threshold) return { x: raw.x, y: raw.y }

  // Project (dx,dy) onto the chosen axis direction and re-anchor at `prev`.
  const proj = dx * best.axis.x + dy * best.axis.y
  return { x: prev.x + proj * best.axis.x, y: prev.y + proj * best.axis.y }
}

// ---------------------------------------------------------------------------
// Thin React hook (the only React in this module)
// ---------------------------------------------------------------------------

/**
 * Memoize the snap index for a set of measurements so the canvas can call
 * `snapPoint` on every cursor move without rebuilding candidates each frame.
 * The index is rebuilt only when the `measurements` reference changes (the
 * TanStack Query result is stable between refetches), which is exactly the
 * granularity the canvas needs. Tiny by design — all the work is in the pure
 * functions above.
 */
export function useSnapping(measurements: readonly TakeoffMeasurement[]): SnapIndex {
  return useMemo(() => buildSnapIndex(collectSnapCandidates(measurements)), [measurements])
}

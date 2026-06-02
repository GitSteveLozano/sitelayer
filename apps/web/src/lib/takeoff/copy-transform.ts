// Copy / typical / array / mirror geometry transforms for the takeoff drawing
// surface (deep-dive gap H6). PlanSwift's "Advanced Copy Pro" — Copy-Offset
// (with mirror/rotate) and Array — let an estimator duplicate identical bays,
// typical floors, and repeated cladding panels instead of redrawing them.
//
// Everything here is a PURE board-space transform: it maps a measurement's
// `points` (the shared 0–100 SVG board space the desktop / mobile / projects
// canvases all draw in) into one-or-more shifted/mirrored/rotated copies, ready
// to be saved as NEW measurements through the existing `useCreateMeasurement`
// path (so quantities recompute server-side exactly as for a hand-drawn shape).
//
// No React, no DOM, no network — same contract as `canvas-math.ts`. The screens
// pass a measurement's geometry + a plan; this returns the geometries to create.

import type { TakeoffPoint } from '@sitelayer/domain'
import { clamp, round2 } from './canvas-math'

/** Board space is the 0–100 square the canvases draw in (see `canvas-math.ts`). */
const BOARD_MIN = 0
const BOARD_MAX = 100

/** A board-space displacement (`dx`, `dy`) applied to every copied vertex. */
export interface BoardOffset {
  dx: number
  dy: number
}

/** Axis for a mirror reflection: `'x'` flips left↔right, `'y'` flips top↔bottom. */
export type MirrorAxis = 'x' | 'y'

/**
 * How to lay out the duplicates of a selection.
 *  - `offset`  — a single copy shifted by `delta` (Copy-with-Offset).
 *  - `array`   — `count` copies stepped by `delta` along a row, or, when
 *                `rows`/`cols` are given, an `cols × rows` grid stepped by
 *                `delta` (col step) and `rowDelta` (row step). The original is
 *                NOT re-emitted; every entry is a fresh copy.
 *  - `mirror`  — a single mirrored copy (optionally also offset).
 *  - `rotate`  — a single rotated copy (optionally also offset).
 *
 * `mirror` / `rotate` are also accepted as modifiers on `offset` / `array` so a
 * user can, e.g., array a mirrored bay. They are applied per-copy, about the
 * copy's own centroid, so the duplicate keeps its drawn footprint.
 */
export interface CopyPlan {
  mode: 'offset' | 'array' | 'mirror' | 'rotate'
  /** Primary step / single-copy displacement (board units). Default {0,0}. */
  delta?: BoardOffset
  /** Number of copies for `array` row mode (≥1). Ignored in grid mode. */
  count?: number
  /** Grid columns (≥1) — switches `array` into grid layout when with `rows`. */
  cols?: number
  /** Grid rows (≥1) — switches `array` into grid layout when with `cols`. */
  rows?: number
  /** Row step for grid `array` (board units). Defaults to `delta` rotated 90°. */
  rowDelta?: BoardOffset
  /** Reflect each copy about this axis (through the copy centroid). */
  mirror?: MirrorAxis
  /** Rotate each copy by this many degrees (about the copy centroid, CW+). */
  rotateDeg?: number
}

/** Centroid (arithmetic mean) of a point set. Empty ⇒ `{0,0}`. */
export function centroid(points: readonly TakeoffPoint[]): TakeoffPoint {
  if (points.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / points.length, y: sy / points.length }
}

/** Translate every vertex by `(dx, dy)` board units. Pure. */
export function offsetPoints(points: readonly TakeoffPoint[], offset: BoardOffset): TakeoffPoint[] {
  return points.map((p) => ({ x: p.x + offset.dx, y: p.y + offset.dy }))
}

/**
 * Reflect every vertex about the set's own centroid along `axis`. Mirroring in
 * place (rather than about the board origin) keeps the duplicate on top of /
 * beside the source instead of flinging it off-sheet. `'x'` mirrors horizontally
 * (negates the x-offset from centroid); `'y'` mirrors vertically.
 */
export function mirrorPoints(points: readonly TakeoffPoint[], axis: MirrorAxis): TakeoffPoint[] {
  const c = centroid(points)
  return points.map((p) => (axis === 'x' ? { x: 2 * c.x - p.x, y: p.y } : { x: p.x, y: 2 * c.y - p.y }))
}

/**
 * Rotate every vertex `deg` degrees clockwise about the set's own centroid
 * (clockwise because board-space y grows downward, matching the on-screen
 * sense). Pure trig — no clamping here (callers clamp at the end).
 */
export function rotatePoints(points: readonly TakeoffPoint[], deg: number): TakeoffPoint[] {
  if (deg === 0) return points.map((p) => ({ x: p.x, y: p.y }))
  const c = centroid(points)
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return points.map((p) => {
    const dx = p.x - c.x
    const dy = p.y - c.y
    // Clockwise rotation in a y-down coordinate frame.
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
  })
}

/** Round to board precision and clamp into the 0–100 board square. */
function normalize(points: readonly TakeoffPoint[]): TakeoffPoint[] {
  return points.map((p) => ({
    x: round2(clamp(p.x, BOARD_MIN, BOARD_MAX)),
    y: round2(clamp(p.y, BOARD_MIN, BOARD_MAX)),
  }))
}

/** A board offset rotated 90° clockwise: `(dx,dy) → (-dy,dx)`. Used as the
 *  default grid row-step when only a column `delta` is supplied. The `+ 0`
 *  normalizes a negated zero (`-0`) back to `+0` so equality checks are clean. */
function perpendicular(offset: BoardOffset): BoardOffset {
  return { dx: -offset.dy + 0, dy: offset.dx + 0 }
}

/**
 * Expand a `CopyPlan` into the per-copy displacements (the placement of each
 * duplicate, before per-copy mirror/rotate). The original shape is never
 * re-emitted — every returned displacement is for a NEW copy.
 *
 * - `offset` / `mirror` / `rotate` ⇒ one placement at `delta` (default origin).
 * - `array` row ⇒ `count` placements stepped by `delta` (i = 1…count, so the
 *   first copy is already one step off the source — no zero-offset overlap).
 * - `array` grid ⇒ `cols × rows` placements stepped by `delta` (columns) and
 *   `rowDelta` (rows), skipping the (0,0) source cell.
 */
export function planOffsets(plan: CopyPlan): BoardOffset[] {
  const delta = plan.delta ?? { dx: 0, dy: 0 }
  if (plan.mode === 'array') {
    const cols = plan.cols && plan.cols > 0 ? Math.floor(plan.cols) : 0
    const rows = plan.rows && plan.rows > 0 ? Math.floor(plan.rows) : 0
    if (cols > 0 && rows > 0) {
      const rowDelta = plan.rowDelta ?? perpendicular(delta)
      const out: BoardOffset[] = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r === 0 && c === 0) continue // the source cell is the original
          out.push({ dx: c * delta.dx + r * rowDelta.dx, dy: c * delta.dy + r * rowDelta.dy })
        }
      }
      return out
    }
    const count = plan.count && plan.count > 0 ? Math.floor(plan.count) : 1
    const out: BoardOffset[] = []
    for (let i = 1; i <= count; i++) out.push({ dx: i * delta.dx, dy: i * delta.dy })
    return out
  }
  // offset / mirror / rotate: a single placement at the supplied delta.
  return [{ dx: delta.dx, dy: delta.dy }]
}

/**
 * Transform one source point set into all of its copies' point sets per `plan`,
 * applying (in order) per-copy mirror → rotate → placement-offset, then rounding
 * + clamping into the board square. Returns one entry per duplicate.
 */
export function buildCopyPointSets(points: readonly TakeoffPoint[], plan: CopyPlan): TakeoffPoint[][] {
  if (points.length === 0) return []
  const mirror = plan.mirror ?? (plan.mode === 'mirror' ? 'x' : undefined)
  const rotateDeg = plan.rotateDeg ?? (plan.mode === 'rotate' ? 90 : 0)
  // Pre-shape (mirror then rotate) once about the source centroid; the placement
  // offsets then translate that shaped copy into each array slot.
  let shaped: TakeoffPoint[] = points.map((p) => ({ x: p.x, y: p.y }))
  if (mirror) shaped = mirrorPoints(shaped, mirror)
  if (rotateDeg) shaped = rotatePoints(shaped, rotateDeg)
  return planOffsets(plan).map((off) => normalize(offsetPoints(shaped, off)))
}

/**
 * The subset of a measurement geometry this module copies: a board-space point
 * list plus the optional per-axis world scale stamped at draw time. `kind` is
 * preserved verbatim so a copied polygon stays a polygon, a lineal stays a
 * lineal, and a count stays a count. (Geometries without `points` — e.g. raw
 * `volume` scalars or capture polygons — are not copyable here and are skipped
 * by the screens, which fall back to the existing whole-geometry duplicate.)
 */
export interface CopyableGeometry {
  kind: string
  points?: Array<{ x: number; y: number }>
  world_per_board_x?: number
  world_per_board_y?: number
}

/**
 * Produce the geometries for every duplicate of `geometry` under `plan`. Each
 * result is a NEW geometry with copied/transformed `points`, the same `kind`,
 * and the same world-scale stamp (so the server recomputes true sqft/lf the
 * same way it did for the source). Returns `[]` when the geometry has no
 * board-space points to transform.
 */
export function buildDuplicateGeometries<G extends CopyableGeometry>(geometry: G, plan: CopyPlan): G[] {
  const points = geometry.points
  if (!points || points.length === 0) return []
  return buildCopyPointSets(points, plan).map((pts) => ({ ...geometry, points: pts }))
}

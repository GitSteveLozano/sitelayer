// 3-point arc tessellation for the takeoff drawing surface.
//
// PlanSwift-style curved takeoffs (a radiused wall, a curved curb) are produced
// by tessellating the circular arc through three control points into an ordinary
// polyline. Keeping the output as plain points means the curve flows through the
// existing lineal geometry — the segment-sum length math and the server-side
// geometry validation are untouched, so curved takeoffs carry zero risk to the
// shared geometry model or estimate quantities.

import type { TakeoffPoint } from '@sitelayer/domain'

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Tessellate the circular arc through three board-space (0–100) control points
 * — `start`, a point the arc passes `through`, and `end` — into `segments + 1`
 * points. The sweep direction is chosen so the curve passes through the middle
 * control point. Three (near-)collinear points have no circumscribing circle, so
 * the straight start→through→end path is returned instead. Pure.
 */
export function arcPolyline(
  start: TakeoffPoint,
  through: TakeoffPoint,
  end: TakeoffPoint,
  segments = 24,
): TakeoffPoint[] {
  const { x: ax, y: ay } = start
  const { x: bx, y: by } = through
  const { x: cx, y: cy } = end
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-6) return [start, through, end] // collinear → no circle
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const twoPi = Math.PI * 2
  const norm = (a: number) => ((a % twoPi) + twoPi) % twoPi
  const a1 = Math.atan2(ay - uy, ax - ux)
  const aMid = Math.atan2(by - uy, bx - ux)
  const aEnd = Math.atan2(cy - uy, cx - ux)
  // Sweep start→end the way that passes through the middle control point.
  const ccwSpan = norm(aEnd - a1)
  const goesCcw = norm(aMid - a1) <= ccwSpan
  const total = goesCcw ? ccwSpan : ccwSpan - twoPi
  const out: TakeoffPoint[] = []
  const steps = Math.max(2, Math.floor(segments))
  for (let i = 0; i <= steps; i += 1) {
    const t = a1 + (total * i) / steps
    out.push({ x: round2(clamp(ux + r * Math.cos(t), 0, 100)), y: round2(clamp(uy + r * Math.sin(t), 0, 100)) })
  }
  return out
}

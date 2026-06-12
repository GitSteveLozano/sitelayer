// Shared canvas coordinate math for the takeoff drawing surface.
//
// The desktop (`screens/desktop/est-canvas.tsx`) and mobile
// (`screens/mobile/takeoff-mobile.tsx`) takeoff canvases (plus, historically,
// the v1 `screens/projects/takeoff-canvas.tsx`, retired 2026-06-12) map a
// pointer's screen position into the SVG's 0–100 board space using the SAME
// `getScreenCTM()` / `createSVGPoint()` / `matrixTransform(ctm.inverse())`
// transform, and the same `clamp` / `round2` primitives. That math was
// duplicated verbatim across the three screens; this module is its single
// source of truth. Pure — no React, no DOM mutation.

import type { TakeoffPoint } from '@sitelayer/domain'

/** Clamp `n` into the inclusive range `[lo, hi]`. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Round to two decimal places (the board-space precision the canvases store). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Map a screen (client) coordinate into the SVG's local 0–100 board space using
 * the element's screen CTM, so the result respects the current viewBox (zoom /
 * pan). Returns the RAW, unclamped local point, or `null` when the CTM is
 * unavailable (the SVG is not laid out yet). Callers apply their own
 * clamp / round / snap on top, exactly as before. Pure (reads only the SVG's
 * current transform).
 */
export function screenToBoardPoint(svg: SVGSVGElement, clientX: number, clientY: number): TakeoffPoint | null {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const local = pt.matrixTransform(ctm.inverse())
  return { x: local.x, y: local.y }
}

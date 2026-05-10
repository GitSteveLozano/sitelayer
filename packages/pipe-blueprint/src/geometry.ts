/** Shoelace area for a closed polygon in pixel units. Returns absolute value. */
export function polygonAreaPx2(polygon: ReadonlyArray<{ x: number; y: number }>): number {
  if (polygon.length < 3) return 0
  let s = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** Sum of edge lengths in pixels (closed polygon). */
export function polygonPerimeterPx(polygon: ReadonlyArray<{ x: number; y: number }>): number {
  if (polygon.length < 2) return 0
  let p = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    p += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return p
}

/** Axis-aligned bounding box [minX, minY, maxX, maxY]. */
export function polygonBbox(polygon: ReadonlyArray<{ x: number; y: number }>): [number, number, number, number] {
  if (polygon.length === 0) return [0, 0, 0, 0]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return [minX, minY, maxX, maxY]
}

/** Euclidean length in pixels of a wall segment. */
export function segmentLengthPx(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// Pure-TypeScript RANSAC plane segmenter for hand-authored point clouds.
//
// Research-grade stub. A real implementation should use Open3D / PCL with
// proper KD-tree neighbour queries, voxel downsampling, and robust normal
// estimation. This file exists so the math is exercisable in tests at
// miniature scale, and so the buildDroneTakeoff path can demonstrate
// extracting roof planes from a hand-authored fixture.

export type Vec3 = [number, number, number]

export interface Plane {
  id: string
  /** Plane equation a·x + b·y + c·z + d = 0; (a,b,c) is the unit normal. */
  equation: [number, number, number, number]
  /** Unit normal (same as the first three components of equation). */
  normalVec: Vec3
  /** Indices into the input `points` array of inliers. */
  inlierIndices: number[]
}

export interface SegmentPlaneOptions {
  distanceThresholdM?: number
  iterations?: number
  minInliers?: number
  rngSeed?: number
}

export interface SegmentMultiplePlanesOptions {
  maxPlanes?: number
  minInliers?: number
  distanceThresholdM?: number
  iterations?: number
  rngSeed?: number
}

// ─── Tiny seedable LCG ────────────────────────────────────────────────────
// We don't pull a dep. Numerical Recipes parameters; "good enough" RNG.

function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function pickThreeDistinct(rng: () => number, n: number): [number, number, number] {
  if (n < 3) throw new Error('pickThreeDistinct requires n>=3')
  const a = Math.floor(rng() * n)
  let b = Math.floor(rng() * n)
  while (b === a) b = Math.floor(rng() * n)
  let c = Math.floor(rng() * n)
  while (c === a || c === b) c = Math.floor(rng() * n)
  return [a, b, c]
}

// ─── Vector helpers ───────────────────────────────────────────────────────

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function norm(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function normalize(v: Vec3): Vec3 {
  const n = norm(v)
  if (n === 0) return [0, 0, 0]
  return [v[0] / n, v[1] / n, v[2] / n]
}

// ─── segmentPlane ─────────────────────────────────────────────────────────

export function segmentPlane(points: Vec3[], opts: SegmentPlaneOptions = {}): Plane | null {
  const distanceThreshold = opts.distanceThresholdM ?? 0.05
  const iterations = opts.iterations ?? 1000
  const minInliers = opts.minInliers ?? 50
  const rng = lcg(opts.rngSeed ?? 0xc0ffee)

  if (points.length < 3) return null

  let bestInliers: number[] = []
  let bestNormal: Vec3 = [0, 0, 1]
  let bestD = 0

  for (let iter = 0; iter < iterations; iter++) {
    const [i1, i2, i3] = pickThreeDistinct(rng, points.length)
    const p1 = points[i1]!
    const p2 = points[i2]!
    const p3 = points[i3]!
    const v1 = sub(p2, p1)
    const v2 = sub(p3, p1)
    const n = cross(v1, v2)
    const nn = norm(n)
    if (nn < 1e-9) continue // collinear sample
    const normal: Vec3 = [n[0] / nn, n[1] / nn, n[2] / nn]
    const d = -dot(normal, p1)
    // Count inliers.
    const inliers: number[] = []
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      const dist = Math.abs(dot(normal, p) + d)
      if (dist <= distanceThreshold) inliers.push(i)
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers
      bestNormal = normal
      bestD = d
    }
  }

  if (bestInliers.length < minInliers) return null

  // Refit plane to inliers via least-squares (centroid + SVD-ish via 3x3
  // covariance, smallest eigenvector). For a spike we use the best RANSAC
  // sample directly — refinement is documented in NOTES.md as a follow-up.
  const refined = refitPlane(points, bestInliers, bestNormal)
  if (refined) {
    bestNormal = refined.normal
    bestD = refined.d
    // Recompute inliers with refined plane.
    const refinedInliers: number[] = []
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      const dist = Math.abs(dot(bestNormal, p) + bestD)
      if (dist <= distanceThreshold) refinedInliers.push(i)
    }
    if (refinedInliers.length >= minInliers) bestInliers = refinedInliers
  }

  return {
    id: `plane-${Math.abs(opts.rngSeed ?? 0).toString(36)}-${bestInliers.length}`,
    equation: [bestNormal[0], bestNormal[1], bestNormal[2], bestD],
    normalVec: bestNormal,
    inlierIndices: bestInliers,
  }
}

/** Refit plane to inlier set: centroid + smallest-eigenvector of covariance. */
function refitPlane(points: Vec3[], inlierIndices: number[], hint: Vec3): { normal: Vec3; d: number } | null {
  if (inlierIndices.length < 3) return null
  let cx = 0
  let cy = 0
  let cz = 0
  for (const i of inlierIndices) {
    const p = points[i]!
    cx += p[0]
    cy += p[1]
    cz += p[2]
  }
  const n = inlierIndices.length
  const centroid: Vec3 = [cx / n, cy / n, cz / n]

  // Covariance matrix.
  let xx = 0
  let xy = 0
  let xz = 0
  let yy = 0
  let yz = 0
  let zz = 0
  for (const i of inlierIndices) {
    const p = points[i]!
    const dx = p[0] - centroid[0]
    const dy = p[1] - centroid[1]
    const dz = p[2] - centroid[2]
    xx += dx * dx
    xy += dx * dy
    xz += dx * dz
    yy += dy * dy
    yz += dy * dz
    zz += dz * dz
  }

  // Compute smallest-eigenvalue eigenvector by Jacobi-style power iteration on
  // the inverse direction: easiest is to find eigenvector of the cross product
  // of two largest planes spanned by covariance. For a spike: try all three
  // axis aligned cross products and pick the one whose dot with hint is
  // largest in magnitude. Cleaner: compute via determinant cofactors.
  // Plane normal is the eigenvector of the smallest eigenvalue of the cov.
  // Use a small power-iteration on the inverse (deflation by hint) — but the
  // cofactor method is simpler.
  const det = (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
  ): number => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)

  // Three rows of cofactor matrix give candidate normal vectors.
  const r1: Vec3 = [yy * zz - yz * yz, -(xy * zz - yz * xz), xy * yz - yy * xz]
  const r2: Vec3 = [-(xy * zz - xz * yz), xx * zz - xz * xz, -(xx * yz - xy * xz)]
  const r3: Vec3 = [xy * yz - xz * yy, -(xx * yz - xz * xy), xx * yy - xy * xy]

  const candidates = [r1, r2, r3]
    .map((c) => ({ vec: c, mag: norm(c) }))
    .filter((c) => c.mag > 1e-9)
    .sort((a, b) => b.mag - a.mag)
  if (candidates.length === 0) return null
  const top = candidates[0]!
  let normal = normalize(top.vec)
  // Align normal to the RANSAC hint to avoid sign flips between iterations.
  if (dot(normal, hint) < 0) normal = [-normal[0], -normal[1], -normal[2]]
  const d = -dot(normal, centroid)
  // Sanity: determinant of cov.
  void det // referenced for clarity; unused after cofactor path picked.
  return { normal, d }
}

// ─── segmentMultiplePlanes ────────────────────────────────────────────────

export function segmentMultiplePlanes(points: Vec3[], opts: SegmentMultiplePlanesOptions = {}): Plane[] {
  const maxPlanes = opts.maxPlanes ?? 5
  const minInliers = opts.minInliers ?? 50
  const distanceThresholdM = opts.distanceThresholdM ?? 0.05
  const iterations = opts.iterations ?? 1000
  const baseSeed = opts.rngSeed ?? 0xc0ffee

  // Track which points are still available.
  const available = new Set<number>()
  for (let i = 0; i < points.length; i++) available.add(i)

  const planes: Plane[] = []
  for (let p = 0; p < maxPlanes; p++) {
    if (available.size < minInliers) break
    // Build a sub-array and an index-mapping back to the original.
    const subIndices = Array.from(available)
    const subPoints: Vec3[] = subIndices.map((i) => points[i]!)
    const plane = segmentPlane(subPoints, {
      distanceThresholdM,
      iterations,
      minInliers,
      rngSeed: baseSeed + p,
    })
    if (!plane) break
    // Map sub-inliers back to original indices.
    const originalInliers = plane.inlierIndices.map((sub) => subIndices[sub]!)
    planes.push({
      ...plane,
      id: `plane-${p}`,
      inlierIndices: originalInliers,
    })
    for (const idx of originalInliers) available.delete(idx)
  }
  return planes
}

// ─── Plane area / pitch / azimuth helpers ─────────────────────────────────

export interface PlaneMetrics {
  areaSqM: number
  pitchDegrees: number
  azimuthDegrees: number
}

/**
 * Compute area + pitch + azimuth from inliers projected onto the plane.
 *
 * Area uses an alpha-shape proxy: project inliers into the plane's local 2D
 * basis, take the convex hull (Graham scan), and sum via the shoelace formula.
 * Convex hull overestimates concave roofs — see NOTES.md.
 *
 * Pitch = degrees(acos(abs(n_z))). 0° is flat, 90° is vertical.
 * Azimuth: from the projected downhill direction. 0=N, 90=E.
 */
export function planeAreaFromInliers(plane: Plane, points: Vec3[]): PlaneMetrics {
  const n = plane.normalVec
  const nz = n[2]
  const pitchDegrees = (Math.acos(Math.min(1, Math.abs(nz))) * 180) / Math.PI

  // Build a 2D basis in the plane.
  // u = any unit vector perpendicular to n; v = n × u.
  const refUp: Vec3 = Math.abs(nz) < 0.99 ? [0, 0, 1] : [1, 0, 0]
  let u = cross(n, refUp)
  const uNorm = norm(u)
  if (uNorm < 1e-9) {
    return { areaSqM: 0, pitchDegrees, azimuthDegrees: 0 }
  }
  u = [u[0] / uNorm, u[1] / uNorm, u[2] / uNorm]
  const v = cross(n, u)

  // Project each inlier into 2D (u, v) coords.
  const pts2d: Array<[number, number, number]> = [] // [u, v, originalIdx]
  for (const i of plane.inlierIndices) {
    const p = points[i]!
    pts2d.push([dot(p, u), dot(p, v), i])
  }

  // Convex hull (Graham scan).
  const hull = grahamScan2(pts2d.map(([x, y]) => [x, y] as [number, number]))
  const areaSqM = polygonArea(hull)

  // Azimuth: downhill direction in the world XY plane.
  // The horizontal projection of the steepest-descent vector is `(n_x, n_y)`
  // pointing downhill (i.e. away from the normal's horizontal component IS
  // the downhill direction; conventional roof azimuth uses where water flows).
  // Water flows toward (-n_x, -n_y) when n_z > 0 (normal points up).
  const downX = -n[0]
  const downY = -n[1]
  let azimuthDegrees = 0
  const horizMag = Math.sqrt(downX * downX + downY * downY)
  if (horizMag > 1e-6) {
    // Convert (x,y) where x=East, y=North to compass bearing.
    // Compass bearing = atan2(East, North) in degrees, 0=N, 90=E.
    azimuthDegrees = ((Math.atan2(downX, downY) * 180) / Math.PI + 360) % 360
  }

  return { areaSqM, pitchDegrees, azimuthDegrees }
}

// ─── 2D Graham scan + shoelace ────────────────────────────────────────────

function grahamScan2(input: Array<[number, number]>): Array<[number, number]> {
  if (input.length < 3) return [...input]
  const pts = input.slice()
  // Pivot: lowest y, then lowest x.
  let pivotIdx = 0
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!
    const q = pts[pivotIdx]!
    if (p[1] < q[1] || (p[1] === q[1] && p[0] < q[0])) pivotIdx = i
  }
  const pivot = pts[pivotIdx]!
  pts[pivotIdx] = pts[0]!
  pts[0] = pivot

  const rest = pts.slice(1)
  rest.sort((a, b) => {
    const ax = a[0] - pivot[0]
    const ay = a[1] - pivot[1]
    const bx = b[0] - pivot[0]
    const by = b[1] - pivot[1]
    const angA = Math.atan2(ay, ax)
    const angB = Math.atan2(by, bx)
    if (angA !== angB) return angA - angB
    // Closer point first if collinear.
    return ax * ax + ay * ay - (bx * bx + by * by)
  })

  const stack: Array<[number, number]> = [pivot]
  for (const p of rest) {
    while (stack.length >= 2 && cross2(stack[stack.length - 2]!, stack[stack.length - 1]!, p) <= 0) {
      stack.pop()
    }
    stack.push(p)
  }
  return stack
}

function cross2(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

function polygonArea(poly: Array<[number, number]>): number {
  if (poly.length < 3) return 0
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum) / 2
}

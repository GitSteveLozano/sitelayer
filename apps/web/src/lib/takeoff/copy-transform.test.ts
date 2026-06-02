import { describe, expect, it } from 'vitest'
import {
  buildCopyPointSets,
  buildDuplicateGeometries,
  centroid,
  mirrorPoints,
  offsetPoints,
  planOffsets,
  rotatePoints,
} from './copy-transform'

// A unit square (board space) used across the cases. Centroid = (10,10).
const square = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
]

describe('centroid', () => {
  it('averages the vertices', () => {
    expect(centroid(square)).toEqual({ x: 10, y: 10 })
  })
  it('is (0,0) for an empty set', () => {
    expect(centroid([])).toEqual({ x: 0, y: 0 })
  })
})

describe('offsetPoints', () => {
  it('translates every vertex by the offset', () => {
    expect(offsetPoints(square, { dx: 5, dy: -3 })).toEqual([
      { x: 5, y: -3 },
      { x: 25, y: -3 },
      { x: 25, y: 17 },
      { x: 5, y: 17 },
    ])
  })
})

describe('mirrorPoints', () => {
  it('reflects about the centroid on the x axis (left↔right)', () => {
    // centroid x = 10, so x → 20 - x.
    expect(mirrorPoints(square, 'x')).toEqual([
      { x: 20, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 20, y: 20 },
    ])
  })
  it('reflects about the centroid on the y axis (top↔bottom)', () => {
    expect(mirrorPoints(square, 'y')).toEqual([
      { x: 0, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ])
  })
  it('preserves area (mirror is rigid) — centroid unchanged', () => {
    expect(centroid(mirrorPoints(square, 'x'))).toEqual({ x: 10, y: 10 })
  })
})

describe('rotatePoints', () => {
  it('is a no-op at 0°', () => {
    expect(rotatePoints(square, 0)).toEqual(square)
  })
  it('rotates 90° clockwise about the centroid', () => {
    // y-down clockwise 90° about centroid (10,10): (dx,dy) → (-dy, dx).
    // (0,0) has (dx,dy)=(-10,-10) → (-dy,dx)=(10,-10) → + centroid = (20, 0).
    const r = rotatePoints(square, 90)
    expect(r[0]!.x).toBeCloseTo(20, 6)
    expect(r[0]!.y).toBeCloseTo(0, 6)
    // The rotated square is still the same square (90° symmetry) — centroid held.
    expect(centroid(r).x).toBeCloseTo(10, 6)
    expect(centroid(r).y).toBeCloseTo(10, 6)
  })
  it('returns to the original after 360°', () => {
    const r = rotatePoints(square, 360)
    for (let i = 0; i < square.length; i++) {
      expect(r[i]!.x).toBeCloseTo(square[i]!.x, 6)
      expect(r[i]!.y).toBeCloseTo(square[i]!.y, 6)
    }
  })
})

describe('planOffsets', () => {
  it('offset mode → a single placement at delta', () => {
    expect(planOffsets({ mode: 'offset', delta: { dx: 4, dy: 2 } })).toEqual([{ dx: 4, dy: 2 }])
  })
  it('offset mode defaults to the origin', () => {
    expect(planOffsets({ mode: 'offset' })).toEqual([{ dx: 0, dy: 0 }])
  })
  it('array row → count placements stepped by delta, first copy already offset', () => {
    expect(planOffsets({ mode: 'array', count: 3, delta: { dx: 10, dy: 0 } })).toEqual([
      { dx: 10, dy: 0 },
      { dx: 20, dy: 0 },
      { dx: 30, dy: 0 },
    ])
  })
  it('array row defaults to a single copy when count is missing', () => {
    expect(planOffsets({ mode: 'array', delta: { dx: 5, dy: 5 } })).toEqual([{ dx: 5, dy: 5 }])
  })
  it('array grid → cols×rows minus the source cell, default perpendicular row step', () => {
    // 2 cols × 2 rows, col step (10,0); default row step = (10,0) rotated 90° = (0,10).
    const out = planOffsets({ mode: 'array', cols: 2, rows: 2, delta: { dx: 10, dy: 0 } })
    expect(out).toEqual([
      { dx: 10, dy: 0 }, // r0,c1
      { dx: 0, dy: 10 }, // r1,c0
      { dx: 10, dy: 10 }, // r1,c1
    ])
    // 3 copies for a 2×2 grid (the source cell is the original).
    expect(out).toHaveLength(3)
  })
  it('array grid honors an explicit rowDelta', () => {
    const out = planOffsets({
      mode: 'array',
      cols: 2,
      rows: 2,
      delta: { dx: 8, dy: 0 },
      rowDelta: { dx: 0, dy: 12 },
    })
    expect(out).toEqual([
      { dx: 8, dy: 0 },
      { dx: 0, dy: 12 },
      { dx: 8, dy: 12 },
    ])
  })
})

describe('buildCopyPointSets', () => {
  it('returns one shifted copy for offset mode', () => {
    const sets = buildCopyPointSets(square, { mode: 'offset', delta: { dx: 5, dy: 5 } })
    expect(sets).toHaveLength(1)
    expect(sets[0]).toEqual([
      { x: 5, y: 5 },
      { x: 25, y: 5 },
      { x: 25, y: 25 },
      { x: 5, y: 25 },
    ])
  })
  it('returns N copies for an array', () => {
    const sets = buildCopyPointSets(square, { mode: 'array', count: 2, delta: { dx: 30, dy: 0 } })
    expect(sets).toHaveLength(2)
    expect(sets[0]![0]).toEqual({ x: 30, y: 0 })
    expect(sets[1]![0]).toEqual({ x: 60, y: 0 })
  })
  it('clamps copies into the 0–100 board square', () => {
    // Shift far past the right edge — every x clamps to 100.
    const sets = buildCopyPointSets(square, { mode: 'offset', delta: { dx: 200, dy: 0 } })
    for (const p of sets[0]!) expect(p.x).toBe(100)
  })
  it('rounds to two decimals (board precision)', () => {
    const sets = buildCopyPointSets([{ x: 0, y: 0 }], { mode: 'offset', delta: { dx: 1.23456, dy: 0 } })
    expect(sets[0]![0]!.x).toBe(1.23)
  })
  it('applies mirror mode about the copy centroid', () => {
    const sets = buildCopyPointSets(square, { mode: 'mirror' })
    expect(sets).toHaveLength(1)
    // Mirror-x about centroid (10,10): (0,0)→(20,0).
    expect(sets[0]![0]).toEqual({ x: 20, y: 0 })
  })
  it('applies rotate mode (default 90°)', () => {
    const sets = buildCopyPointSets(square, { mode: 'rotate' })
    expect(sets).toHaveLength(1)
    expect(sets[0]![0]!.x).toBeCloseTo(20, 6)
    expect(sets[0]![0]!.y).toBeCloseTo(0, 6)
  })
  it('returns [] for an empty point set', () => {
    expect(buildCopyPointSets([], { mode: 'offset' })).toEqual([])
  })
})

describe('buildDuplicateGeometries', () => {
  it('preserves kind and world-scale on each duplicate', () => {
    const geo = {
      kind: 'polygon' as const,
      points: square,
      world_per_board_x: 0.5,
      world_per_board_y: 0.4,
    }
    const dupes = buildDuplicateGeometries(geo, { mode: 'array', count: 2, delta: { dx: 25, dy: 0 } })
    expect(dupes).toHaveLength(2)
    for (const d of dupes) {
      expect(d.kind).toBe('polygon')
      expect(d.world_per_board_x).toBe(0.5)
      expect(d.world_per_board_y).toBe(0.4)
      expect(d.points).toHaveLength(4)
    }
    expect(dupes[0]!.points![0]).toEqual({ x: 25, y: 0 })
    expect(dupes[1]!.points![0]).toEqual({ x: 50, y: 0 })
  })
  it('copies a lineal kind verbatim', () => {
    const geo = {
      kind: 'lineal' as const,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    }
    const dupes = buildDuplicateGeometries(geo, { mode: 'offset', delta: { dx: 0, dy: 5 } })
    expect(dupes[0]!.kind).toBe('lineal')
    expect(dupes[0]!.points).toEqual([
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ])
  })
  it('returns [] when the geometry has no points (e.g. volume/capture)', () => {
    expect(buildDuplicateGeometries({ kind: 'volume' }, { mode: 'offset' })).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { TakeoffMeasurement } from '@/lib/api'
import type { MeasurementGeometry } from '@/lib/api/takeoff'
import {
  applyOrtho,
  buildSnapIndex,
  closestPointOnSegment,
  collectSnapCandidates,
  snapPoint,
  SNAP_GRID_CELL,
} from './snapping'

function measurement(geometry: MeasurementGeometry, m: Partial<TakeoffMeasurement> = {}): TakeoffMeasurement {
  return {
    id: 'm1',
    project_id: 'p1',
    blueprint_document_id: null,
    page_id: null,
    service_item_code: 'SIDING',
    quantity: '10',
    unit: 'sqft',
    notes: null,
    elevation: null,
    image_thumbnail: null,
    geometry,
    version: 1,
    created_at: '2026-06-01T00:00:00Z',
    ...m,
  } as TakeoffMeasurement
}

/** A single horizontal wall (lineal) from (10,10) to (30,10). */
function wall(): TakeoffMeasurement {
  return measurement({
    kind: 'lineal',
    points: [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
    ],
  })
}

function indexFor(measurements: TakeoffMeasurement[]) {
  return buildSnapIndex(collectSnapCandidates(measurements))
}

// ---------------------------------------------------------------------------
// collectSnapCandidates
// ---------------------------------------------------------------------------

describe('collectSnapCandidates', () => {
  it('extracts endpoints, a segment, and the midpoint from a single wall', () => {
    const candidates = collectSnapCandidates([wall()])
    // two endpoints + one midpoint
    const endpoints = candidates.points.filter((p) => p.kind === 'endpoint')
    const midpoints = candidates.points.filter((p) => p.kind === 'midpoint')
    expect(endpoints.map((e) => e.point)).toEqual([
      { x: 10, y: 10 },
      { x: 30, y: 10 },
    ])
    expect(midpoints.map((mp) => mp.point)).toEqual([{ x: 20, y: 10 }])
    expect(candidates.segments).toEqual([{ a: { x: 10, y: 10 }, b: { x: 30, y: 10 } }])
  })

  it('closes a polygon: includes the wrap-around edge (last → first)', () => {
    const tri = measurement({
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
    })
    const candidates = collectSnapCandidates([tri])
    // 3 vertices + 3 edges (incl. closing edge) → 3 midpoints, 3 segments.
    expect(candidates.points.filter((p) => p.kind === 'endpoint')).toHaveLength(3)
    expect(candidates.segments).toHaveLength(3)
    expect(candidates.points.filter((p) => p.kind === 'midpoint')).toHaveLength(3)
    // The closing edge (0,10)->(0,0) has midpoint (0,5).
    const mids = candidates.points.filter((p) => p.kind === 'midpoint').map((p) => p.point)
    expect(mids).toContainEqual({ x: 0, y: 5 })
  })

  it('treats a lineal as open: no wrap-around closing edge', () => {
    const line = measurement({
      kind: 'lineal',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    })
    const candidates = collectSnapCandidates([line])
    // 3 vertices, 2 open edges → 2 segments, 2 midpoints (no closing edge).
    expect(candidates.points.filter((p) => p.kind === 'endpoint')).toHaveLength(3)
    expect(candidates.segments).toHaveLength(2)
    expect(candidates.points.filter((p) => p.kind === 'midpoint')).toHaveLength(2)
  })

  it('empty measurements → no candidates', () => {
    const candidates = collectSnapCandidates([])
    expect(candidates.points).toHaveLength(0)
    expect(candidates.segments).toHaveLength(0)
  })

  it('ignores non-board geometries (volume, count, capture, empty)', () => {
    const measurements: TakeoffMeasurement[] = [
      measurement({ kind: 'volume', length: 5, width: 4, height: 3 } as unknown as MeasurementGeometry),
      measurement({ kind: 'count', points: [{ x: 5, y: 5 }] } as unknown as MeasurementGeometry),
      measurement({} as MeasurementGeometry),
      measurement({ kind: 'capture', polygon: [[1, 2]] } as unknown as MeasurementGeometry),
    ]
    const candidates = collectSnapCandidates(measurements)
    expect(candidates.points).toHaveLength(0)
    expect(candidates.segments).toHaveLength(0)
  })

  it('skips degenerate (zero-length) edges — no phantom segment or midpoint', () => {
    const dup = measurement({
      kind: 'lineal',
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
        { x: 15, y: 5 },
      ],
    })
    const candidates = collectSnapCandidates([dup])
    // 3 vertices kept; only the (5,5)->(15,5) edge is real.
    expect(candidates.points.filter((p) => p.kind === 'endpoint')).toHaveLength(3)
    expect(candidates.segments).toEqual([{ a: { x: 5, y: 5 }, b: { x: 15, y: 5 } }])
    expect(candidates.points.filter((p) => p.kind === 'midpoint')).toEqual([
      { kind: 'midpoint', point: { x: 10, y: 5 } },
    ])
  })

  it('drops non-finite vertices but keeps the rest', () => {
    const messy = measurement({
      kind: 'lineal',
      points: [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 5 },
        { x: 20, y: 0 },
      ],
    } as unknown as MeasurementGeometry)
    const candidates = collectSnapCandidates([messy])
    // The NaN vertex is filtered; the surviving (0,0) and (20,0) form one edge.
    expect(candidates.points.filter((p) => p.kind === 'endpoint').map((e) => e.point)).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ])
    expect(candidates.segments).toEqual([{ a: { x: 0, y: 0 }, b: { x: 20, y: 0 } }])
  })
})

// ---------------------------------------------------------------------------
// closestPointOnSegment
// ---------------------------------------------------------------------------

describe('closestPointOnSegment', () => {
  it('projects onto the body of the segment', () => {
    const proj = closestPointOnSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(proj).toEqual({ x: 5, y: 0 })
  })

  it('clamps to the start when the projection falls before a', () => {
    const proj = closestPointOnSegment({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(proj).toEqual({ x: 0, y: 0 })
  })

  it('clamps to the end when the projection falls past b', () => {
    const proj = closestPointOnSegment({ x: 20, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(proj).toEqual({ x: 10, y: 0 })
  })

  it('returns a for a degenerate segment', () => {
    const proj = closestPointOnSegment({ x: 9, y: 9 }, { x: 2, y: 2 }, { x: 2, y: 2 })
    expect(proj).toEqual({ x: 2, y: 2 })
  })
})

// ---------------------------------------------------------------------------
// snapPoint — nearest endpoint / midpoint / on-segment within tolerance
// ---------------------------------------------------------------------------

describe('snapPoint', () => {
  it('snaps to the nearest endpoint within tolerance', () => {
    const index = indexFor([wall()])
    // raw near the (10,10) endpoint
    const result = snapPoint({ x: 10.3, y: 9.8 }, index, 1)
    expect(result.snapped).toBe(true)
    expect(result.kind).toBe('endpoint')
    expect(result.point).toEqual({ x: 10, y: 10 })
  })

  it('snaps to a midpoint when it is the only candidate within tolerance', () => {
    const index = indexFor([wall()])
    // raw near the (20,10) midpoint, far from both endpoints
    const result = snapPoint({ x: 20.2, y: 10.1 }, index, 1)
    expect(result.snapped).toBe(true)
    expect(result.kind).toBe('midpoint')
    expect(result.point).toEqual({ x: 20, y: 10 })
  })

  it('projects onto the nearest segment when a point is off the wall', () => {
    const index = indexFor([wall()])
    // raw is off the wall body at x=15 (between the endpoints, away from the
    // midpoint at 20), 0.5 board units above the wall line y=10.
    const result = snapPoint({ x: 15, y: 9.5 }, index, 1)
    expect(result.snapped).toBe(true)
    expect(result.kind).toBe('segment')
    expect(result.point.x).toBeCloseTo(15, 9)
    expect(result.point.y).toBeCloseTo(10, 9)
  })

  it('returns the raw point unchanged with snapped:false when nothing is within tolerance', () => {
    const index = indexFor([wall()])
    const raw = { x: 80, y: 80 }
    const result = snapPoint(raw, index, 1)
    expect(result.snapped).toBe(false)
    expect(result.kind).toBeNull()
    expect(result.point).toEqual({ x: 80, y: 80 })
  })

  it('empty measurements → never snaps', () => {
    const index = indexFor([])
    const result = snapPoint({ x: 50, y: 50 }, index, 5)
    expect(result.snapped).toBe(false)
    expect(result.kind).toBeNull()
    expect(result.point).toEqual({ x: 50, y: 50 })
  })

  describe('priority ordering when multiple candidates are near', () => {
    it('prefers an endpoint over a closer midpoint', () => {
      const index = indexFor([wall()])
      // Place raw so the midpoint (20,10) is slightly CLOSER than the endpoint
      // (30,10), yet endpoint must still win on priority.
      // dist to midpoint from (24,10) = 4; dist to endpoint (30,10) = 6.
      const result = snapPoint({ x: 24, y: 10 }, index, 8)
      expect(result.kind).toBe('endpoint')
      expect(result.point).toEqual({ x: 30, y: 10 })
    })

    it('prefers a midpoint over a closer on-segment projection', () => {
      const index = indexFor([wall()])
      // raw directly above the midpoint: the on-segment projection is the
      // midpoint itself (dist 0.3), and the midpoint candidate is also 0.3 away.
      // Midpoint must win the tie on priority, reporting kind 'midpoint'.
      const result = snapPoint({ x: 20, y: 9.7 }, index, 1)
      expect(result.kind).toBe('midpoint')
      expect(result.point).toEqual({ x: 20, y: 10 })
    })

    it('picks the nearest endpoint among several within tolerance', () => {
      const index = indexFor([wall()])
      // raw at (26,10): endpoint (30,10) is 4 away, endpoint (10,10) is 16 away.
      const result = snapPoint({ x: 26, y: 10 }, index, 20)
      expect(result.kind).toBe('endpoint')
      expect(result.point).toEqual({ x: 30, y: 10 })
    })
  })

  describe('tolerance boundary', () => {
    it('snaps when just inside tolerance', () => {
      const index = indexFor([wall()])
      // distance from (10,10) is exactly 0.9 (< tolerance 1)
      const result = snapPoint({ x: 10.9, y: 10 }, index, 1)
      expect(result.snapped).toBe(true)
      expect(result.kind).toBe('endpoint')
    })

    it('does NOT snap when just outside tolerance', () => {
      const index = indexFor([wall()])
      // distance from the nearest candidate (endpoint 10,10) is 1.5 (> tol 1);
      // it is also 8.5 from the midpoint, and 1.5 above the segment, so nothing
      // is within a tolerance of 1.
      const result = snapPoint({ x: 10, y: 8.5 }, index, 1)
      expect(result.snapped).toBe(false)
      expect(result.point).toEqual({ x: 10, y: 8.5 })
    })

    it('snaps exactly at the tolerance boundary (inclusive)', () => {
      const index = indexFor([wall()])
      // distance from endpoint (10,10) is exactly 1.0 — inclusive boundary.
      const result = snapPoint({ x: 11, y: 10 }, index, 1)
      expect(result.snapped).toBe(true)
      expect(result.kind).toBe('endpoint')
      expect(result.point).toEqual({ x: 10, y: 10 })
    })

    it('a zero / negative tolerance never snaps', () => {
      const index = indexFor([wall()])
      expect(snapPoint({ x: 10, y: 10 }, index, 0).snapped).toBe(false)
      expect(snapPoint({ x: 10, y: 10 }, index, -1).snapped).toBe(false)
    })
  })

  describe('grid-cell boundary correctness', () => {
    it('finds an endpoint that sits in a different grid cell than the cursor', () => {
      // Endpoint exactly on a cell boundary (SNAP_GRID_CELL = 2 → boundary at
      // x=20). The cursor sits just inside the previous cell; the nearest
      // candidate lives in the next cell. The neighbourhood scan must still
      // find it.
      const m = measurement({
        kind: 'lineal',
        points: [
          { x: 20, y: 20 },
          { x: 40, y: 20 },
        ],
      })
      const index = indexFor([m])
      expect(index.cell).toBe(SNAP_GRID_CELL)
      // cursor at (19.5, 20) is in cell (9,10); the (20,20) endpoint is in cell
      // (10,10). Distance 0.5 < tolerance 1.
      const result = snapPoint({ x: 19.5, y: 20 }, index, 1)
      expect(result.snapped).toBe(true)
      expect(result.kind).toBe('endpoint')
      expect(result.point).toEqual({ x: 20, y: 20 })
    })

    it('projects onto a segment whose body crosses cells its endpoints do not occupy', () => {
      // A long horizontal wall from (1,30) to (39,30) — midpoint at (20,30).
      // With cell size 2 the segment spans ~20 cells in x. A cursor at x=15 is
      // in a cell containing neither endpoint nor the midpoint, yet the segment
      // is indexed into that cell so the on-segment projection still resolves.
      const m = measurement({
        kind: 'lineal',
        points: [
          { x: 1, y: 30 },
          { x: 39, y: 30 },
        ],
      })
      const index = indexFor([m])
      const result = snapPoint({ x: 15, y: 30.4 }, index, 1)
      expect(result.snapped).toBe(true)
      expect(result.kind).toBe('segment')
      expect(result.point.x).toBeCloseTo(15, 9)
      expect(result.point.y).toBeCloseTo(30, 9)
    })

    it('respects tolerance larger than a single cell (radius spans multiple cells)', () => {
      const m = measurement({
        kind: 'lineal',
        points: [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
        ],
      })
      const index = indexFor([m])
      // tolerance 5 spans ~3 cells; an endpoint 4.5 away (>2 the cell size) must
      // still be found.
      const result = snapPoint({ x: 10, y: 5.5 }, index, 5)
      expect(result.snapped).toBe(true)
      expect(result.kind).toBe('endpoint')
      expect(result.point).toEqual({ x: 10, y: 10 })
    })
  })

  it('snaps to the nearest endpoint across two separate measurements', () => {
    const a = measurement({
      kind: 'lineal',
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
    })
    const b = measurement({
      kind: 'lineal',
      points: [
        { x: 60, y: 60 },
        { x: 70, y: 60 },
      ],
    })
    const index = indexFor([a, b])
    const result = snapPoint({ x: 60.4, y: 60.2 }, index, 1)
    expect(result.snapped).toBe(true)
    expect(result.kind).toBe('endpoint')
    expect(result.point).toEqual({ x: 60, y: 60 })
  })
})

// ---------------------------------------------------------------------------
// applyOrtho
// ---------------------------------------------------------------------------

describe('applyOrtho', () => {
  const prev = { x: 10, y: 10 }

  it('locks a near-horizontal segment to dead horizontal', () => {
    // 2° off horizontal → snap y back to prev.y, keep x.
    const raw = { x: 40, y: 11 } // atan2(1,30) ≈ 1.9°
    const locked = applyOrtho(prev, raw, 5)
    expect(locked.x).toBeCloseTo(40, 6)
    expect(locked.y).toBeCloseTo(10, 6)
  })

  it('locks a near-vertical segment to dead vertical', () => {
    const raw = { x: 11, y: 40 } // ~1.9° off vertical
    const locked = applyOrtho(prev, raw, 5)
    expect(locked.x).toBeCloseTo(10, 6)
    expect(locked.y).toBeCloseTo(40, 6)
  })

  it('locks a near-45° segment to a clean diagonal', () => {
    // 47° actual; within 5° of 45° → project onto the 45° line.
    const raw = { x: 10 + 20, y: 10 + 21.5 } // ≈ 47.0°
    const locked = applyOrtho(prev, raw, 5)
    // On the 45° line through prev, x-offset === y-offset.
    expect(locked.x - prev.x).toBeCloseTo(locked.y - prev.y, 6)
  })

  it('locks a near-135° (down-left diagonal) segment', () => {
    // direction up-and-left at ~133° → near the -45°/135° axis.
    const raw = { x: 10 - 20, y: 10 + 21 }
    const locked = applyOrtho(prev, raw, 5)
    // On the 135° line, the x-offset and y-offset are equal-and-opposite.
    expect(locked.x - prev.x).toBeCloseTo(-(locked.y - prev.y), 6)
  })

  it('passes the raw point through when off every axis', () => {
    // 20° off horizontal — beyond a 5° threshold and far from 45°.
    const raw = { x: 40, y: 21 } // atan2(11,30) ≈ 20.1°
    const locked = applyOrtho(prev, raw, 5)
    expect(locked).toEqual(raw)
  })

  it('exactly-horizontal input is unchanged', () => {
    const raw = { x: 50, y: 10 }
    const locked = applyOrtho(prev, raw, 5)
    expect(locked.x).toBeCloseTo(50, 9)
    expect(locked.y).toBeCloseTo(10, 9)
  })

  it('returns raw when prev and raw coincide (no direction)', () => {
    const locked = applyOrtho(prev, { x: 10, y: 10 }, 5)
    expect(locked).toEqual({ x: 10, y: 10 })
  })

  it('a zero / negative threshold passes through (lock disabled)', () => {
    const raw = { x: 40, y: 11 }
    expect(applyOrtho(prev, raw, 0)).toEqual(raw)
    expect(applyOrtho(prev, raw, -3)).toEqual(raw)
  })
})

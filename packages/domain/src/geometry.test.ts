import { describe, it, expect } from 'vitest'
// Import DIRECTLY from the split module — proves geometry.ts is self-contained
// and its public surface is intact after the Blocker 2 extraction.
import {
  slopeFactor,
  roundMeasurement,
  clampBoardCoordinate,
  calculatePolygonArea,
  calculatePolygonAreaScaled,
  calculateLinealLengthScaled,
  calculateGeometryQuantity,
  normalizeGeometry,
  normalizePolygonGeometry,
  normalizeLinealGeometry,
  pointInPolygon,
  segmentsIntersect,
  polygonsOverlap,
  detectDeductionOverlaps,
  type PitchDriver,
  type PolygonGeometry,
} from './geometry.js'
// Import the SAME symbols via the barrel — proves index.ts re-exports them so
// every existing `@sitelayer/domain` import site keeps working (zero churn).
import * as barrel from './index.js'

describe('geometry.ts (Blocker 2 split)', () => {
  describe('slopeFactor (H2)', () => {
    it('6:12 pitch = 1.118 (√180/12)', () => {
      expect(slopeFactor({ rise: 6, run: 12 })).toBeCloseTo(1.118, 3)
      expect(slopeFactor({ rise: 6, run: 12 })).toBeCloseTo(Math.sqrt(180) / 12, 10)
    })

    it('flat / vertical (no pitch) = 1.0', () => {
      expect(slopeFactor(undefined)).toBe(1)
      expect(slopeFactor(null)).toBe(1)
      expect(slopeFactor({ rise: 0, run: 12 })).toBe(1)
    })

    it('12:12 = √2 ≈ 1.414', () => {
      expect(slopeFactor({ rise: 12, run: 12 })).toBeCloseTo(Math.SQRT2, 10)
    })

    it('guards against garbage: run<=0, negative rise, NaN ⇒ 1.0', () => {
      expect(slopeFactor({ rise: 6, run: 0 })).toBe(1)
      expect(slopeFactor({ rise: 6, run: -12 })).toBe(1)
      expect(slopeFactor({ rise: -6, run: 12 })).toBe(1)
      expect(slopeFactor({ rise: Number.NaN, run: 12 })).toBe(1)
      expect(slopeFactor({ rise: 6, run: Number.NaN })).toBe(1)
    })
  })

  describe('barrel re-export parity (zero import-site churn)', () => {
    it('the split symbols are identical through @sitelayer/domain', () => {
      expect(barrel.slopeFactor).toBe(slopeFactor)
      expect(barrel.calculatePolygonArea).toBe(calculatePolygonArea)
      expect(barrel.calculatePolygonAreaScaled).toBe(calculatePolygonAreaScaled)
      expect(barrel.calculateLinealLengthScaled).toBe(calculateLinealLengthScaled)
      expect(barrel.calculateGeometryQuantity).toBe(calculateGeometryQuantity)
      expect(barrel.normalizeGeometry).toBe(normalizeGeometry)
      expect(barrel.roundMeasurement).toBe(roundMeasurement)
      expect(barrel.clampBoardCoordinate).toBe(clampBoardCoordinate)
    })
  })

  describe('pitch applied to scaled area + lineal', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]

    it('calculatePolygonAreaScaled multiplies by the optional slope factor', () => {
      // board area 10000; wx=0.4, wy=0.2 → 800 sqft flat
      expect(calculatePolygonAreaScaled(square, 0.4, 0.2)).toBeCloseTo(800, 4)
      // 6:12 pitch → 800 × 1.118 = ~894.4 sqft
      expect(calculatePolygonAreaScaled(square, 0.4, 0.2, slopeFactor({ rise: 6, run: 12 }))).toBeCloseTo(
        800 * (Math.sqrt(180) / 12),
        4,
      )
      // factor defaults to 1.0 (flat) — legacy 3-arg behavior preserved
      expect(calculatePolygonAreaScaled(square, 0.4, 0.2, 1)).toBeCloseTo(800, 4)
    })

    it('calculateLinealLengthScaled multiplies by the optional slope factor', () => {
      const line = [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ]
      expect(calculateLinealLengthScaled(line, 0.4, 0.2)).toBeCloseTo(20, 6)
      expect(calculateLinealLengthScaled(line, 0.4, 0.2, slopeFactor({ rise: 6, run: 12 }))).toBeCloseTo(
        20 * (Math.sqrt(180) / 12),
        6,
      )
    })

    it('calculateGeometryQuantity applies pitch carried inside the geometry (server write path)', () => {
      const pitch: PitchDriver = { rise: 6, run: 12 }
      const flat: PolygonGeometry = {
        kind: 'polygon',
        points: square,
        world_per_board_x: 0.4,
        world_per_board_y: 0.2,
      }
      const sloped: PolygonGeometry = { ...flat, pitch }
      expect(calculateGeometryQuantity(flat)).toBeCloseTo(800, 2)
      expect(calculateGeometryQuantity(sloped)).toBeCloseTo(800 * (Math.sqrt(180) / 12), 2)
      // 1500 SF footprint → ~1677 SF actual at 6:12 (deep-dive H2 worked example)
      expect(roundMeasurement(1500 * slopeFactor(pitch))).toBeCloseTo(1677, 0)
    })
  })

  describe('normalize carries / sanitizes the optional pitch field', () => {
    it('keeps a valid pitch on polygon + lineal geometry (no migration — inside JSONB)', () => {
      const poly = normalizePolygonGeometry({
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        pitch: { rise: 6, run: 12 },
      })
      expect(poly?.pitch).toEqual({ rise: 6, run: 12 })

      const lin = normalizeLinealGeometry({
        kind: 'lineal',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        pitch: { rise: 8, run: 12 },
      })
      expect(lin?.pitch).toEqual({ rise: 8, run: 12 })
    })

    it('drops an invalid pitch (run<=0 / garbage) so a flat factor is used', () => {
      const poly = normalizePolygonGeometry({
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        pitch: { rise: 6, run: 0 },
      })
      expect(poly?.pitch).toBeUndefined()
    })

    it('absent pitch leaves geometry unchanged (legacy)', () => {
      const g = normalizeGeometry({
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      })
      expect(g && 'pitch' in g).toBe(false)
    })
  })
})

describe('polygon overlap kernel (gap G8: cutout de-dup)', () => {
  const square = (x: number, y: number, s: number) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ]

  describe('pointInPolygon', () => {
    const sq = square(0, 0, 10)
    it('is true for an interior point, false for an exterior one', () => {
      expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true)
      expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false)
    })
    it('is false for < 3 vertices', () => {
      expect(
        pointInPolygon({ x: 1, y: 1 }, [
          { x: 0, y: 0 },
          { x: 2, y: 2 },
        ]),
      ).toBe(false)
    })
  })

  describe('segmentsIntersect', () => {
    it('detects a crossing', () => {
      expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true)
    })
    it('returns false for disjoint segments', () => {
      expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 1, y: 5 })).toBe(false)
    })
    it('detects a collinear touch', () => {
      expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 })).toBe(true)
    })
  })

  describe('polygonsOverlap', () => {
    it('true when polygons cross', () => {
      expect(polygonsOverlap(square(0, 0, 10), square(5, 5, 10))).toBe(true)
    })
    it('true when one fully contains the other (no edge crossings)', () => {
      expect(polygonsOverlap(square(0, 0, 20), square(5, 5, 5))).toBe(true)
    })
    it('false for disjoint polygons', () => {
      expect(polygonsOverlap(square(0, 0, 5), square(20, 20, 5))).toBe(false)
    })
  })

  describe('detectDeductionOverlaps', () => {
    const poly = (s: number, x = 0, y = 0) => ({ kind: 'polygon', points: square(x, y, s) })
    it('flags two overlapping deductions on the same page', () => {
      const pairs = detectDeductionOverlaps([
        { id: 'cut-a', pageId: 'p1', isDeduction: true, geometry: poly(10, 0, 0) },
        { id: 'cut-b', pageId: 'p1', isDeduction: true, geometry: poly(10, 5, 5) },
      ])
      expect(pairs).toHaveLength(1)
      expect(pairs[0]).toMatchObject({ a: 'cut-a', b: 'cut-b', pageId: 'p1' })
    })
    it('does NOT compare deductions on different pages', () => {
      const pairs = detectDeductionOverlaps([
        { id: 'cut-a', pageId: 'p1', isDeduction: true, geometry: poly(10, 0, 0) },
        { id: 'cut-b', pageId: 'p2', isDeduction: true, geometry: poly(10, 5, 5) },
      ])
      expect(pairs).toHaveLength(0)
    })
    it('ignores non-deductions and non-overlapping cutouts', () => {
      const pairs = detectDeductionOverlaps([
        { id: 'wall', pageId: 'p1', isDeduction: false, geometry: poly(50, 0, 0) }, // overlaps both but not a deduction
        { id: 'cut-a', pageId: 'p1', isDeduction: true, geometry: poly(5, 0, 0) },
        { id: 'cut-b', pageId: 'p1', isDeduction: true, geometry: poly(5, 30, 30) }, // disjoint cutout
      ])
      expect(pairs).toHaveLength(0)
    })
    it('skips measurements with non-polygon / missing geometry', () => {
      const pairs = detectDeductionOverlaps([
        { id: 'a', pageId: 'p1', isDeduction: true, geometry: { kind: 'volume', length: 1, width: 1, height: 1 } },
        { id: 'b', pageId: 'p1', isDeduction: true, geometry: null },
      ])
      expect(pairs).toHaveLength(0)
    })
  })
})

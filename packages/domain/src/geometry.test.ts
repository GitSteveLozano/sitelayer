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

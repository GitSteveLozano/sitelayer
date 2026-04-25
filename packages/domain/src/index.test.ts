import { describe, it, expect } from 'vitest'
import {
  formatMoney,
  calculateProjectCost,
  calculateMargin,
  calculateBonusPayout,
  calculatePolygonArea,
  calculatePolygonCentroid,
  calculateTakeoffQuantity,
  clampBoardCoordinate,
  compareBidVsScope,
  DEFAULT_BONUS_RULE,
  normalizePolygonGeometry,
} from './index.js'

describe('domain functions', () => {
  describe('formatMoney', () => {
    it('formats positive currency correctly', () => {
      expect(formatMoney(1234.56)).toBe('$1,234.56')
    })

    it('formats zero correctly', () => {
      expect(formatMoney(0)).toBe('$0.00')
    })

    it('formats negative currency correctly', () => {
      expect(formatMoney(-100.5)).toBe('-$100.50')
    })

    it('formats large amounts correctly', () => {
      expect(formatMoney(1000000)).toBe('$1,000,000.00')
    })
  })

  describe('calculateProjectCost', () => {
    it('sums all cost components', () => {
      const result = calculateProjectCost({
        laborCost: 1000,
        materialCost: 500,
        subCost: 250,
      })
      expect(result).toBe(1750)
    })

    it('handles zero costs', () => {
      const result = calculateProjectCost({
        laborCost: 0,
        materialCost: 0,
        subCost: 0,
      })
      expect(result).toBe(0)
    })

    it('rounds to cents', () => {
      const result = calculateProjectCost({
        laborCost: 100.001,
        materialCost: 50.005,
        subCost: 25.004,
      })
      expect(result).toBe(175.01)
    })
  })

  describe('calculateMargin', () => {
    it('calculates positive margin correctly', () => {
      const result = calculateMargin({
        revenue: 1000,
        cost: 600,
      })
      expect(result.profit).toBe(400)
      expect(result.margin).toBeCloseTo(0.4, 4)
    })

    it('handles zero revenue', () => {
      const result = calculateMargin({
        revenue: 0,
        cost: 500,
      })
      expect(result.profit).toBe(-500)
      expect(result.margin).toBe(0)
    })

    it('handles negative margin', () => {
      const result = calculateMargin({
        revenue: 500,
        cost: 600,
      })
      expect(result.profit).toBe(-100)
      expect(result.margin).toBeLessThan(0)
    })

    it('calculates 50% margin correctly', () => {
      const result = calculateMargin({
        revenue: 1000,
        cost: 500,
      })
      expect(result.margin).toBeCloseTo(0.5, 4)
    })
  })

  describe('calculateBonusPayout', () => {
    it('returns zero when below threshold', () => {
      const result = calculateBonusPayout(0.1, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(false)
      expect(result.payout).toBe(0)
    })

    it('pays at first tier', () => {
      const result = calculateBonusPayout(0.15, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(true)
      expect(result.payout).toBe(400)
    })

    it('pays at second tier', () => {
      const result = calculateBonusPayout(0.2, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(true)
      expect(result.payout).toBe(900)
    })

    it('pays at highest applicable tier', () => {
      const result = calculateBonusPayout(0.3, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(true)
      expect(result.payout).toBe(1900)
    })

    it('handles boundary values at tier min margin', () => {
      const result = calculateBonusPayout(0.149, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(false)
      expect(result.payout).toBe(0)
    })

    it('handles zero bonus pool', () => {
      const result = calculateBonusPayout(0.25, 0, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(true)
      expect(result.payout).toBe(0)
    })
  })

  describe('compareBidVsScope', () => {
    it('reports ok when scope and bid match exactly', () => {
      const result = compareBidVsScope({ bidTotal: 19200, scopeTotal: 19200 })
      expect(result.delta).toBe(0)
      expect(result.delta_pct).toBe(0)
      expect(result.status).toBe('ok')
      expect(result.bid_total).toBe(19200)
      expect(result.scope_total).toBe(19200)
    })

    it('reports ok inside the 1% band', () => {
      // 1% of 19267.50 is 192.675; a 67.50 delta stays comfortably inside.
      const result = compareBidVsScope({ bidTotal: 19267.5, scopeTotal: 19200 })
      expect(result.delta).toBe(67.5)
      expect(result.delta_pct).toBeCloseTo(0.0035, 4)
      expect(result.status).toBe('ok')
    })

    it('reports warn in the 1–5% band', () => {
      // 2% delta.
      const result = compareBidVsScope({ bidTotal: 20000, scopeTotal: 19600 })
      expect(result.delta).toBe(400)
      expect(result.delta_pct).toBeCloseTo(0.02, 4)
      expect(result.status).toBe('warn')
    })

    it('reports mismatch when drift exceeds 5%', () => {
      // 10% delta.
      const result = compareBidVsScope({ bidTotal: 20000, scopeTotal: 18000 })
      expect(result.delta).toBe(2000)
      expect(result.delta_pct).toBeCloseTo(0.1, 4)
      expect(result.status).toBe('mismatch')
    })

    it('treats scope above bid symmetrically (negative delta, still banded by |delta_pct|)', () => {
      const result = compareBidVsScope({ bidTotal: 10000, scopeTotal: 10200 })
      expect(result.delta).toBe(-200)
      expect(result.delta_pct).toBeCloseTo(0.02, 4)
      expect(result.status).toBe('warn')
    })

    it('returns ok/0 for a fully zero bid and zero scope', () => {
      const result = compareBidVsScope({ bidTotal: 0, scopeTotal: 0 })
      expect(result.delta).toBe(0)
      expect(result.delta_pct).toBe(0)
      expect(result.status).toBe('ok')
    })

    it('returns mismatch when bid is zero but scope is non-zero', () => {
      const result = compareBidVsScope({ bidTotal: 0, scopeTotal: 1 })
      expect(result.status).toBe('mismatch')
      expect(result.delta_pct).toBe(1)
    })

    it('coerces non-finite inputs to zero rather than NaN-poisoning the result', () => {
      const result = compareBidVsScope({ bidTotal: Number.NaN, scopeTotal: 500 })
      expect(result.bid_total).toBe(0)
      expect(result.scope_total).toBe(500)
      expect(result.status).toBe('mismatch')
    })
  })

  describe('takeoff geometry', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]

    it('calculates polygon area and takeoff quantity', () => {
      expect(calculatePolygonArea(square)).toBe(100)
      expect(calculateTakeoffQuantity(square, 1.25)).toBe(125)
    })

    it('calculates centroid independent of winding direction', () => {
      expect(calculatePolygonCentroid(square)).toEqual({ x: 5, y: 5 })
      expect(calculatePolygonCentroid([...square].reverse())).toEqual({ x: 5, y: 5 })
    })

    it('clamps board coordinates for pointer input', () => {
      expect(clampBoardCoordinate(-5)).toBe(0)
      expect(clampBoardCoordinate(125)).toBe(100)
      expect(clampBoardCoordinate(42.5)).toBe(42.5)
    })

    it('normalizes valid polygon geometry', () => {
      expect(
        normalizePolygonGeometry({
          kind: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 10.129, y: 0 },
            { x: 10, y: 10 },
          ],
          sheet_scale: '2.5',
          calibration_length: '100',
          calibration_unit: 'feet but this string is intentionally long enough to trim',
        }),
      ).toEqual({
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10.13, y: 0 },
          { x: 10, y: 10 },
        ],
        sheet_scale: 2.5,
        calibration_length: 100,
        calibration_unit: 'feet but this string is intentio',
      })
    })

    it('rejects malformed polygon geometry', () => {
      expect(normalizePolygonGeometry({ kind: 'line', points: square })).toBeNull()
      expect(normalizePolygonGeometry({ kind: 'polygon', points: square.slice(0, 2) })).toBeNull()
      expect(
        normalizePolygonGeometry({
          kind: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 110, y: 0 },
            { x: 0, y: 10 },
          ],
        }),
      ).toBeNull()
    })
  })
})

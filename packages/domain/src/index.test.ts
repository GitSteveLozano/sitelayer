import { describe, it, expect } from 'vitest'
import {
  formatMoney,
  calculateProjectCost,
  calculateMargin,
  calculateBonusPayout,
  DEFAULT_BONUS_RULE,
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
      expect(formatMoney(-100.50)).toBe('-$100.50')
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
      const result = calculateBonusPayout(0.20, 10000, DEFAULT_BONUS_RULE.tiers)
      expect(result.eligible).toBe(true)
      expect(result.payout).toBe(900)
    })

    it('pays at highest applicable tier', () => {
      const result = calculateBonusPayout(0.30, 10000, DEFAULT_BONUS_RULE.tiers)
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
})

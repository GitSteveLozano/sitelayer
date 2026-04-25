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
  normalizeLinealGeometry,
  normalizeVolumeGeometry,
  normalizeGeometry,
  calculateLinealLength,
  calculateLinealQuantity,
  calculateVolumeQuantity,
  calculateGeometryQuantity,
  computeProductivity,
  calculateRentalInvoice,
  initialRentalNextInvoiceAt,
  haversineDistanceMeters,
  isInsideGeofence,
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

  describe('lineal geometry', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 14 },
    ]

    it('calculates the total path length and applies multiplier', () => {
      expect(calculateLinealLength(path)).toBe(15)
      expect(calculateLinealQuantity(path, 2)).toBe(30)
    })

    it('normalizes a valid lineal geometry with >=2 points', () => {
      expect(
        normalizeLinealGeometry({
          kind: 'lineal',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          sheet_scale: '1.5',
          calibration_unit: 'ft',
        }),
      ).toEqual({
        kind: 'lineal',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        sheet_scale: 1.5,
        calibration_unit: 'ft',
      })
    })

    it('rejects lineal geometry with <2 points or out-of-bounds points', () => {
      expect(
        normalizeLinealGeometry({
          kind: 'lineal',
          points: [{ x: 5, y: 5 }],
        }),
      ).toBeNull()
      expect(
        normalizeLinealGeometry({
          kind: 'lineal',
          points: [
            { x: 0, y: 0 },
            { x: 200, y: 50 },
          ],
        }),
      ).toBeNull()
      expect(normalizeLinealGeometry({ kind: 'polygon', points: path })).toBeNull()
    })
  })

  describe('volume geometry', () => {
    it('computes L*W*H', () => {
      expect(calculateVolumeQuantity({ length: 2, width: 3, height: 4 })).toBe(24)
    })

    it('normalizes a valid volume box with positive dims', () => {
      expect(
        normalizeVolumeGeometry({
          kind: 'volume',
          length: 10,
          width: 2,
          height: 3.5,
          unit: 'ft',
        }),
      ).toEqual({
        kind: 'volume',
        length: 10,
        width: 2,
        height: 3.5,
        unit: 'ft',
      })
    })

    it('rejects negative / zero / non-finite dimensions', () => {
      expect(
        normalizeVolumeGeometry({
          kind: 'volume',
          length: -1,
          width: 2,
          height: 3,
        }),
      ).toBeNull()
      expect(
        normalizeVolumeGeometry({
          kind: 'volume',
          length: 0,
          width: 2,
          height: 3,
        }),
      ).toBeNull()
      expect(
        normalizeVolumeGeometry({
          kind: 'volume',
          length: Number.POSITIVE_INFINITY,
          width: 2,
          height: 3,
        }),
      ).toBeNull()
    })
  })

  describe('normalizeGeometry (discriminator)', () => {
    it('dispatches on kind to the right normalizer', () => {
      const polygon = normalizeGeometry({
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      })
      expect(polygon?.kind).toBe('polygon')

      const lineal = normalizeGeometry({
        kind: 'lineal',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
      })
      expect(lineal?.kind).toBe('lineal')

      const volume = normalizeGeometry({
        kind: 'volume',
        length: 2,
        width: 2,
        height: 2,
      })
      expect(volume?.kind).toBe('volume')

      expect(normalizeGeometry({ kind: 'circle', radius: 5 })).toBeNull()
      expect(normalizeGeometry(null)).toBeNull()
    })

    it('dispatches calculateGeometryQuantity correctly', () => {
      expect(
        calculateGeometryQuantity({
          kind: 'volume',
          length: 2,
          width: 3,
          height: 4,
        }),
      ).toBe(24)
      expect(
        calculateGeometryQuantity({
          kind: 'lineal',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        }),
      ).toBe(10)
    })
  })

  describe('computeProductivity', () => {
    it('returns zero metrics for empty input', () => {
      const result = computeProductivity({ entries: [] })
      expect(result.samples).toBe(0)
      expect(result.avg).toBe(0)
      expect(result.p50).toBeNull()
      expect(result.p90).toBeNull()
    })

    it('skips p50/p90 when samples <3', () => {
      const result = computeProductivity({
        entries: [
          { quantity: 100, hours: 2 },
          { quantity: 200, hours: 4 },
        ],
      })
      expect(result.samples).toBe(2)
      expect(result.total_quantity).toBe(300)
      expect(result.total_hours).toBe(6)
      expect(result.avg).toBe(50)
      expect(result.p50).toBeNull()
      expect(result.p90).toBeNull()
    })

    it('computes avg / p50 / p90 across >=3 samples', () => {
      const result = computeProductivity({
        entries: [
          { quantity: 50, hours: 1 },
          { quantity: 40, hours: 1 },
          { quantity: 60, hours: 1 },
          { quantity: 70, hours: 1 },
          { quantity: 100, hours: 1 },
        ],
      })
      expect(result.samples).toBe(5)
      expect(result.avg).toBe(64)
      expect(result.p50).toBe(60)
      expect(result.p90).toBeCloseTo(88, 1)
    })

    it('ignores non-positive or non-finite entries', () => {
      const result = computeProductivity({
        entries: [
          { quantity: 0, hours: 2 },
          { quantity: 50, hours: 0 },
          { quantity: Number.NaN, hours: 2 },
          { quantity: 100, hours: 2 },
          { quantity: 50, hours: 1 },
          { quantity: 30, hours: 1 },
        ],
      })
      expect(result.samples).toBe(3)
      expect(result.total_quantity).toBe(180)
      expect(result.total_hours).toBe(4)
    })
  })

  describe('calculateRentalInvoice', () => {
    it('bills one full cadence window from delivery when no prior invoice exists', () => {
      const result = calculateRentalInvoice(
        {
          daily_rate: 25,
          delivered_on: '2026-04-01',
          returned_on: null,
          invoice_cadence_days: 7,
          last_invoiced_through: null,
        },
        '2026-04-08',
      )
      expect(result.days).toBe(7)
      expect(result.amount).toBe(175)
      expect(result.period_start).toBe('2026-04-01')
      expect(result.period_end).toBe('2026-04-07')
      expect(result.invoiced_through).toBe('2026-04-07')
      expect(result.next_invoice_at).toBe('2026-04-08T00:00:00.000Z')
      expect(result.next_status).toBe('active')
    })

    it('bills only elapsed days when reference date is mid-window', () => {
      const result = calculateRentalInvoice(
        {
          daily_rate: 30,
          delivered_on: '2026-04-01',
          returned_on: null,
          invoice_cadence_days: 7,
          last_invoiced_through: null,
        },
        '2026-04-04',
      )
      // Delivered 2026-04-01 through reference 2026-04-04 = 4 days * 30 = 120
      expect(result.days).toBe(4)
      expect(result.amount).toBe(120)
      expect(result.period_end).toBe('2026-04-04')
    })

    it('returns zero days when delivered_on is in the future', () => {
      const result = calculateRentalInvoice(
        {
          daily_rate: 40,
          delivered_on: '2026-05-01',
          returned_on: null,
          invoice_cadence_days: 7,
          last_invoiced_through: null,
        },
        '2026-04-20',
      )
      expect(result.days).toBe(0)
      expect(result.amount).toBe(0)
      expect(result.next_status).toBe('active')
    })

    it('caps the invoice period at returned_on and closes the rental', () => {
      const result = calculateRentalInvoice(
        {
          daily_rate: 10,
          delivered_on: '2026-04-01',
          returned_on: '2026-04-05',
          invoice_cadence_days: 7,
          last_invoiced_through: null,
        },
        '2026-04-10',
      )
      // 2026-04-01 through 2026-04-05 = 5 days * 10 = 50
      expect(result.days).toBe(5)
      expect(result.amount).toBe(50)
      expect(result.period_end).toBe('2026-04-05')
      expect(result.next_status).toBe('closed')
      expect(result.next_invoice_at).toBeNull()
    })

    it('returns zero days when returned_on precedes the last invoiced period', () => {
      // Item returned 2026-04-04, but we already invoiced through 2026-04-07.
      const result = calculateRentalInvoice(
        {
          daily_rate: 10,
          delivered_on: '2026-04-01',
          returned_on: '2026-04-04',
          invoice_cadence_days: 7,
          last_invoiced_through: '2026-04-07',
        },
        '2026-04-10',
      )
      expect(result.days).toBe(0)
      expect(result.amount).toBe(0)
      expect(result.next_status).toBe('closed')
      expect(result.next_invoice_at).toBeNull()
    })

    it('advances billing after an existing last_invoiced_through value', () => {
      // Previously billed 2026-04-01 through 2026-04-07; reference 2026-04-14
      // -> next period is 2026-04-08 through 2026-04-14 = 7 days.
      const result = calculateRentalInvoice(
        {
          daily_rate: 12,
          delivered_on: '2026-04-01',
          returned_on: null,
          invoice_cadence_days: 7,
          last_invoiced_through: '2026-04-07',
        },
        '2026-04-14',
      )
      expect(result.period_start).toBe('2026-04-08')
      expect(result.period_end).toBe('2026-04-14')
      expect(result.days).toBe(7)
      expect(result.amount).toBe(84)
      expect(result.next_status).toBe('active')
    })

    it('rounds sub-cent amounts to two decimal places', () => {
      const result = calculateRentalInvoice(
        {
          daily_rate: 3.333,
          delivered_on: '2026-04-01',
          returned_on: null,
          invoice_cadence_days: 3,
          last_invoiced_through: null,
        },
        '2026-04-10',
      )
      // 3 days at 3.333 = 9.999 -> rounded to 10.00
      expect(result.days).toBe(3)
      expect(result.amount).toBe(10)
    })
  })

  describe('initialRentalNextInvoiceAt', () => {
    it('sets the first invoice tick cadence_days after delivery', () => {
      expect(initialRentalNextInvoiceAt('2026-04-01', 7)).toBe('2026-04-08T00:00:00.000Z')
    })

    it('defaults to weekly when cadence is invalid', () => {
      expect(initialRentalNextInvoiceAt('2026-04-01', 0)).toBe('2026-04-08T00:00:00.000Z')
    })
  })

  describe('geofence math', () => {
    // Centre chosen near a Winnipeg residential lot; any city-scale
    // lat/lng works the same because construction-site radii (100m) are
    // well inside the regime where spherical earth is accurate to <<1m.
    const site = { lat: 49.8951, lng: -97.1384 }

    it('reports zero distance for identical points', () => {
      expect(haversineDistanceMeters(site, site)).toBe(0)
    })

    it('approximates 1 degree of latitude at ~111 km', () => {
      const oneDegreeNorth = { lat: site.lat + 1, lng: site.lng }
      const distance = haversineDistanceMeters(site, oneDegreeNorth)
      // Allow 0.5% slop for the mean-radius approximation.
      expect(distance).toBeGreaterThan(110_000)
      expect(distance).toBeLessThan(112_000)
    })

    it('accepts a point inside a 100m fence', () => {
      // ~50m north of centre: 50m / 111320 m per degree ~= 0.000449°.
      const nearby = { lat: site.lat + 0.000449, lng: site.lng }
      expect(
        isInsideGeofence({
          lat: site.lat,
          lng: site.lng,
          radius_m: 100,
          point: nearby,
        }),
      ).toBe(true)
    })

    it('rejects a point outside a 100m fence', () => {
      // ~200m north of centre.
      const farAway = { lat: site.lat + 0.001797, lng: site.lng }
      expect(
        isInsideGeofence({
          lat: site.lat,
          lng: site.lng,
          radius_m: 100,
          point: farAway,
        }),
      ).toBe(false)
    })

    it('treats the fence edge as inside (inclusive boundary)', () => {
      // Synthesise a point exactly radius_m away using the measured distance
      // so we do not depend on an analytical earth radius constant here.
      const candidate = { lat: site.lat + 0.000898, lng: site.lng }
      const distance = haversineDistanceMeters(site, candidate)
      expect(
        isInsideGeofence({
          lat: site.lat,
          lng: site.lng,
          radius_m: Math.ceil(distance),
          point: candidate,
        }),
      ).toBe(true)
    })

    it('returns false when radius is zero or negative', () => {
      expect(isInsideGeofence({ lat: site.lat, lng: site.lng, radius_m: 0, point: site })).toBe(false)
      expect(isInsideGeofence({ lat: site.lat, lng: site.lng, radius_m: -50, point: site })).toBe(false)
    })

    it('returns false when centre coordinates are missing', () => {
      expect(
        isInsideGeofence({
          lat: Number.NaN,
          lng: Number.NaN,
          radius_m: 100,
          point: site,
        }),
      ).toBe(false)
    })

    it('handles pole-adjacent centres without NaN-poisoning the result', () => {
      // Near the north pole, 1 degree of latitude is still ~111 km away
      // (polar circumference is unchanged). Confirms haversine stays finite
      // when one endpoint is within a hair of the pole.
      const polar = { lat: 89.999, lng: 0 }
      const polarDeg = { lat: 88.999, lng: 0 }
      const distance = haversineDistanceMeters(polar, polarDeg)
      expect(Number.isFinite(distance)).toBe(true)
      expect(distance).toBeGreaterThan(110_000)
      expect(
        isInsideGeofence({
          lat: polar.lat,
          lng: polar.lng,
          radius_m: 100,
          point: polarDeg,
        }),
      ).toBe(false)
    })

    it('accepts a point exactly at the centre', () => {
      expect(
        isInsideGeofence({
          lat: site.lat,
          lng: site.lng,
          radius_m: 100,
          point: site,
        }),
      ).toBe(true)
    })
  })
})

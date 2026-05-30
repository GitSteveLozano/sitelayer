import { describe, expect, it } from 'vitest'
import { calculateLinealLength } from '@sitelayer/domain'
import { arcPolyline } from './arc'

describe('arcPolyline', () => {
  // Circle centered (50,50), radius 25.
  const center = { x: 50, y: 50 }
  const r = 25

  it('keeps the start and end control points as the polyline endpoints', () => {
    const start = { x: 25, y: 50 }
    const through = { x: 50, y: 75 }
    const end = { x: 75, y: 50 }
    const pts = arcPolyline(start, through, end)
    expect(pts[0]).toEqual(start)
    expect(pts[pts.length - 1]).toEqual(end)
  })

  it('passes through the middle control point at the polyline midpoint', () => {
    const start = { x: 25, y: 50 }
    const through = { x: 50, y: 75 }
    const end = { x: 75, y: 50 }
    const pts = arcPolyline(start, through, end, 24)
    const mid = pts[Math.floor(pts.length / 2)]!
    expect(mid.x).toBeCloseTo(through.x, 1)
    expect(mid.y).toBeCloseTo(through.y, 1)
  })

  it('tessellates a semicircle to ~π·r length', () => {
    const pts = arcPolyline({ x: 25, y: 50 }, { x: 50, y: 75 }, { x: 75, y: 50 }, 48)
    const len = calculateLinealLength(pts)
    expect(len).toBeCloseTo(Math.PI * r, 0) // ≈ 78.5, chord-sum is within ~0.1
    // Every tessellated point lies on the circle.
    for (const p of pts) {
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(r, 1)
    }
  })

  it('chooses the sweep direction from the middle point (above vs below flips the arc)', () => {
    const start = { x: 25, y: 50 }
    const end = { x: 75, y: 50 }
    const lower = arcPolyline(start, { x: 50, y: 75 }, end, 24)
    const upper = arcPolyline(start, { x: 50, y: 25 }, end, 24)
    // The two semicircles bow to opposite sides of the chord (y=50).
    expect(lower[Math.floor(lower.length / 2)]!.y).toBeGreaterThan(60)
    expect(upper[Math.floor(upper.length / 2)]!.y).toBeLessThan(40)
  })

  it('falls back to the straight path for collinear control points', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 10 }
    const c = { x: 20, y: 20 }
    expect(arcPolyline(a, b, c)).toEqual([a, b, c])
  })
})

import { describe, expect, it } from 'vitest'
import { polygonAreaPx2, polygonBbox, polygonPerimeterPx, segmentLengthPx } from '../src/geometry.js'

describe('polygonAreaPx2', () => {
  it('computes a 300×250 rectangle area = 75000', () => {
    const poly = [
      { x: 100, y: 100 },
      { x: 400, y: 100 },
      { x: 400, y: 350 },
      { x: 100, y: 350 },
    ]
    expect(polygonAreaPx2(poly)).toBe(75000)
  })

  it('is order-independent (CCW vs CW)', () => {
    const cw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const ccw = [...cw].reverse()
    expect(polygonAreaPx2(cw)).toBe(100)
    expect(polygonAreaPx2(ccw)).toBe(100)
  })

  it('returns 0 for under-3 vertices', () => {
    expect(polygonAreaPx2([{ x: 0, y: 0 }])).toBe(0)
    expect(
      polygonAreaPx2([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(0)
  })
})

describe('polygonPerimeterPx', () => {
  it('computes a 300×250 rectangle perimeter = 1100', () => {
    const poly = [
      { x: 100, y: 100 },
      { x: 400, y: 100 },
      { x: 400, y: 350 },
      { x: 100, y: 350 },
    ]
    expect(polygonPerimeterPx(poly)).toBe(1100)
  })
})

describe('polygonBbox', () => {
  it('computes a tight AABB', () => {
    const poly = [
      { x: 100, y: 200 },
      { x: 400, y: 100 },
      { x: 350, y: 500 },
      { x: 50, y: 300 },
    ]
    expect(polygonBbox(poly)).toEqual([50, 100, 400, 500])
  })
})

describe('segmentLengthPx', () => {
  it('Euclidean', () => {
    expect(segmentLengthPx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
})

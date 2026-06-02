import { describe, expect, it } from 'vitest'
import { clamp, round2, screenToBoardPoint } from './canvas-math'

describe('clamp', () => {
  it('clamps into the inclusive range', () => {
    expect(clamp(50, 0, 100)).toBe(50)
    expect(clamp(-5, 0, 100)).toBe(0)
    expect(clamp(150, 0, 100)).toBe(100)
    expect(clamp(0, 0, 100)).toBe(0)
    expect(clamp(100, 0, 100)).toBe(100)
  })
})

describe('round2', () => {
  it('rounds to two decimal places', () => {
    expect(round2(1.234)).toBe(1.23)
    expect(round2(1.235)).toBe(1.24)
    expect(round2(10)).toBe(10)
    expect(round2(0.005)).toBe(0.01)
  })
})

describe('screenToBoardPoint', () => {
  // jsdom does not implement getScreenCTM / createSVGPoint, so we mock the SVG
  // element to verify the transform is delegated through the screen CTM inverse
  // exactly as the takeoff canvases did inline.
  function mockSvg(matrix: { a: number; d: number; e: number; f: number } | null) {
    const inverse = matrix
      ? {
          // Inverse of an axis-aligned scale+translate matrix:
          // x' = (x - e) / a, y' = (y - f) / d.
          a: 1 / matrix.a,
          d: 1 / matrix.d,
          e: -matrix.e / matrix.a,
          f: -matrix.f / matrix.d,
        }
      : null
    const ctm = matrix
      ? {
          inverse: () => inverse,
        }
      : null
    return {
      getScreenCTM: () => ctm,
      createSVGPoint: () => ({
        x: 0,
        y: 0,
        matrixTransform(m: { a: number; d: number; e: number; f: number }) {
          return { x: this.x * m.a + m.e, y: this.y * m.d + m.f }
        },
      }),
    } as unknown as SVGSVGElement
  }

  it('returns null when the screen CTM is unavailable', () => {
    expect(screenToBoardPoint(mockSvg(null), 10, 10)).toBeNull()
  })

  it('maps a client point through the inverse screen CTM', () => {
    // Screen CTM scales by 2 and translates by (100, 50): board (10,20) shows at
    // client (120, 90). Inverting (120,90) must recover (10,20).
    const svg = mockSvg({ a: 2, d: 2, e: 100, f: 50 })
    const p = screenToBoardPoint(svg, 120, 90)
    expect(p).not.toBeNull()
    expect(p!.x).toBeCloseTo(10, 9)
    expect(p!.y).toBeCloseTo(20, 9)
  })

  it('is identity for the identity CTM', () => {
    const svg = mockSvg({ a: 1, d: 1, e: 0, f: 0 })
    const p = screenToBoardPoint(svg, 42, 7)
    expect(p!.x).toBeCloseTo(42, 9)
    expect(p!.y).toBeCloseTo(7, 9)
  })
})

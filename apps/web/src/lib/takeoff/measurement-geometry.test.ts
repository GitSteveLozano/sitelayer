import { describe, expect, it } from 'vitest'
import {
  calculateGeometryQuantity,
  calculateLinealLengthScaled,
  calculatePolygonAreaScaled,
  slopeFactor,
} from '@sitelayer/domain'
import { pitchStamp, worldScaleStamp } from './measurement-geometry'
import type { WorldScale } from './world-scale'
import type { PitchDriver } from '@sitelayer/domain'

const SCALE: WorldScale = { wx: 0.4, wy: 0.2, unit: 'ft' }
const PITCH: PitchDriver = { rise: 6, run: 12 }

describe('worldScaleStamp', () => {
  it('stamps per-axis scale when calibrated and the tool applies', () => {
    expect(worldScaleStamp(SCALE, true)).toEqual({ world_per_board_x: 0.4, world_per_board_y: 0.2 })
  })

  it('is a no-op (empty) when the page is uncalibrated', () => {
    expect(worldScaleStamp(null, true)).toEqual({})
  })

  it('is a no-op (empty) when the tool does not apply (e.g. count)', () => {
    expect(worldScaleStamp(SCALE, false)).toEqual({})
  })

  it('spreads cleanly into a geometry object', () => {
    const geometry = { kind: 'polygon', points: [], ...worldScaleStamp(SCALE, true) }
    expect(geometry).toMatchObject({ world_per_board_x: 0.4, world_per_board_y: 0.2 })
    const flat = { kind: 'count', points: [], ...worldScaleStamp(SCALE, false) }
    expect('world_per_board_x' in flat).toBe(false)
  })
})

describe('pitchStamp', () => {
  it('stamps the pitch driver when set and the tool applies', () => {
    expect(pitchStamp(PITCH, true)).toEqual({ pitch: PITCH })
  })

  it('is a no-op (empty) when no pitch is set', () => {
    expect(pitchStamp(null, true)).toEqual({})
  })

  it('is a no-op (empty) when the tool does not apply', () => {
    expect(pitchStamp(PITCH, false)).toEqual({})
  })
})

// End-to-end proof that geometry stamped by the takeoff bodies is read back by
// the SERVER's quantity math (apps/api/src/routes/takeoff-write.ts calls
// `calculateGeometryQuantity`). This is the integration boundary the Phase 2 fix
// closed: before it, the mobile body stamped neither field and silently
// persisted board-space quantities on calibrated/pitched sheets.
describe('stamped geometry → server calculateGeometryQuantity', () => {
  // 10×10 board square (board area 100). With wx=0.4, wy=0.2 → 8 sqft flat.
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]

  it('a calibrated polygon yields true scaled area (not board-space)', () => {
    const geometry = { kind: 'polygon' as const, points: square, ...worldScaleStamp(SCALE, true) }
    const expected = calculatePolygonAreaScaled(square, SCALE.wx, SCALE.wy, 1)
    expect(calculateGeometryQuantity(geometry)).toBeCloseTo(expected, 4)
    // And it differs from the raw board-space area (100) — the bug's signature.
    expect(calculateGeometryQuantity(geometry)).not.toBeCloseTo(100, 1)
  })

  it('a calibrated + pitched polygon applies the slope factor on top of scale', () => {
    const geometry = {
      kind: 'polygon' as const,
      points: square,
      ...worldScaleStamp(SCALE, true),
      ...pitchStamp(PITCH, true),
    }
    const expected = calculatePolygonAreaScaled(square, SCALE.wx, SCALE.wy, slopeFactor(PITCH))
    expect(calculateGeometryQuantity(geometry)).toBeCloseTo(expected, 2)
  })

  it('a calibrated + pitched lineal run yields scaled, slope-corrected length', () => {
    const run = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    const geometry = {
      kind: 'lineal' as const,
      points: run,
      ...worldScaleStamp(SCALE, true),
      ...pitchStamp(PITCH, true),
    }
    const expected = calculateLinealLengthScaled(run, SCALE.wx, SCALE.wy, slopeFactor(PITCH))
    expect(calculateGeometryQuantity(geometry)).toBeCloseTo(expected, 2)
  })

  it('an unstamped polygon falls back to board-space area (the legacy path)', () => {
    const geometry = { kind: 'polygon' as const, points: square }
    expect(calculateGeometryQuantity(geometry)).toBeCloseTo(100, 4)
  })
})

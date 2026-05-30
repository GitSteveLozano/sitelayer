import { describe, expect, it } from 'vitest'
import type { BlueprintPage } from '@/lib/api'
import { solveWorldScale } from './world-scale'

function page(cal: Partial<BlueprintPage>): BlueprintPage {
  return {
    calibration_x1: null,
    calibration_y1: null,
    calibration_x2: null,
    calibration_y2: null,
    calibration_world_distance: null,
    calibration_world_unit: null,
    ...cal,
  } as BlueprintPage
}

describe('solveWorldScale', () => {
  it('returns null when uncalibrated or page size unknown', () => {
    expect(solveWorldScale(page({}), 200, 100)).toBeNull()
    expect(
      solveWorldScale(
        page({
          calibration_x1: '0',
          calibration_y1: '0',
          calibration_x2: '50',
          calibration_y2: '0',
          calibration_world_distance: '20',
        }),
        null,
        100,
      ),
    ).toBeNull()
  })

  it('square page: 50 board-x units = 25ft → 0.5 ft per board unit on both axes', () => {
    const s = solveWorldScale(
      page({
        calibration_x1: '0',
        calibration_y1: '0',
        calibration_x2: '50',
        calibration_y2: '0',
        calibration_world_distance: '25',
        calibration_world_unit: 'ft',
      }),
      100,
      100,
    )
    expect(s).not.toBeNull()
    expect(s!.wx).toBeCloseTo(0.5, 6)
    expect(s!.wy).toBeCloseTo(0.5, 6)
    expect(s!.unit).toBe('ft')
    // a full-page board square is 50ft × 50ft = 2500 sqft
    expect(10000 * s!.wx * s!.wy).toBeCloseTo(2500, 4)
  })

  it('anisotropic page (2:1): horizontal 50-unit line = 20ft → wx=0.4, wy=0.2', () => {
    const s = solveWorldScale(
      page({
        calibration_x1: '0',
        calibration_y1: '0',
        calibration_x2: '50',
        calibration_y2: '0',
        calibration_world_distance: '20',
        calibration_world_unit: 'ft',
      }),
      200,
      100,
    )
    expect(s).not.toBeNull()
    expect(s!.wx).toBeCloseTo(0.4, 6)
    expect(s!.wy).toBeCloseTo(0.2, 6)
    // full-page board square = 40ft × 20ft = 800 sqft
    expect(10000 * s!.wx * s!.wy).toBeCloseTo(800, 4)
  })

  it('solves consistently for a diagonal calibration line', () => {
    // 2:1 page, line (10,10)->(60,40): Δbx=50, Δby=30, aspect=2.
    // denom=√((50·2)²+30²)=√(10000+900)=√10900≈104.403; world=50ft.
    const s = solveWorldScale(
      page({
        calibration_x1: '10',
        calibration_y1: '10',
        calibration_x2: '60',
        calibration_y2: '40',
        calibration_world_distance: '50',
        calibration_world_unit: 'ft',
      }),
      200,
      100,
    )
    expect(s).not.toBeNull()
    const wy = 50 / Math.sqrt(100 * 100 + 30 * 30)
    expect(s!.wy).toBeCloseTo(wy, 9)
    expect(s!.wx).toBeCloseTo(2 * wy, 9)
  })
})

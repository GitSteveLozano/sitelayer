import { describe, it, expect } from 'vitest'
import { droneConfidenceFromGsd } from '@sitelayer/capture-schema'

describe('droneConfidenceFromGsd', () => {
  it('returns 1.0 at GSD 2 cm with reconstructor confidence 1.0', () => {
    expect(droneConfidenceFromGsd(1.0, 2.0)).toBeCloseTo(1.0, 6)
  })

  it('returns 0.5 at GSD 4 cm with reconstructor confidence 1.0', () => {
    expect(droneConfidenceFromGsd(1.0, 4.0)).toBeCloseTo(0.5, 6)
  })

  it('clamps to reconstructor confidence at GSD <= 2 cm', () => {
    expect(droneConfidenceFromGsd(0.7, 1.0)).toBeCloseTo(0.7, 6)
    expect(droneConfidenceFromGsd(0.7, 2.0)).toBeCloseTo(0.7, 6)
  })
})

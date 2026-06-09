import { describe, expect, it } from 'vitest'
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

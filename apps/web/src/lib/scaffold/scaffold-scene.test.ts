import { describe, expect, it } from 'vitest'
import { generateScaffoldModel } from '@sitelayer/domain'
import { buildScaffoldScene, colorForRole, MM_PER_FOOT } from './scaffold-scene'

const spec = {
  baysAlongLength: 2,
  baysAlongWidth: 1,
  bayLengthMm: 2500,
  bayWidthMm: 1000,
  liftHeightMm: 2000,
  lifts: 2,
}

describe('buildScaffoldScene', () => {
  it('maps every member to a segment with a role color', () => {
    const model = generateScaffoldModel(spec)
    const scene = buildScaffoldScene(model)
    expect(scene.segments).toHaveLength(model.members.length)
    for (const seg of scene.segments) {
      expect(seg.color).toBe(colorForRole(seg.role))
    }
  })

  it('converts mm→feet, centers the footprint, and keeps the base on the ground', () => {
    const model = generateScaffoldModel(spec)
    const scene = buildScaffoldScene(model)
    // Footprint 5000mm × 1000mm → centered: x ∈ [-8.2, 8.2] ft, z ∈ [-1.64, 1.64] ft.
    const xs = scene.segments.flatMap((s) => [s.a.x, s.b.x])
    const ys = scene.segments.flatMap((s) => [s.a.y, s.b.y])
    expect(Math.min(...xs)).toBeCloseTo(-2500 / MM_PER_FOOT)
    expect(Math.max(...xs)).toBeCloseTo(2500 / MM_PER_FOOT)
    // Base on the ground (y is up): lowest point is 0.
    expect(Math.min(...ys)).toBeCloseTo(0)
    // Top of 2 lifts × 2000mm = 4000mm.
    expect(Math.max(...ys)).toBeCloseTo(4000 / MM_PER_FOOT)
    expect(scene.spanFt).toBeCloseTo(5000 / MM_PER_FOOT)
    expect(scene.heightFt).toBeCloseTo(4000 / MM_PER_FOOT)
  })
})

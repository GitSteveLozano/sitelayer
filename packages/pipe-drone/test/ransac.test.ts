import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { segmentPlane, segmentMultiplePlanes, planeAreaFromInliers, type Vec3 } from '../src/ransac.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(__dirname, '../fixtures/sample-pointcloud-two-planes.json')
const fixture: { _meta: { planes: Array<{ id: string; normal: Vec3 }> }; points: Vec3[] } = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
)

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

describe('segmentPlane', () => {
  it('extracts a single plane whose normal is close to a truth plane', () => {
    const plane = segmentPlane(fixture.points, {
      distanceThresholdM: 0.08,
      iterations: 800,
      minInliers: 100,
      rngSeed: 0xbeef,
    })
    expect(plane).not.toBeNull()
    const n = plane!.normalVec
    // The first plane RANSAC finds may be either truth plane. Take the
    // strongest absolute alignment.
    const truths = fixture._meta.planes.map((p) => p.normal)
    const alignments = truths.map((t) => Math.abs(dot(n, t)))
    const bestAlignment = Math.max(...alignments)
    expect(bestAlignment).toBeGreaterThan(0.99)
    expect(plane!.inlierIndices.length).toBeGreaterThan(150)
  })
})

describe('segmentMultiplePlanes', () => {
  it('extracts both truth planes from the fixture', () => {
    const planes = segmentMultiplePlanes(fixture.points, {
      distanceThresholdM: 0.08,
      iterations: 800,
      minInliers: 100,
      maxPlanes: 4,
      rngSeed: 0xbeef,
    })
    expect(planes.length).toBeGreaterThanOrEqual(2)
    // For each truth plane, find a recovered plane whose |normal · truth| > 0.99.
    for (const t of fixture._meta.planes) {
      const matched = planes.some((p) => Math.abs(dot(p.normalVec, t.normal)) > 0.99)
      expect(matched, `no recovered plane matches truth ${t.id}`).toBe(true)
    }
  })

  it('inliers are partitioned across recovered planes (no duplicates)', () => {
    const planes = segmentMultiplePlanes(fixture.points, {
      distanceThresholdM: 0.08,
      iterations: 800,
      minInliers: 100,
      maxPlanes: 4,
      rngSeed: 0xbeef,
    })
    const seen = new Set<number>()
    let total = 0
    for (const p of planes) {
      for (const i of p.inlierIndices) {
        expect(seen.has(i), `index ${i} duplicated across planes`).toBe(false)
        seen.add(i)
        total++
      }
    }
    expect(total).toBe(seen.size)
  })
})

describe('planeAreaFromInliers', () => {
  it('returns plausible pitch close to 30°', () => {
    const planes = segmentMultiplePlanes(fixture.points, {
      distanceThresholdM: 0.08,
      iterations: 800,
      minInliers: 100,
      maxPlanes: 4,
      rngSeed: 0xbeef,
    })
    expect(planes.length).toBeGreaterThanOrEqual(2)
    for (const p of planes.slice(0, 2)) {
      const m = planeAreaFromInliers(p, fixture.points)
      // Truth pitch is 30°. RANSAC ± noise → expect within ~5°.
      expect(m.pitchDegrees).toBeGreaterThan(20)
      expect(m.pitchDegrees).toBeLessThan(40)
      expect(m.areaSqM).toBeGreaterThan(0)
    }
  })
})

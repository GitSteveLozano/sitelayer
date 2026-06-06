import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildTakeoffFromLabeledMesh, parseLabeledMesh } from '../src/index.js'
import { validateTakeoffResult } from '@sitelayer/capture-schema'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(__dirname, '..', 'fixtures', 'sample-labeled-mesh.json')

const fixtureRaw = JSON.parse(readFileSync(fixturePath, 'utf8'))
const fixture = parseLabeledMesh(fixtureRaw)

describe('buildTakeoffFromLabeledMesh', () => {
  const takeoff = buildTakeoffFromLabeledMesh({
    labeledMesh: fixture,
    projectId: 'spike-001',
    takeoffId: '11111111-1111-4111-8111-111111111111',
    producedAt: '2026-05-07T15:01:00Z',
  })

  it('validates against the contract schema', () => {
    expect(() => validateTakeoffResult(takeoff)).not.toThrow()
  })

  it('emits source = photogrammetry and units = imperial', () => {
    expect(takeoff.source).toBe('photogrammetry')
    expect(takeoff.units).toBe('imperial')
  })

  it('populates sourceArtifact.kind = photogrammetry with mesh metadata', () => {
    expect(takeoff.sourceArtifact?.kind).toBe('photogrammetry')
    if (takeoff.sourceArtifact?.kind === 'photogrammetry') {
      expect(takeoff.sourceArtifact.photogrammetry.meshUrl).toBe(fixture.meshUrl)
      expect(takeoff.sourceArtifact.photogrammetry.vendor).toBe('luma')
      expect(takeoff.sourceArtifact.photogrammetry.scale.method).toBe('fiducial-marker')
    }
  })

  it('floor area is within ±1% of 168 sqft', () => {
    const floor = takeoff.quantities.find((q) => q.id === 'q-room-bedroom-floor')
    expect(floor).toBeDefined()
    expect(floor!.unit).toBe('sqft')
    expect(floor!.uniformatCode).toBe('B3010')
    const value = floor!.value
    expect(value).toBeGreaterThan(168 * 0.99)
    expect(value).toBeLessThan(168 * 1.01)
  })

  it('drywall area ≈ (perimeter*height) − openings in sqft', () => {
    // perimeter 52 ft, height 8 ft → 416 sqft
    // door 32x96 in = 21.333 sqft, window 36x48 in = 12 sqft → 21.333+12 = 33.333
    // expected ≈ 416 − 33.333 = 382.667 sqft (within ~1% of metric-derived value)
    const drywall = takeoff.quantities.find((q) => q.id === 'q-room-bedroom-drywall')
    expect(drywall).toBeDefined()
    expect(drywall!.unit).toBe('sqft')
    expect(drywall!.masterformatCode).toBe('09 29 00')
    const expected = 416 - (32 * 96) / 144 - (36 * 48) / 144
    const diff = Math.abs(drywall!.value - expected)
    // ±2% tolerance to absorb the imperial→metric conversion in the fixture.
    expect(diff / expected).toBeLessThan(0.02)
  })

  it('emits doors and windows as ea counts', () => {
    const doors = takeoff.quantities.find((q) => q.id === 'q-room-bedroom-doors')
    const windows = takeoff.quantities.find((q) => q.id === 'q-room-bedroom-windows')
    expect(doors).toBeDefined()
    expect(doors!.unit).toBe('ea')
    expect(doors!.value).toBe(1)
    expect(windows).toBeDefined()
    expect(windows!.unit).toBe('ea')
    expect(windows!.value).toBe(1)
  })

  it('provenance is photogrammetry with meshId and vendorJobId', () => {
    for (const q of takeoff.quantities) {
      expect(q.provenance.kind).toBe('photogrammetry')
      if (q.provenance.kind === 'photogrammetry') {
        expect(q.provenance.meshId).toBe('cap-bedroom-12x14')
        expect(q.provenance.vendorJobId).toBe('luma-slug-bedroom-12x14')
      }
    }
  })

  it('all confidences ≤ 0.7 → reviewRequired = true', () => {
    for (const q of takeoff.quantities) {
      expect(q.confidence).toBeLessThanOrEqual(0.7)
    }
    expect(takeoff.reviewRequired).toBe(true)
  })

  it('includes geometry rooms and surfaces for the review UI', () => {
    expect(takeoff.geometry?.rooms?.length).toBe(1)
    const room = takeoff.geometry?.rooms?.[0]
    expect(room?.id).toBe('room-bedroom')
    expect(room?.floorAreaSqFt).toBeCloseTo(168, 0)
    const surfaces = takeoff.geometry?.surfaces ?? []
    expect(surfaces.some((s) => s.kind === 'wall')).toBe(true)
    expect(surfaces.some((s) => s.kind === 'floor')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { buildDroneTakeoff } from '../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sidecarPath = resolve(__dirname, '../fixtures/sample-house-sidecar.json')

describe('buildDroneTakeoff (Path B sidecar)', () => {
  it('emits a valid TakeoffResult', async () => {
    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      sidecarPath,
      altitudeM: 80,
      capturedAt: '2026-05-07T12:00:00Z',
      producedAtOverride: '2026-05-07T12:30:00Z',
    })
    expect(r.schemaVersion).toBe('1.0.0')
    expect(r.source).toBe('drone.photogrammetry')
    expect(r.units).toBe('imperial')
    expect(r.quantities.length).toBeGreaterThan(0)
  })

  it('roof shingle quantities sum to ~1200 sqft', async () => {
    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      sidecarPath,
      altitudeM: 80,
    })
    const roof = r.quantities.filter((q) => q.masterformatCode === '07 31 13')
    const sumSqft = roof.reduce((acc, q) => acc + q.value, 0)
    expect(sumSqft).toBeGreaterThan(1100)
    expect(sumSqft).toBeLessThan(1300)
  })

  it('includes at least one cut/fill quantity in cy', async () => {
    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      sidecarPath,
      altitudeM: 80,
    })
    const grading = r.quantities.filter((q) => q.masterformatCode === '31 22 00' && q.unit === 'cy')
    expect(grading.length).toBeGreaterThanOrEqual(1)
    const total = grading.reduce((acc, q) => acc + q.value, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('attaches drone provenance with orthomosaicId on every quantity', async () => {
    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      sidecarPath,
      altitudeM: 80,
    })
    for (const q of r.quantities) {
      expect(q.provenance.kind).toBe('drone')
      if (q.provenance.kind === 'drone') {
        expect(q.provenance.orthomosaicId).toBeTruthy()
        expect(q.provenance.altitudeM).toBe(80)
      }
    }
  })

  it('attaches the parsed sidecar as sourceArtifact.drone', async () => {
    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      sidecarPath,
    })
    expect(r.sourceArtifact?.kind).toBe('drone')
    if (r.sourceArtifact?.kind === 'drone') {
      expect(r.sourceArtifact.drone.buildings.length).toBe(1)
      expect(r.sourceArtifact.drone.buildings[0]?.id).toBe('bldg-1')
    }
  })
})

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  parseOdmReport,
  OdmReportValidationError,
  droneSidecarFromOdmReport,
  coverageAreaSqm,
  coverageConfidence,
  averageGsdCm,
  DEFAULT_RECONSTRUCTOR_CONFIDENCE,
} from '../src/odm-report.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const reportPath = resolve(__dirname, '../fixtures/sample-odm-report.json')

async function loadReport(): Promise<unknown> {
  return JSON.parse(await readFile(reportPath, 'utf8')) as unknown
}

const SQM_TO_SQFT = 10.7639104167

describe('parseOdmReport', () => {
  it('validates a realistic ODM report fixture', async () => {
    const report = parseOdmReport(await loadReport())
    expect(report.processing_statistics?.area).toBeCloseTo(1858.0606, 3)
    expect(report.odm_processing_statistics?.average_gsd).toBe(2.4)
    expect(report.reconstruction_statistics?.reconstructed_shots_count).toBe(124)
  })

  it('tolerates unknown extra keys (passthrough)', () => {
    const r = parseOdmReport({
      processing_statistics: { area: 100, average_gsd: 2 },
      some_future_key: { nested: true },
    })
    expect(r.processing_statistics?.area).toBe(100)
  })

  it('accepts a minimal report carrying only average_gsd', () => {
    const r = parseOdmReport({ odm_processing_statistics: { average_gsd: 3.0 } })
    expect(r.odm_processing_statistics?.average_gsd).toBe(3.0)
  })

  it('throws OdmReportValidationError on the wrong shape', () => {
    expect(() => parseOdmReport({ processing_statistics: { area: 'not-a-number' } })).toThrow(OdmReportValidationError)
  })
})

describe('averageGsdCm', () => {
  it('prefers the ODM augmentation over OpenSfM', () => {
    const r = parseOdmReport({
      processing_statistics: { average_gsd: 5 },
      odm_processing_statistics: { average_gsd: 2.4 },
    })
    expect(averageGsdCm(r)).toBe(2.4)
  })

  it('falls back to OpenSfM processing_statistics', () => {
    const r = parseOdmReport({ processing_statistics: { average_gsd: 3.1 } })
    expect(averageGsdCm(r)).toBe(3.1)
  })

  it('returns undefined when no GSD present', () => {
    const r = parseOdmReport({ reconstruction_statistics: { reconstructed_shots_count: 10 } })
    expect(averageGsdCm(r)).toBeUndefined()
  })
})

describe('coverageAreaSqm', () => {
  it('prefers the explicit processing_statistics.area', async () => {
    const r = parseOdmReport(await loadReport())
    expect(coverageAreaSqm(r)).toBeCloseTo(1858.0606, 3)
  })

  it('falls back to the native point-cloud bbox XY extent', () => {
    const r = parseOdmReport({
      point_cloud_statistics: {
        stats: {
          bbox: {
            native: { bbox: { minx: 0, miny: 0, minz: 0, maxx: 10, maxy: 5, maxz: 3 } },
          },
        },
      },
    })
    // 10 * 5 = 50 m^2
    expect(coverageAreaSqm(r)).toBeCloseTo(50, 6)
  })

  it('returns undefined when neither area nor bbox is present', () => {
    const r = parseOdmReport({ reconstruction_statistics: { reconstructed_shots_count: 1 } })
    expect(coverageAreaSqm(r)).toBeUndefined()
  })
})

describe('coverageConfidence', () => {
  it('matches droneConfidenceFromGsd(0.85, gsd)', async () => {
    const r = parseOdmReport(await loadReport())
    // 0.85 * min(1, 2/2.4) = 0.708333…
    expect(coverageConfidence(r)).toBeCloseTo(0.85 * Math.min(1, 2 / 2.4), 6)
  })

  it('honours a reconstructorConfidence override', async () => {
    const r = parseOdmReport(await loadReport())
    expect(coverageConfidence(r, { reconstructorConfidence: 1.0 })).toBeCloseTo(Math.min(1, 2 / 2.4), 6)
  })

  it('floors to 0 when GSD is missing', () => {
    const r = parseOdmReport({ processing_statistics: { area: 100 } })
    expect(coverageConfidence(r)).toBe(0)
  })

  it('uses the documented default reconstructor confidence', () => {
    expect(DEFAULT_RECONSTRUCTOR_CONFIDENCE).toBe(0.85)
  })
})

describe('droneSidecarFromOdmReport', () => {
  it('derives a single site-coverage building with footprint area in sqft', async () => {
    const r = parseOdmReport(await loadReport())
    const sidecar = droneSidecarFromOdmReport(r, {
      siteCenter: { lat: 43.65, lon: -79.38 },
      crs: 'EPSG:32617',
    })
    expect(sidecar.buildings).toHaveLength(1)
    const b = sidecar.buildings[0]!
    expect(b.id).toBe('site-coverage')
    expect(b.footprintAreaSqft).toBeCloseTo(1858.0606 * SQM_TO_SQFT, 2)
    expect(b.roofPlanes).toHaveLength(0) // raster boundary — no fabricated planes
    expect(sidecar.reconstruction.engine).toBe('ODM')
    expect(sidecar.reconstruction.gsdCm).toBe(2.4)
    expect(sidecar.reconstruction.imageCount).toBe(124)
    expect(sidecar.crs).toBe('EPSG:32617')
    expect(sidecar.siteCenter).toEqual({ lat: 43.65, lon: -79.38 })
  })

  it('uses a placeholder gsd of 99 (low confidence) when GSD is absent but area present', () => {
    const r = parseOdmReport({
      point_cloud_statistics: {
        stats: { bbox: { native: { bbox: { minx: 0, miny: 0, maxx: 10, maxy: 10 } } } },
      },
    })
    const sidecar = droneSidecarFromOdmReport(r)
    expect(sidecar.reconstruction.gsdCm).toBe(99)
    expect(sidecar.buildings[0]!.footprintAreaSqft).toBeCloseTo(100 * SQM_TO_SQFT, 2)
  })

  it('defaults siteCenter to 0,0 and crs to unknown when not supplied', () => {
    const r = parseOdmReport({ processing_statistics: { area: 50, average_gsd: 2 } })
    const sidecar = droneSidecarFromOdmReport(r)
    expect(sidecar.siteCenter).toEqual({ lat: 0, lon: 0 })
    expect(sidecar.crs).toBe('unknown')
  })

  it('throws when the report has neither GSD nor area', () => {
    const r = parseOdmReport({ reconstruction_statistics: { reconstructed_shots_count: 5 } })
    expect(() => droneSidecarFromOdmReport(r)).toThrow(/nothing real to extract/)
  })

  it('produces a contract-valid GeoJSON Polygon footprint (degenerate anchor)', () => {
    const r = parseOdmReport({ processing_statistics: { area: 50, average_gsd: 2 } })
    const sidecar = droneSidecarFromOdmReport(r, { siteCenter: { lat: 1, lon: 2 } })
    const ring = sidecar.buildings[0]!.footprint.coordinates[0]!
    expect(ring.length).toBeGreaterThanOrEqual(4)
    expect(ring[0]).toEqual([2, 1]) // [lon, lat]
  })
})

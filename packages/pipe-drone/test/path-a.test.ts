import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDroneTakeoff, takeoffFromOdmReport } from '../src/index.js'
import { parseOdmReport, type OdmReport } from '../src/odm-report.js'
import { validateTakeoffResult } from '@sitelayer/capture-schema'

const __dirname = dirname(fileURLToPath(import.meta.url))
const reportPath = resolve(__dirname, '../fixtures/sample-odm-report.json')

async function loadReport(): Promise<OdmReport> {
  return parseOdmReport(JSON.parse(await readFile(reportPath, 'utf8')) as unknown)
}

const SQM_TO_SQFT = 10.7639104167

// ─── takeoffFromOdmReport (pure emit) ─────────────────────────────────────

describe('takeoffFromOdmReport', () => {
  it('emits a valid, review-required TakeoffResult with a site-coverage quantity', async () => {
    const report = await loadReport()
    const r = takeoffFromOdmReport(
      report,
      { siteCenter: { lat: 43.65, lon: -79.38 }, crs: 'EPSG:32617', orthoUrl: 'file:///out/ortho.tif' },
      {
        projectId: 'spike-001',
        altitudeM: 80,
        capturedAt: '2026-05-07T12:00:00Z',
        producedAtOverride: '2026-05-07T12:30:00Z',
      },
    )

    // Re-validation is a no-op double-check that the emit path is contract-clean.
    expect(() => validateTakeoffResult(r)).not.toThrow()

    expect(r.source).toBe('drone.photogrammetry')
    expect(r.units).toBe('imperial')
    expect(r.reviewRequired).toBe(true)
    expect(r.quantities).toHaveLength(1)

    const q = r.quantities[0]!
    expect(q.id).toBe('q-site-coverage')
    expect(q.uniformatCode).toBe('G1010')
    expect(q.unit).toBe('sqft')
    expect(q.value).toBeCloseTo(1858.0606 * SQM_TO_SQFT, 1)
    expect(q.confidence).toBeCloseTo(0.85 * Math.min(1, 2 / 2.4), 5)
    expect(q.provenance.kind).toBe('drone')
    if (q.provenance.kind === 'drone') {
      expect(q.provenance.orthomosaicId).toBeTruthy()
      expect(q.provenance.altitudeM).toBe(80)
    }
  })

  it('attaches the derived sidecar as sourceArtifact.drone and a coverage surface', async () => {
    const report = await loadReport()
    const r = takeoffFromOdmReport(report, {}, { projectId: 'p' })
    expect(r.sourceArtifact?.kind).toBe('drone')
    if (r.sourceArtifact?.kind === 'drone') {
      expect(r.sourceArtifact.drone.buildings).toHaveLength(1)
      expect(r.sourceArtifact.drone.buildings[0]?.id).toBe('site-coverage')
    }
    const surf = r.geometry?.surfaces?.find((s) => s.id === 'site-coverage-footprint')
    expect(surf?.areaSqFt).toBeCloseTo(1858.0606 * SQM_TO_SQFT, 1)
    expect(r.geometry?.rasterRefs?.[0]?.mime).toBe('image/tiff')
  })

  it('emits the odm_report_coverage_only boundary warning', async () => {
    const report = await loadReport()
    const r = takeoffFromOdmReport(report, {}, { projectId: 'p' })
    const w = r.warnings?.find((x) => x.code === 'odm_report_coverage_only')
    expect(w).toBeDefined()
    expect(w?.message).toMatch(/raster extractor/i)
  })

  it('throws when coverage area is non-positive', () => {
    // average_gsd present (so droneSidecarFromOdmReport does not throw) but no area.
    const report = parseOdmReport({ processing_statistics: { average_gsd: 2.0 } })
    expect(() => takeoffFromOdmReport(report, {}, { projectId: 'p' })).toThrow(/no positive coverage area/)
  })
})

// ─── buildDroneTakeoff Path A (mocked NodeODM, end-to-end) ────────────────

describe('buildDroneTakeoff Path A (live NodeODM, mocked transport)', () => {
  let imagesDir: string

  beforeEach(async () => {
    imagesDir = await mkdtemp(join(tmpdir(), 'pipe-drone-pathA-'))
    // One dummy image so the upload loop has something to send.
    await writeFile(join(imagesDir, 'IMG_0001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    vi.spyOn(globalThis, 'fetch')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(imagesDir, { recursive: true, force: true })
  })

  it('runs upload→commit→poll→download→report-extract and emits a coverage TakeoffResult', async () => {
    const reportJson = await readFile(reportPath, 'utf8')

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/task/new/init')) {
        return new Response(JSON.stringify({ uuid: 'task-xyz' }), { status: 200 })
      }
      if (url.includes('/task/new/upload/')) {
        return new Response('{}', { status: 200 })
      }
      if (url.includes('/task/new/commit/')) {
        return new Response('{}', { status: 200 })
      }
      if (url.includes('/info')) {
        return new Response(JSON.stringify({ uuid: 'task-xyz', status: { code: 40 }, progress: 100 }), {
          status: 200,
        })
      }
      if (url.includes('/download/odm_report/stats.json')) {
        return new Response(reportJson, { status: 200 })
      }
      if (url.includes('/download/')) {
        // Raster asset downloads (orthophoto.tif, dsm.tif, ...) — stream a stub blob.
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      throw new Error(`unexpected fetch url in test: ${url}`)
    })

    const r = await buildDroneTakeoff({
      projectId: 'spike-001',
      imagesDir,
      nodeOdmUrl: 'http://nodeodm.test:3000',
      altitudeM: 80,
      takeoffIdOverride: '11111111-1111-4111-8111-111111111111',
      producedAtOverride: '2026-05-07T12:30:00Z',
      capturedAt: '2026-05-07T12:00:00Z',
    })

    expect(r.source).toBe('drone.photogrammetry')
    expect(r.reviewRequired).toBe(true)
    expect(r.quantities.find((q) => q.id === 'q-site-coverage')?.value).toBeCloseTo(1858.0606 * SQM_TO_SQFT, 1)
    // raster URLs threaded into the derived sidecar artifacts
    if (r.sourceArtifact?.kind === 'drone') {
      expect(r.sourceArtifact.drone.artifacts.dsmUrl).toMatch(/dsm\.tif$/)
    }
  })

  it('throws a clear error when NodeODM completes but emits no report', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/task/new/init')) return new Response(JSON.stringify({ uuid: 'u' }), { status: 200 })
      if (url.includes('/info'))
        return new Response(JSON.stringify({ status: { code: 40 }, progress: 100 }), { status: 200 })
      if (url.includes('/download/odm_report/stats.json')) return new Response('not found', { status: 404 })
      return new Response('{}', { status: 200 })
    })

    await expect(
      buildDroneTakeoff({ projectId: 'p', imagesDir, nodeOdmUrl: 'http://nodeodm.test:3000' }),
    ).rejects.toThrow(/did not produce/)
  })

  it('throws when the NodeODM task fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/task/new/init')) return new Response(JSON.stringify({ uuid: 'u' }), { status: 200 })
      if (url.includes('/info'))
        return new Response(JSON.stringify({ status: { code: 30, errorMessage: 'boom' }, progress: 0 }), {
          status: 200,
        })
      return new Response('{}', { status: 200 })
    })

    await expect(
      buildDroneTakeoff({ projectId: 'p', imagesDir, nodeOdmUrl: 'http://nodeodm.test:3000' }),
    ).rejects.toThrow(/failed: boom/)
  })
})

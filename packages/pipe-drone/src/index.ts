// pipe-drone: drone imagery → TakeoffResult.
//
// Three paths:
//   A) NodeODM client (live reconstruction). Gated on NODEODM_URL. Uploads
//      images, polls to completion, downloads the headline assets, then
//      extracts the JSON-parseable `odm_report/stats.json` into a real,
//      review-required site-coverage TakeoffResult (`takeoffFromOdmReport`).
//      The richer raster-derived geometry (per-roof-plane RANSAC, DSM/DTM
//      footprint, cut/fill, surfacing) needs GDAL/PDAL and runs in the
//      out-of-process Python sidecar — that is the documented live-service
//      boundary (odm-report.ts → LIVE_SERVICE_BOUNDARY), consumed via Path B.
//   B) Sidecar JSON (precomputed reconstruction metadata) → TakeoffResult.
//      The full-fidelity path: roof planes, footprint, sitework, surfacing.
//   C) RANSAC-on-fixture (research smoke test): hand-authored point cloud
//      → segmented planes → synthetic TakeoffResult. Proves the math.

import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  applyReviewFloor,
  droneConfidenceFromGsd,
  validateTakeoffResult,
  type DroneArtifact,
  type TakeoffGeometry,
  type TakeoffProvenance,
  type TakeoffQuantity,
  type TakeoffResult,
  type TakeoffWarning,
  type Unit,
} from '@sitelayer/capture-schema'

import { DroneSidecarSchema, type DroneSidecar } from './sidecar-types.js'
import { segmentMultiplePlanes, planeAreaFromInliers, type Vec3 } from './ransac.js'
import {
  coverageAreaSqm,
  coverageConfidence,
  droneSidecarFromOdmReport,
  parseOdmReport,
  ODM_REPORT_RELPATH,
  type OdmReport,
  type OdmSidecarContext,
} from './odm-report.js'
import {
  nodeOdmCommitTask,
  nodeOdmCreateTask,
  nodeOdmDownloadAsset,
  nodeOdmFetchJsonAsset,
  nodeOdmUploadImage,
  nodeOdmWaitForCompletion,
} from './nodeodm-client.js'

export const PIPELINE_VERSION = '0.1.0'
export const PER_PLANE_BASELINE_CONFIDENCE = 0.85

export interface BuildDroneTakeoffOptions {
  projectId: string
  capturedAt?: string
  altitudeM?: number

  // Path B (demoable): precomputed sidecar JSON.
  sidecarPath?: string

  // Path A (live NodeODM): images dir + URL.
  imagesDir?: string
  nodeOdmUrl?: string

  // Path C (research smoke test): hand-authored point cloud.
  pointCloudFixturePath?: string

  // Test injection.
  takeoffIdOverride?: string
  producedAtOverride?: string
}

export async function buildDroneTakeoff(opts: BuildDroneTakeoffOptions): Promise<TakeoffResult> {
  if (opts.sidecarPath) {
    return buildFromSidecar(opts)
  }
  if (opts.pointCloudFixturePath) {
    return buildFromPointCloud(opts)
  }
  if (opts.imagesDir && opts.nodeOdmUrl) {
    return runNodeOdmPath(opts)
  }
  throw new Error('buildDroneTakeoff: provide one of sidecarPath, pointCloudFixturePath, or { imagesDir + nodeOdmUrl }')
}

// ─── Path B: sidecar JSON → TakeoffResult ─────────────────────────────────

async function buildFromSidecar(opts: BuildDroneTakeoffOptions): Promise<TakeoffResult> {
  if (!opts.sidecarPath) throw new Error('sidecarPath required')
  const raw = await readFile(opts.sidecarPath, 'utf8')
  const json: unknown = JSON.parse(raw)
  const parsed = DroneSidecarSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`Drone sidecar validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`)
  }
  const sidecar: DroneSidecar = parsed.data
  return takeoffFromSidecar(sidecar, opts)
}

/** Pure: turn a parsed sidecar into a validated TakeoffResult. */
export function takeoffFromSidecar(sidecar: DroneSidecar, opts: BuildDroneTakeoffOptions): TakeoffResult {
  const orthomosaicId = hashShort(sidecar.artifacts.orthoUrl)
  const baselineConfidence = clamp01(droneConfidenceFromGsd(0.85, sidecar.reconstruction.gsdCm))

  const quantities: TakeoffQuantity[] = []
  const surfaces: NonNullable<TakeoffGeometry['surfaces']> = []
  const rooms: NonNullable<TakeoffGeometry['rooms']> = []
  const warnings: TakeoffWarning[] = []

  for (const b of sidecar.buildings) {
    rooms.push({
      id: b.id,
      label: `Building ${b.id}`,
      story: 0,
      floorAreaSqFt: b.footprintAreaSqft,
    })
    surfaces.push({
      id: `${b.id}-footprint`,
      kind: 'facade', // facade used as the closest "envelope" surface kind.
      parentRoomId: b.id,
      areaSqFt: b.exteriorWallAreaSqft,
      polygon: b.footprint.coordinates[0],
    })

    // Roof planes → MasterFormat 07 31 13 / 07 41 13 / 07 32 13 / 07 54 23
    for (const plane of b.roofPlanes) {
      const masterformatCode = roofMaterialToMasterformat(plane.materialGuess)
      const confidence = clamp01(baselineConfidence * (plane.materialConfidence ?? PER_PLANE_BASELINE_CONFIDENCE))
      const provenance: TakeoffProvenance = {
        kind: 'drone',
        orthomosaicId,
        polygonId: plane.id,
        ...(opts.altitudeM != null ? { altitudeM: opts.altitudeM } : {}),
      }
      quantities.push({
        id: `q-roof-${b.id}-${plane.id}`,
        description: `Roof plane ${plane.id} (${plane.pitchRatio} pitch, ${plane.materialGuess ?? 'unknown material'})`,
        masterformatCode,
        unit: 'sqft' as Unit,
        value: plane.areaSqft,
        confidence,
        provenance,
        geometryRefs: [`${b.id}-roof-${plane.id}`],
      })
      surfaces.push({
        id: `${b.id}-roof-${plane.id}`,
        kind: 'roof',
        parentRoomId: b.id,
        areaSqFt: plane.areaSqft,
        polygon: plane.polygon.coordinates[0],
      })
    }

    // Exterior wall area: UniFormat B2010 (we don't know cladding).
    if (b.exteriorWallAreaSqft > 0) {
      quantities.push({
        id: `q-walls-${b.id}`,
        description: `Building ${b.id} exterior wall envelope`,
        uniformatCode: 'B2010',
        unit: 'sqft',
        value: b.exteriorWallAreaSqft,
        confidence: clamp01(baselineConfidence * 0.85),
        provenance: {
          kind: 'drone',
          orthomosaicId,
          polygonId: `${b.id}-walls`,
          ...(opts.altitudeM != null ? { altitudeM: opts.altitudeM } : {}),
        },
        geometryRefs: [`${b.id}-footprint`],
      })
    }
  }

  // Sitework cut/fill — MasterFormat 31 22 00 (Grading), unit `cy`.
  // Two separate quantities so estimators can apply different rates.
  if (sidecar.sitework) {
    const swProv: TakeoffProvenance = {
      kind: 'drone',
      orthomosaicId,
      polygonId: 'sitework-boundary',
      ...(opts.altitudeM != null ? { altitudeM: opts.altitudeM } : {}),
    }
    if (sidecar.sitework.cutCubicYards > 0) {
      quantities.push({
        id: 'q-sitework-cut',
        description: 'Sitework — cut volume',
        masterformatCode: '31 22 00',
        unit: 'cy',
        value: sidecar.sitework.cutCubicYards,
        confidence: clamp01(baselineConfidence * 0.8),
        provenance: swProv,
      })
    }
    if (sidecar.sitework.fillCubicYards > 0) {
      quantities.push({
        id: 'q-sitework-fill',
        description: 'Sitework — fill volume',
        masterformatCode: '31 22 00',
        unit: 'cy',
        value: sidecar.sitework.fillCubicYards,
        confidence: clamp01(baselineConfidence * 0.8),
        provenance: swProv,
      })
    }
  }

  // Surfacing → MasterFormat by material.
  if (sidecar.surfacing) {
    for (const s of sidecar.surfacing) {
      const masterformatCode = surfacingMaterialToMasterformat(s.material)
      if (!masterformatCode) {
        warnings.push({
          code: 'surfacing_unmapped_material',
          severity: 'info',
          message: `Skipped surfacing ${s.id}: material ${s.material} has no MasterFormat mapping`,
        })
        continue
      }
      quantities.push({
        id: `q-surfacing-${s.id}`,
        description: `Surfacing — ${s.material}`,
        masterformatCode,
        unit: 'sqft',
        value: s.areaSqft,
        confidence: clamp01(baselineConfidence * s.confidence),
        provenance: {
          kind: 'drone',
          orthomosaicId,
          polygonId: s.id,
          ...(opts.altitudeM != null ? { altitudeM: opts.altitudeM } : {}),
        },
      })
    }
  }

  if (quantities.length === 0) {
    throw new Error('Drone sidecar yielded zero quantities — sidecar must include buildings/roofs/sitework/surfacing.')
  }

  const sourceArtifact = {
    kind: 'drone' as const,
    drone: sidecar as DroneArtifact,
  }

  const result: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: opts.takeoffIdOverride ?? randomUUID(),
    projectId: opts.projectId,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    producedAt: opts.producedAtOverride ?? new Date().toISOString(),
    source: 'drone.photogrammetry',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities,
    geometry: {
      rooms,
      surfaces,
      rasterRefs: [
        {
          id: orthomosaicId,
          uri: sidecar.artifacts.orthoUrl,
          mime: 'image/tiff',
        },
      ],
    },
    sourceArtifact,
    ...(warnings.length > 0 ? { warnings } : {}),
  }

  return validateTakeoffResult(applyReviewFloor(result))
}

// ─── Path A emit: ODM report JSON → TakeoffResult ─────────────────────────
//
// Turns the *JSON-parseable* portion of a live NodeODM reconstruction (the
// `odm_report/stats.json` rollup) into a real, review-required TakeoffResult.
// This is the deterministic floor of Path A: site-level coverage area +
// average-GSD confidence, emitted without inventing roof planes / cut-fill
// (those need the raster sidecar — see odm-report.ts → LIVE_SERVICE_BOUNDARY).

const SQM_TO_SQFT = 10.7639104167

/**
 * Pure: build a TakeoffResult from a parsed ODM report + context. Emits a
 * single site-coverage quantity (UniFormat G1010 — Site Preparation) plus a
 * warning that documents the raster-extraction boundary.
 */
export function takeoffFromOdmReport(
  report: OdmReport,
  ctx: OdmSidecarContext,
  opts: BuildDroneTakeoffOptions,
): TakeoffResult {
  const sidecar = droneSidecarFromOdmReport(report, ctx)
  const orthomosaicId = hashShort(sidecar.artifacts.orthoUrl)
  const areaSqm = coverageAreaSqm(report)
  const areaSqft = areaSqm != null ? areaSqm * SQM_TO_SQFT : 0
  const confidence = clamp01(coverageConfidence(report, ctx))

  if (areaSqft <= 0) {
    throw new Error(
      'ODM report carries no positive coverage area; cannot emit a quantity. ' +
        'Run NodeODM with the point-cloud / report stages enabled, or use Path B (--sidecarPath).',
    )
  }

  const provenance: TakeoffProvenance = {
    kind: 'drone',
    orthomosaicId,
    polygonId: 'site-coverage',
    ...(opts.altitudeM != null ? { altitudeM: opts.altitudeM } : {}),
  }

  const quantities: TakeoffQuantity[] = [
    {
      id: 'q-site-coverage',
      description: `Reconstructed site coverage area (${sidecar.reconstruction.imageCount} images, GSD ${sidecar.reconstruction.gsdCm} cm)`,
      uniformatCode: 'G1010',
      unit: 'sqft' as Unit,
      value: areaSqft,
      confidence,
      provenance,
      geometryRefs: ['site-coverage-footprint'],
    },
  ]

  const surfaces: NonNullable<TakeoffGeometry['surfaces']> = [
    {
      id: 'site-coverage-footprint',
      kind: 'facade',
      areaSqFt: areaSqft,
      polygon: sidecar.buildings[0]!.footprint.coordinates[0],
    },
  ]

  const warnings: TakeoffWarning[] = [
    {
      code: 'odm_report_coverage_only',
      severity: 'warn',
      message:
        'Built from NodeODM odm_report/stats.json (Path A coverage floor). Only site-level ' +
        'coverage area is emitted; per-roof-plane, sitework cut/fill, and surfacing quantities ' +
        'require the raster extractor (GDAL/PDAL) and arrive via --sidecarPath (Path B).',
    },
  ]

  const result: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: opts.takeoffIdOverride ?? randomUUID(),
    projectId: opts.projectId,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    producedAt: opts.producedAtOverride ?? new Date().toISOString(),
    source: 'drone.photogrammetry',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities,
    geometry: {
      surfaces,
      rasterRefs: [
        {
          id: orthomosaicId,
          uri: sidecar.artifacts.orthoUrl,
          mime: 'image/tiff',
        },
      ],
    },
    sourceArtifact: {
      kind: 'drone' as const,
      drone: sidecar as DroneArtifact,
    },
    warnings,
    // Coverage-only is an explicitly partial extraction (raster geometry not
    // run): always require human review, regardless of the GSD confidence.
    reviewRequired: true,
  }

  return validateTakeoffResult(applyReviewFloor(result))
}

// ─── Path C: hand-authored point cloud → TakeoffResult ────────────────────

async function buildFromPointCloud(opts: BuildDroneTakeoffOptions): Promise<TakeoffResult> {
  if (!opts.pointCloudFixturePath) throw new Error('pointCloudFixturePath required')
  const raw = await readFile(opts.pointCloudFixturePath, 'utf8')
  const json = JSON.parse(raw) as { points: Vec3[] }
  if (!Array.isArray(json.points) || json.points.length === 0) {
    throw new Error('pointCloud fixture must have non-empty `points` array')
  }
  const planes = segmentMultiplePlanes(json.points, {
    distanceThresholdM: 0.08,
    minInliers: 30,
    iterations: 800,
    maxPlanes: 6,
    rngSeed: 0xdada,
  })
  // Filter to roof-pitched planes (|n_z| > 0.2).
  const roofPlanes = planes.filter((p) => Math.abs(p.normalVec[2]) > 0.2)
  if (roofPlanes.length === 0) {
    throw new Error('No roof-pitched planes (|n_z|>0.2) extracted from point cloud')
  }

  const orthomosaicId = 'ransac-fixture'
  const baselineConfidence = 0.6
  const altitudeM = opts.altitudeM ?? 80
  const quantities: TakeoffQuantity[] = []
  const surfaces: NonNullable<TakeoffGeometry['surfaces']> = []
  for (const plane of roofPlanes) {
    const m = planeAreaFromInliers(plane, json.points)
    const areaSqft = m.areaSqM * 10.7639
    const provenance: TakeoffProvenance = {
      kind: 'drone',
      orthomosaicId,
      polygonId: plane.id,
      altitudeM,
    }
    quantities.push({
      id: `q-roof-${plane.id}`,
      description: `RANSAC plane ${plane.id} (pitch ${m.pitchDegrees.toFixed(1)}°, az ${m.azimuthDegrees.toFixed(0)}°)`,
      masterformatCode: '07 31 13',
      unit: 'sqft',
      value: areaSqft,
      confidence: clamp01(baselineConfidence),
      provenance,
      geometryRefs: [`fixture-roof-${plane.id}`],
    })
    surfaces.push({
      id: `fixture-roof-${plane.id}`,
      kind: 'roof',
      areaSqFt: areaSqft,
    })
  }

  const result: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: opts.takeoffIdOverride ?? randomUUID(),
    projectId: opts.projectId,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    producedAt: opts.producedAtOverride ?? new Date().toISOString(),
    source: 'drone.photogrammetry',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities,
    geometry: { surfaces },
    warnings: [
      {
        code: 'ransac_fixture_path',
        severity: 'info',
        message:
          'Built from hand-authored point cloud via Path C. Areas are convex-hull approximations from synthetic data.',
      },
    ],
  }

  return validateTakeoffResult(applyReviewFloor(result))
}

// ─── Path A: NodeODM live (gated; cannot extract in pure TS) ──────────────

async function runNodeOdmPath(opts: BuildDroneTakeoffOptions): Promise<TakeoffResult> {
  if (!opts.imagesDir || !opts.nodeOdmUrl) {
    throw new Error('Path A requires both imagesDir and nodeOdmUrl')
  }
  const { uuid } = await nodeOdmCreateTask({ nodeOdmUrl: opts.nodeOdmUrl })

  const { readdir } = await import('node:fs/promises')
  const { join, basename } = await import('node:path')
  const entries = await readdir(opts.imagesDir)
  const imageEntries = entries.filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f))
  if (imageEntries.length === 0) {
    throw new Error(`Path A: no images found in ${opts.imagesDir}`)
  }
  for (const f of imageEntries) {
    await nodeOdmUploadImage({
      nodeOdmUrl: opts.nodeOdmUrl,
      uuid,
      imagePath: join(opts.imagesDir, f),
      filename: basename(f),
    })
  }
  await nodeOdmCommitTask({ nodeOdmUrl: opts.nodeOdmUrl, uuid })
  const wait = await nodeOdmWaitForCompletion({
    nodeOdmUrl: opts.nodeOdmUrl,
    uuid,
  })
  if (wait.status !== 'completed') {
    throw new Error(
      `NodeODM task ${uuid} ${wait.status}${
        'errorMessage' in wait && wait.errorMessage ? `: ${wait.errorMessage}` : ''
      }`,
    )
  }
  // Pull the headline assets so they're available for downstream tooling.
  const { mkdir } = await import('node:fs/promises')
  const outDir = `${opts.imagesDir}/.odm-out`
  await mkdir(outDir, { recursive: true })
  for (const asset of ['orthophoto.tif', 'dsm.tif', 'dtm.tif', 'georeferenced_model.laz'] as const) {
    try {
      await nodeOdmDownloadAsset({
        nodeOdmUrl: opts.nodeOdmUrl,
        uuid,
        asset,
        outPath: `${outDir}/${asset}`,
      })
    } catch (err) {
      // Non-fatal; some sets won't produce every asset.
      console.warn(`asset download failed (${asset}):`, (err as Error).message)
    }
  }

  // Sidecar extraction. The raster assets above (GeoTIFF/LAZ) need GDAL/PDAL to
  // become per-roof-plane geometry — that is the live-service boundary handled
  // by the out-of-process Python sidecar and consumed via Path B (--sidecarPath).
  // But NodeODM also emits a JSON report (`odm_report/stats.json`) we CAN parse
  // in pure TS, so we extract the site-level coverage quantity from it. This is
  // the always-available floor of Path A: a real, review-required TakeoffResult.
  const rawReport = await nodeOdmFetchJsonAsset({
    nodeOdmUrl: opts.nodeOdmUrl,
    uuid,
    relPath: ODM_REPORT_RELPATH,
  })
  if (rawReport == null) {
    throw new Error(
      `NodeODM task ${uuid} completed but did not produce ${ODM_REPORT_RELPATH}; ` +
        'cannot extract coverage. Run the report/point-cloud stages, or run the raster ' +
        'sidecar extractor and re-run with --sidecarPath (Path B).',
    )
  }
  const report: OdmReport = parseOdmReport(rawReport)
  const ctx: OdmSidecarContext = {
    orthoUrl: `file://${outDir}/orthophoto.tif`,
    dsmUrl: `file://${outDir}/dsm.tif`,
    dtmUrl: `file://${outDir}/dtm.tif`,
    pointCloudUrl: `file://${outDir}/georeferenced_model.laz`,
  }
  return takeoffFromOdmReport(report, ctx, opts)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function hashShort(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

function roofMaterialToMasterformat(
  m: 'asphalt-shingle' | 'metal' | 'tile' | 'membrane' | 'unknown' | undefined,
): string {
  switch (m) {
    case 'metal':
      return '07 41 13'
    case 'tile':
      return '07 32 13'
    case 'membrane':
      return '07 54 23'
    case 'asphalt-shingle':
    case 'unknown':
    case undefined:
    default:
      return '07 31 13'
  }
}

function surfacingMaterialToMasterformat(
  material: 'asphalt' | 'concrete' | 'gravel' | 'pavers' | 'vegetation' | 'bare-soil' | 'other',
): string | null {
  switch (material) {
    case 'asphalt':
      return '32 12 16'
    case 'concrete':
      return '32 13 13'
    case 'gravel':
      return '32 11 23'
    case 'pavers':
      return '32 14 13'
    case 'vegetation':
    case 'bare-soil':
    case 'other':
    default:
      return null
  }
}

// ─── Re-exports for callers ───────────────────────────────────────────────

export { DroneSidecarSchema, type DroneSidecar } from './sidecar-types.js'
export { segmentPlane, segmentMultiplePlanes, planeAreaFromInliers, type Plane, type Vec3 } from './ransac.js'
export {
  OdmReportSchema,
  OdmReportValidationError,
  parseOdmReport,
  droneSidecarFromOdmReport,
  coverageAreaSqm,
  coverageConfidence,
  averageGsdCm,
  LIVE_SERVICE_BOUNDARY,
  ODM_REPORT_RELPATH,
  DEFAULT_RECONSTRUCTOR_CONFIDENCE,
  type OdmReport,
  type OdmSidecarContext,
} from './odm-report.js'
export {
  nodeOdmCreateTask,
  nodeOdmUploadImage,
  nodeOdmCommitTask,
  nodeOdmGetInfo,
  nodeOdmDownloadAsset,
  nodeOdmFetchJsonAsset,
  nodeOdmWaitForCompletion,
  NODEODM_STATUS,
} from './nodeodm-client.js'

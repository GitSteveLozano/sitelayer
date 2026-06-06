// ODM report sidecar extraction.
//
// ── Why this module exists ────────────────────────────────────────────────
// `runNodeOdmPath` (Path A) drives a live NodeODM reconstruction: it uploads
// images, polls to completion, and downloads the headline assets
// (`orthophoto.tif`, `dsm.tif`, `dtm.tif`, `georeferenced_model.laz`). Those
// are binary GeoTIFF / LAZ rasters. Turning *those* into per-roof-plane
// geometry (DSM−DTM footprint masks, LAZ point-cloud RANSAC, DTM cut/fill
// against a target grade, ortho HSV surfacing classification) genuinely needs
// GDAL + PDAL / Open3D, which are Python-native and out of scope for a pure-TS
// package. That raster path is the documented **live-service boundary**
// (see `extractOdmSidecar` → `LIVE_SERVICE_BOUNDARY`).
//
// BUT NodeODM also emits a JSON-shaped report — `odm_report/stats.json`
// (the OpenSfM `reconstruction_statistics` / `processing_statistics` /
// `point_cloud_statistics` rollup that ODM augments) — and that JSON *is*
// parseable in pure TypeScript. This module:
//
//   1. validates that report JSON against a tolerant zod schema
//      (`OdmReportSchema`), and
//   2. deterministically derives a real `DroneSidecar` from it
//      (`droneSidecarFromOdmReport`) — site-level quantities the reconstruction
//      report actually knows: the reconstructed coverage footprint (m² → sqft),
//      the average-GSD-driven reconstructor confidence, and point density.
//
// The result is a real, review-required `TakeoffResult` produced end-to-end
// from a live reconstruction — without inventing roof planes or cut/fill the
// raster path hasn't been run to compute. Per-building / per-roof-plane and
// cut/fill quantities only appear when an upstream raster extractor supplies a
// richer sidecar via `--sidecarPath` (Path B); this report path is the honest
// floor that always works.

import { z } from 'zod'

import { droneConfidenceFromGsd } from '@sitelayer/capture-schema'

import type { DroneSidecar } from './sidecar-types.js'

/**
 * The conventional relative path of the ODM report stats JSON inside a
 * NodeODM task's `all.zip` / download tree. `runNodeOdmPath` downloads it to
 * `<imagesDir>/.odm-out/odm_report/stats.json`.
 */
export const ODM_REPORT_RELPATH = 'odm_report/stats.json'

/**
 * Marker string thrown / surfaced when the *raster* portion of extraction
 * (footprint masks, roof RANSAC, cut/fill, surfacing classification) is
 * requested but cannot run in pure TypeScript. Kept as an exported constant so
 * callers and tests can assert on the boundary deterministically.
 */
export const LIVE_SERVICE_BOUNDARY =
  'Raster geometry extraction (DSM/DTM footprint, LAZ roof RANSAC, cut/fill, ' +
  'ortho surfacing classification) requires GDAL/PDAL and runs in the out-of-process ' +
  'Python sidecar service, not in pipe-drone. Supply its output via --sidecarPath ' +
  '(Path B) for per-roof-plane / cut-fill quantities.'

// ─── ODM / OpenSfM report stats.json schema (tolerant) ────────────────────
//
// We model only the fields we actually consume and keep everything optional /
// passthrough so a newer ODM that adds keys (or an older one that omits some)
// still validates. Field names mirror the real OpenSfM `stats.json`
// (`reconstruction_statistics`, `features_statistics`, `processing_statistics`,
// `gps_errors`) plus the ODM `odm_processing_statistics` / `point_cloud_statistics`
// augmentation. References:
//   - OpenSfM compute_statistics → stats/stats.json
//   - ODM stages/odm_report.py → augments with odm_processing_statistics + point_cloud_statistics

const Numberish = z.union([z.number(), z.null()]).optional()

/**
 * Native (projected) bounding box as ODM writes it under
 * `point_cloud_statistics.stats.bbox.native.bbox`: { minx, miny, minz, maxx, maxy, maxz }.
 * Units are the reconstruction CRS metres.
 */
const NativeBBoxSchema = z
  .object({
    minx: Numberish,
    miny: Numberish,
    minz: Numberish,
    maxx: Numberish,
    maxy: Numberish,
    maxz: Numberish,
  })
  .passthrough()

export const OdmReportSchema = z
  .object({
    // OpenSfM reconstruction rollup.
    reconstruction_statistics: z
      .object({
        components: Numberish,
        reconstructed_shots_count: Numberish,
        initial_shots_count: Numberish,
        reconstructed_points_count: Numberish,
        observations_count: Numberish,
        average_track_length: Numberish,
        average_track_length_over_two: Numberish,
      })
      .passthrough()
      .optional(),

    features_statistics: z
      .object({
        detected_features: z
          .object({ min: Numberish, max: Numberish, mean: Numberish, median: Numberish })
          .passthrough()
          .optional(),
        reconstructed_features: z
          .object({ min: Numberish, max: Numberish, mean: Numberish, median: Numberish })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),

    // OpenSfM processing rollup (area covered + GSD live here).
    processing_statistics: z
      .object({
        steps_times: z.record(z.string(), z.unknown()).optional(),
        date: z.string().optional(),
        area: Numberish, // m^2 covered by the camera bounding box
        average_gsd: Numberish, // cm/px (OpenSfM) — ODM mirrors into odm_processing_statistics
      })
      .passthrough()
      .optional(),

    // Reprojection error histogram / summary (un-normalized + normalized).
    reprojection_errors: z.record(z.string(), z.unknown()).optional(),

    // GPS / GCP residual rollup.
    gps_errors: z.record(z.string(), z.unknown()).optional(),
    gcp_errors: z.record(z.string(), z.unknown()).optional(),

    // ODM augmentation.
    odm_processing_statistics: z
      .object({
        total_time: Numberish,
        total_time_human: z.string().optional(),
        average_gsd: Numberish, // cm/px
      })
      .passthrough()
      .optional(),

    point_cloud_statistics: z
      .object({
        dense: z.boolean().optional(),
        stats: z
          .object({
            statistic: z.array(z.unknown()).optional(),
            bbox: z
              .object({
                native: z.object({ bbox: NativeBBoxSchema }).passthrough().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type OdmReport = z.infer<typeof OdmReportSchema>

export class OdmReportValidationError extends Error {
  constructor(
    message: string,
    public issues: z.ZodIssue[],
  ) {
    super(message)
    this.name = 'OdmReportValidationError'
  }
}

/** Parse + validate raw ODM report JSON; throws `OdmReportValidationError`. */
export function parseOdmReport(input: unknown): OdmReport {
  const parsed = OdmReportSchema.safeParse(input)
  if (!parsed.success) {
    throw new OdmReportValidationError('ODM report (stats.json) validation failed', parsed.error.issues)
  }
  return parsed.data
}

// ─── Conversions ──────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639104167

/** Pull a finite number from a possibly-null/undefined field. */
function num(x: number | null | undefined): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

/** Average GSD in cm, preferring the ODM augmentation, then OpenSfM. */
export function averageGsdCm(report: OdmReport): number | undefined {
  return num(report.odm_processing_statistics?.average_gsd) ?? num(report.processing_statistics?.average_gsd)
}

/**
 * Reconstructed coverage area in m². Prefer the OpenSfM camera-bbox `area`
 * (the area covered by the reconstruction); fall back to the point-cloud
 * native bbox footprint (XY extent) when `area` isn't present.
 */
export function coverageAreaSqm(report: OdmReport): number | undefined {
  const direct = num(report.processing_statistics?.area)
  if (direct != null && direct > 0) return direct
  const bbox = report.point_cloud_statistics?.stats?.bbox?.native?.bbox
  if (!bbox) return undefined
  const minx = num(bbox.minx)
  const maxx = num(bbox.maxx)
  const miny = num(bbox.miny)
  const maxy = num(bbox.maxy)
  if (minx == null || maxx == null || miny == null || maxy == null) return undefined
  const w = Math.abs(maxx - minx)
  const h = Math.abs(maxy - miny)
  const area = w * h
  return area > 0 ? area : undefined
}

export interface OdmSidecarContext {
  /** Site centre lat/lon. NodeODM reports projected coords only, so the */
  /** caller supplies WGS84 centre (e.g. from EXIF or a known site). */
  siteCenter?: { lat: number; lon: number }
  /** CRS string, e.g. `EPSG:32617`. Defaults to `unknown`. */
  crs?: string
  /** URLs of the downloaded assets, for provenance + raster refs. */
  orthoUrl?: string
  dsmUrl?: string
  dtmUrl?: string
  pointCloudUrl?: string
  /** Override the reconstructor baseline confidence (default 0.85). */
  reconstructorConfidence?: number
}

export const DEFAULT_RECONSTRUCTOR_CONFIDENCE = 0.85

/**
 * Deterministically derive a `DroneSidecar` from a parsed ODM report.
 *
 * This produces the **site-level coverage** view the reconstruction report can
 * justify on its own: one synthetic "site" building whose footprint is the
 * reconstructed coverage area, with NO roof planes (those need the raster
 * extractor — see `LIVE_SERVICE_BOUNDARY`). It is the honest, always-available
 * floor of Path A. Callers who run the Python raster sidecar feed its richer
 * output through Path B (`--sidecarPath`) instead.
 *
 * Throws if the report lacks both an average GSD and a coverage area — without
 * either there is nothing real to emit.
 */
export function droneSidecarFromOdmReport(report: OdmReport, ctx: OdmSidecarContext = {}): DroneSidecar {
  const gsdCm = averageGsdCm(report)
  const areaSqm = coverageAreaSqm(report)

  if (gsdCm == null && areaSqm == null) {
    throw new Error(
      'ODM report has neither average_gsd nor a coverage area / point-cloud bbox; ' +
        'nothing real to extract. Re-run NodeODM with report + point-cloud stages enabled.',
    )
  }

  const areaSqft = areaSqm != null ? areaSqm * SQM_TO_SQFT : 0
  const imageCount = num(report.reconstruction_statistics?.reconstructed_shots_count) ?? 0
  const center = ctx.siteCenter ?? { lat: 0, lon: 0 }

  // A degenerate single-point polygon at the site centre. We do not fabricate
  // a real footprint outline — the report carries no georeferenced building
  // boundary; only an area. The polygon exists so the contract's
  // GeoJSON-Polygon shape is satisfied and the review UI has an anchor.
  const anchor: [number, number] = [center.lon, center.lat]
  const footprint = {
    type: 'Polygon' as const,
    coordinates: [[anchor, anchor, anchor, anchor]],
  }

  const sidecar: DroneSidecar = {
    siteCenter: center,
    crs: ctx.crs ?? 'unknown',
    reconstruction: {
      engine: 'ODM',
      imageCount,
      // gsdCm must be positive per the sidecar schema; if the report omitted it
      // use a conservative placeholder that drives a low confidence + review.
      gsdCm: gsdCm != null && gsdCm > 0 ? gsdCm : 99,
    },
    artifacts: {
      orthoUrl: ctx.orthoUrl ?? 'odm://orthophoto.tif',
      ...(ctx.dsmUrl != null ? { dsmUrl: ctx.dsmUrl } : {}),
      ...(ctx.dtmUrl != null ? { dtmUrl: ctx.dtmUrl } : {}),
      ...(ctx.pointCloudUrl != null ? { pointCloudUrl: ctx.pointCloudUrl } : {}),
    },
    buildings: [
      {
        id: 'site-coverage',
        footprint,
        footprintAreaSqft: areaSqft,
        eaveHeightFt: 0,
        ridgeHeightFt: 0,
        exteriorWallAreaSqft: 0,
        roofPlanes: [], // raster boundary — see LIVE_SERVICE_BOUNDARY
      },
    ],
  }

  return sidecar
}

/**
 * The reconstructor-confidence-adjusted score for the coverage area quantity,
 * exported so the index emit path and tests share one definition.
 */
export function coverageConfidence(report: OdmReport, ctx: OdmSidecarContext = {}): number {
  const baseline = ctx.reconstructorConfidence ?? DEFAULT_RECONSTRUCTOR_CONFIDENCE
  const gsdCm = averageGsdCm(report)
  // Without a GSD we cannot trust the reconstruction; floor it.
  if (gsdCm == null || gsdCm <= 0) return 0
  return droneConfidenceFromGsd(baseline, gsdCm)
}

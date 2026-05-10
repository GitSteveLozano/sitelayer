import { randomUUID } from 'node:crypto'
import {
  applyReviewFloor,
  validateTakeoffResult,
  type PhotogrammetryArtifact,
  type TakeoffQuantity,
  type TakeoffResult,
  type TakeoffWarning,
} from '@sitelayer/capture-schema'
import { parseLabeledMesh, type LabeledMesh, type LabeledSurface } from './labeled-mesh.js'
import { pollLumaJob, submitVideoToLuma, type LumaSubmission } from './luma-client.js'

export const PIPELINE_VERSION = '0.1.0'

// 1 m² = 10.7639 ft² ; 1 m = 3.28084 ft
const SQM_TO_SQFT = 10.7639
const M_TO_FT = 3.28084

export interface SubmitVideoOptions {
  videoPath: string
  projectId: string
  apiKey?: string
  title?: string
}

export interface SubmitVideoResult {
  vendor: 'luma'
  vendorJobId: string
  status: 'queued' | 'processing'
}

export interface FetchPhotogrammetryOptions {
  apiKey?: string
}

/**
 * Path A: kick off a Luma 3D Capture job for a phone video.
 * Returns the vendor job id; the caller polls via `fetchPhotogrammetryTakeoff`.
 */
export async function submitPhotogrammetryJob(opts: SubmitVideoOptions): Promise<SubmitVideoResult> {
  const apiKey = opts.apiKey ?? process.env.LUMA_API_KEY
  if (!apiKey) {
    throw new Error('submitPhotogrammetryJob: LUMA_API_KEY not set (pass opts.apiKey or set the env var)')
  }
  const submission: LumaSubmission = await submitVideoToLuma({
    videoPath: opts.videoPath,
    apiKey,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  })
  // Path A treats both queued and processing as in-flight.
  const status: SubmitVideoResult['status'] =
    submission.status === 'succeeded' || submission.status === 'failed'
      ? 'processing' // not what the caller expects here; treat as still processing
      : submission.status
  return {
    vendor: 'luma',
    vendorJobId: submission.jobId,
    status,
  }
}

/**
 * Path A: fetch a (presumed completed) Luma job and produce a TakeoffResult
 * that is intentionally **review-required** with no useful quantities. The
 * mesh is captured into `sourceArtifact.photogrammetry`; semantic labeling
 * is left for the human-in-the-loop step (see research/02-photogrammetry.md
 * §3 — only Polycam Business auto-labels rooms; everyone else needs a manual
 * pass).
 */
export async function fetchPhotogrammetryTakeoff(
  jobId: string,
  projectId: string,
  opts: FetchPhotogrammetryOptions = {},
): Promise<TakeoffResult> {
  const apiKey = opts.apiKey ?? process.env.LUMA_API_KEY
  if (!apiKey) {
    throw new Error('fetchPhotogrammetryTakeoff: LUMA_API_KEY not set (pass opts.apiKey or set the env var)')
  }
  const job = await pollLumaJob({ jobId, apiKey })
  if (job.status !== 'succeeded') {
    throw new Error(`Luma job ${jobId} not yet succeeded (status=${job.status})`)
  }
  if (!job.meshUrl) {
    throw new Error(`Luma job ${jobId} has no mesh artifact yet`)
  }

  const meshFormat = inferMeshFormat(job.meshUrl)
  const photogrammetry: PhotogrammetryArtifact = {
    vendor: 'luma',
    vendorJobId: jobId,
    meshUrl: job.meshUrl,
    meshFormat,
    ...(job.previewImageUrl !== undefined ? { previewImageUrl: job.previewImageUrl } : {}),
    scale: {
      // Luma Capture API does not return metric scale by default — monocular
      // video has no metric reference unless the user shipped a fiducial.
      method: 'unscaled',
      metersPerUnit: 1,
      confidence: 'unknown',
    },
    qa: {
      coveragePct: 0,
      blindSpots: [],
    },
  }

  // Single placeholder quantity so the result remains schema-valid (the
  // contract requires ≥1 quantity). Confidence is well below the floor so
  // pricing produces nothing useful, and `reviewRequired` is set.
  const quantity: TakeoffQuantity = {
    id: `q-${jobId}-pending-review`,
    description: 'Mesh available; human labeling required',
    uniformatCode: 'B3010', // Exterior walls — closest generic placeholder
    unit: 'sqft',
    value: 0,
    confidence: 0.05,
    provenance: {
      kind: 'photogrammetry',
      meshId: jobId,
      vendorJobId: jobId,
    },
  }

  const warnings: TakeoffWarning[] = [
    {
      code: 'photogrammetry_review_needed',
      severity: 'warn',
      message: 'Luma mesh fetched but no semantic labels exist; route to manual labeling UI.',
    },
  ]

  const result: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: randomUUID(),
    projectId,
    capturedAt: new Date().toISOString(),
    producedAt: new Date().toISOString(),
    source: 'photogrammetry',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities: [quantity],
    sourceArtifact: { kind: 'photogrammetry', photogrammetry },
    warnings,
    reviewRequired: true,
  }

  return validateTakeoffResult(applyReviewFloor(result))
}

export interface BuildTakeoffFromLabeledMeshOptions {
  labeledMesh: LabeledMesh | unknown
  projectId: string
  /** Override `producedAt` for deterministic tests. */
  producedAt?: string
  /** Override `takeoffId` for deterministic tests. */
  takeoffId?: string
}

/**
 * Path B: produce a TakeoffResult from a hand-authored labeled-mesh JSON.
 *
 * Pipeline rules (per task spec):
 *   - Convert m² → sqft (1 m² = 10.7639 sqft) and m → ft at the seam.
 *   - Per room: drywall area = Σ wall areas − Σ opening areas (doors+windows
 *     parented to that room), MasterFormat 09 29 00.
 *   - Floor: UniFormat B3010 (per spec) plus MasterFormat 03 30 00 generic.
 *     We emit one quantity per floor surface tagged with UniFormat B3010.
 *   - Ceiling: MasterFormat 09 29 00 (drywall ceiling).
 *   - Doors / windows: ea (count).
 *   - Confidence per quantity = the surface's `confidence` directly; for
 *     room-aggregates, min over contributing surfaces.
 *   - sourceArtifact.photogrammetry populated from the labeled-mesh metadata.
 */
export function buildTakeoffFromLabeledMesh(opts: BuildTakeoffFromLabeledMeshOptions): TakeoffResult {
  const labeled = isLabeledMesh(opts.labeledMesh) ? opts.labeledMesh : parseLabeledMesh(opts.labeledMesh)

  const quantities: TakeoffQuantity[] = []
  const warnings: TakeoffWarning[] = []

  // Group surfaces by parent room, plus an "unparented" bucket.
  const roomSurfaces = new Map<string, LabeledSurface[]>()
  const unparented: LabeledSurface[] = []
  for (const s of labeled.surfaces) {
    if (s.parentRoomId) {
      const arr = roomSurfaces.get(s.parentRoomId) ?? []
      arr.push(s)
      roomSurfaces.set(s.parentRoomId, arr)
    } else {
      unparented.push(s)
    }
  }

  // Index labeled rooms for a fast lookup.
  const labeledRooms = new Map(labeled.rooms.map((r) => [r.id, r]))

  // Per room: emit drywall (walls minus openings), floor, ceiling, doors, windows.
  for (const room of labeled.rooms) {
    const surfaces = roomSurfaces.get(room.id) ?? []

    const walls = surfaces.filter((s) => s.kind === 'wall')
    const doors = surfaces.filter((s) => s.kind === 'door')
    const windows = surfaces.filter((s) => s.kind === 'window')
    const openings = surfaces.filter((s) => s.kind === 'opening')
    const floors = surfaces.filter((s) => s.kind === 'floor')
    const ceilings = surfaces.filter((s) => s.kind === 'ceiling')

    // Drywall = wall surface area minus all openings (doors + windows + opening).
    if (walls.length > 0) {
      const wallAreaM2 = sum(walls.map((w) => w.areaM2))
      const openingAreaM2 = sum([...doors, ...windows, ...openings].map((o) => o.areaM2))
      const netAreaM2 = Math.max(wallAreaM2, 0) - Math.max(openingAreaM2, 0)
      const wallContributors = [...walls, ...doors, ...windows, ...openings]
      quantities.push({
        id: `q-${room.id}-drywall`,
        description: roomLabel(room, 'drywall'),
        masterformatCode: '09 29 00',
        unit: 'sqft',
        value: round2(Math.max(netAreaM2, 0) * SQM_TO_SQFT),
        confidence: minConfidence(wallContributors),
        provenance: {
          kind: 'photogrammetry',
          meshId: labeled.captureId,
          ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
        },
      })
    }

    // Floor (UniFormat B3010 per spec).
    if (floors.length > 0) {
      const floorAreaM2 = sum(floors.map((f) => f.areaM2))
      quantities.push({
        id: `q-${room.id}-floor`,
        description: roomLabel(room, 'floor'),
        uniformatCode: 'B3010',
        unit: 'sqft',
        value: round2(floorAreaM2 * SQM_TO_SQFT),
        confidence: minConfidence(floors),
        provenance: {
          kind: 'photogrammetry',
          meshId: labeled.captureId,
          planeId: floors[0]!.id,
          ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
        },
      })
    }

    // Ceiling (drywall ceiling — 09 29 00).
    if (ceilings.length > 0) {
      const ceilingAreaM2 = sum(ceilings.map((c) => c.areaM2))
      quantities.push({
        id: `q-${room.id}-ceiling`,
        description: roomLabel(room, 'ceiling'),
        masterformatCode: '09 29 00',
        unit: 'sqft',
        value: round2(ceilingAreaM2 * SQM_TO_SQFT),
        confidence: minConfidence(ceilings),
        provenance: {
          kind: 'photogrammetry',
          meshId: labeled.captureId,
          planeId: ceilings[0]!.id,
          ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
        },
      })
    }

    // Doors (count).
    if (doors.length > 0) {
      quantities.push({
        id: `q-${room.id}-doors`,
        description: roomLabel(room, 'doors'),
        masterformatCode: '08 14 00', // Wood doors (generic)
        unit: 'ea',
        value: doors.length,
        confidence: minConfidence(doors),
        provenance: {
          kind: 'photogrammetry',
          meshId: labeled.captureId,
          ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
        },
      })
    }

    // Windows (count).
    if (windows.length > 0) {
      quantities.push({
        id: `q-${room.id}-windows`,
        description: roomLabel(room, 'windows'),
        masterformatCode: '08 50 00', // Windows (generic)
        unit: 'ea',
        value: windows.length,
        confidence: minConfidence(windows),
        provenance: {
          kind: 'photogrammetry',
          meshId: labeled.captureId,
          ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
        },
      })
    }
  }

  if (unparented.length > 0) {
    warnings.push({
      code: 'photogrammetry_unparented_surfaces',
      severity: 'info',
      message: `${unparented.length} surface(s) had no parentRoomId and were skipped`,
    })
  }

  if (labeled.qa.coveragePct < 70) {
    warnings.push({
      code: 'photogrammetry_low_coverage',
      severity: 'warn',
      message: `Capture coverage ${labeled.qa.coveragePct}% is below 70%`,
    })
  }

  if (labeled.scale.method === 'unscaled') {
    warnings.push({
      code: 'photogrammetry_unscaled',
      severity: 'warn',
      message: 'Mesh is unscaled (no fiducial / depth / known-object); quantities may be wrong by an unknown factor.',
    })
  }

  if (quantities.length === 0) {
    // The schema requires ≥1 quantity; emit a placeholder so we stay valid
    // and the review UI knows to route to manual labeling.
    quantities.push({
      id: 'q-empty-placeholder',
      description: 'Mesh present but no labeled surfaces produced quantities',
      uniformatCode: 'B3010',
      unit: 'sqft',
      value: 0,
      confidence: 0.05,
      provenance: {
        kind: 'photogrammetry',
        meshId: labeled.captureId,
        ...(labeled.vendorJobId !== undefined ? { vendorJobId: labeled.vendorJobId } : {}),
      },
    })
    warnings.push({
      code: 'photogrammetry_no_quantities',
      severity: 'warn',
      message: 'No labeled surfaces produced quantities; placeholder emitted for schema compliance.',
    })
  }

  // Lean cross-pipeline geometry — let the review UI highlight rooms / surfaces.
  const geometry = buildGeometry(labeled, labeledRooms)

  const photogrammetry: PhotogrammetryArtifact = {
    vendor: labeled.vendor ?? 'colmap-self-hosted',
    vendorJobId: labeled.vendorJobId ?? labeled.captureId,
    meshUrl: labeled.meshUrl,
    meshFormat: labeled.meshFormat,
    ...(labeled.pointCloudUrl !== undefined ? { pointCloudUrl: labeled.pointCloudUrl } : {}),
    ...(labeled.textureAtlasUrl !== undefined ? { textureAtlasUrl: labeled.textureAtlasUrl } : {}),
    ...(labeled.previewImageUrl !== undefined ? { previewImageUrl: labeled.previewImageUrl } : {}),
    scale: {
      method: labeled.scale.method,
      metersPerUnit: labeled.scale.metersPerUnit,
      confidence: labeled.scale.confidence,
    },
    qa: {
      coveragePct: labeled.qa.coveragePct,
      blindSpots: labeled.qa.blindSpots,
      ...(labeled.qa.reconstructionMeanErrorM !== undefined
        ? { reconstructionMeanErrorM: labeled.qa.reconstructionMeanErrorM }
        : {}),
    },
  }

  // Photogrammetry is review-required by default: monocular video has no
  // metric scale guarantee (research/02 §5), so even with high per-surface
  // confidence the human estimator should sign off before pricing.
  const result: TakeoffResult = {
    schemaVersion: '1.0.0',
    takeoffId: opts.takeoffId ?? randomUUID(),
    projectId: opts.projectId,
    capturedAt: labeled.capturedAt,
    producedAt: opts.producedAt ?? new Date().toISOString(),
    source: 'photogrammetry',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities,
    geometry,
    sourceArtifact: { kind: 'photogrammetry', photogrammetry },
    warnings: warnings.length > 0 ? warnings : [],
    reviewRequired: true,
  }

  return validateTakeoffResult(applyReviewFloor(result))
}

// ─── helpers ──────────────────────────────────────────────────────────────

function isLabeledMesh(x: unknown): x is LabeledMesh {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.meshUrl === 'string' &&
    typeof o.captureId === 'string' &&
    Array.isArray(o.surfaces) &&
    Array.isArray(o.rooms)
  )
}

function sum(xs: number[]): number {
  let total = 0
  for (const x of xs) total += x
  return total
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

function minConfidence(surfaces: LabeledSurface[]): number {
  if (surfaces.length === 0) return 0.5
  let m = 1
  for (const s of surfaces) {
    if (s.confidence < m) m = s.confidence
  }
  return m
}

function roomLabel(room: { id: string; label?: string }, what: string): string {
  const name = room.label ?? room.id
  return `${name} — ${what}`
}

function inferMeshFormat(url: string): 'obj' | 'glb' | 'usdz' {
  const lower = url.toLowerCase()
  if (lower.includes('.usdz')) return 'usdz'
  if (lower.includes('.glb')) return 'glb'
  return 'obj'
}

function buildGeometry(
  labeled: LabeledMesh,
  labeledRooms: Map<string, { label?: string; ceilingHeightM?: number }>,
): TakeoffResult['geometry'] {
  const rooms = labeled.rooms.map((r) => ({
    id: r.id,
    ...(r.label !== undefined ? { label: r.label } : {}),
    floorAreaSqFt: round2(r.floorAreaM2 * SQM_TO_SQFT),
    perimeterLf: round2(r.perimeterM * M_TO_FT),
  }))

  const surfaces = labeled.surfaces
    // Only the kinds the cross-pipeline geometry shape supports.
    .filter((s) => ['wall', 'floor', 'ceiling', 'opening'].includes(s.kind))
    .map((s) => {
      const kind = s.kind === 'door' || s.kind === 'window' ? 'opening' : s.kind
      return {
        id: s.id,
        kind: kind as 'wall' | 'floor' | 'ceiling' | 'opening',
        ...(s.parentRoomId !== undefined ? { parentRoomId: s.parentRoomId } : {}),
        areaSqFt: round2(s.areaM2 * SQM_TO_SQFT),
      }
    })

  const objects = labeled.surfaces
    .filter((s) => s.kind === 'door' || s.kind === 'window')
    .map((s) => ({
      id: s.id,
      category: s.kind, // "door" | "window"
    }))

  // Touch labeledRooms so eslint doesn't whine about unused param in a future
  // refactor; intentional no-op to keep the API symmetric for callers.
  void labeledRooms

  return {
    rooms,
    surfaces,
    objects,
  }
}

// Re-exports for consumers (CLI, tests, downstream packages).
export { submitVideoToLuma, pollLumaJob } from './luma-client.js'
export type { LumaSubmission } from './luma-client.js'
export { parseLabeledMesh, LabeledMesh as LabeledMeshSchema } from './labeled-mesh.js'
export type { LabeledMesh, LabeledRoom, LabeledSurface, LabeledSurfaceKind } from './labeled-mesh.js'

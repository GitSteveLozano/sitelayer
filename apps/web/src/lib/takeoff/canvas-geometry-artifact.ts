import type { BlueprintDocument, BlueprintPage, TakeoffMeasurement } from '../api/takeoff'
import { uploadCaptureArtifact, type CaptureArtifactUploadResponse } from '../api/capture-sessions'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export interface CanvasGeometryViewport {
  zoom?: number
  pan?: { x: number; y: number } | null
  mode?: string | null
  tool?: string | null
}

export interface BuildCanvasGeometryArtifactInput {
  project_id: string
  route_path?: string | null
  active_draft_id?: string | null
  active_blueprint_id?: string | null
  active_page_id?: string | null
  blueprint?: BlueprintDocument | null
  page?: BlueprintPage | null
  viewport?: CanvasGeometryViewport | null
  draft?: Record<string, unknown> | null
  selection?: Record<string, unknown> | null
  measurements: readonly TakeoffMeasurement[]
  captured_at?: string
}

export interface CanvasGeometryArtifactPayload {
  schema_version: 1
  artifact_type: 'takeoff.canvas_geometry'
  captured_at: string
  project_id: string
  route_path: string | null
  active_draft_id: string | null
  active_blueprint_id: string | null
  active_page_id: string | null
  blueprint: JsonObject | null
  page: JsonObject | null
  viewport: JsonObject | null
  draft: JsonObject | null
  selection: JsonObject | null
  measurements: JsonObject[]
  stats: {
    measurement_count: number
    geometry_kinds: string[]
    omitted_image_thumbnail_count: number
  }
}

const MAX_STRING_LENGTH = 10_000
const MAX_JSON_DEPTH = 8
const OMITTED_DATA_URL = '[omitted-data-url]'
const SENSITIVE_KEYS = new Set([
  'blob',
  'file',
  'file_url',
  'image',
  'image_thumbnail',
  'imageThumbnail',
  'photo',
  'storage_key',
  'storage_path',
  'thumbnail',
  'uri',
])

export function buildCanvasGeometryArtifact(input: BuildCanvasGeometryArtifactInput): CanvasGeometryArtifactPayload {
  const omittedImageThumbnailCount = input.measurements.reduce(
    (count, measurement) => count + (measurement.image_thumbnail ? 1 : 0),
    0,
  )
  const measurements = input.measurements.map((measurement) => sanitizeMeasurement(measurement))
  const geometryKinds = Array.from(
    new Set(
      measurements
        .map((measurement) => {
          const geometry = measurement.geometry
          return geometry && typeof geometry === 'object' && !Array.isArray(geometry) ? geometry.kind : null
        })
        .filter((kind): kind is string => typeof kind === 'string' && kind.length > 0),
    ),
  ).sort()

  return {
    schema_version: 1,
    artifact_type: 'takeoff.canvas_geometry',
    captured_at: input.captured_at ?? new Date().toISOString(),
    project_id: input.project_id,
    route_path: normalizeRoutePath(input.route_path),
    active_draft_id: input.active_draft_id ?? null,
    active_blueprint_id: input.active_blueprint_id ?? null,
    active_page_id: input.active_page_id ?? null,
    blueprint: input.blueprint ? sanitizeBlueprint(input.blueprint) : null,
    page: input.page ? sanitizePage(input.page) : null,
    viewport: sanitizeJsonObject(input.viewport),
    draft: sanitizeJsonObject(input.draft),
    selection: sanitizeJsonObject(input.selection),
    measurements,
    stats: {
      measurement_count: measurements.length,
      geometry_kinds: geometryKinds,
      omitted_image_thumbnail_count: omittedImageThumbnailCount,
    },
  }
}

export function canvasGeometryArtifactBlob(payload: CanvasGeometryArtifactPayload): Blob {
  return new Blob([JSON.stringify(payload)], { type: 'application/json' })
}

export async function uploadCanvasGeometryArtifact(
  captureSessionId: string,
  payload: CanvasGeometryArtifactPayload,
  metadata: Record<string, unknown> = {},
): Promise<CaptureArtifactUploadResponse> {
  return uploadCaptureArtifact(captureSessionId, {
    kind: 'canvas_geometry',
    file: canvasGeometryArtifactBlob(payload),
    fileName: 'canvas-geometry.json',
    client_upload_id: `canvas_geometry:${captureSessionId}:${payload.active_draft_id ?? payload.active_blueprint_id ?? 'session'}`,
    pii_level: 'internal',
    access_policy: 'support_only',
    metadata: {
      source: 'takeoff_canvas',
      artifact_type: payload.artifact_type,
      schema_version: payload.schema_version,
      project_id: payload.project_id,
      route_path: payload.route_path,
      active_draft_id: payload.active_draft_id,
      active_blueprint_id: payload.active_blueprint_id,
      active_page_id: payload.active_page_id,
      measurement_count: payload.stats.measurement_count,
      ...metadata,
    },
  })
}

function sanitizeMeasurement(measurement: TakeoffMeasurement): JsonObject {
  return stripUndefined({
    id: measurement.id,
    project_id: measurement.project_id,
    blueprint_document_id: measurement.blueprint_document_id,
    page_id: measurement.page_id,
    service_item_code: measurement.service_item_code,
    quantity: measurement.quantity,
    unit: measurement.unit,
    notes: measurement.notes,
    elevation: measurement.elevation,
    geometry: sanitizeGeometry(measurement.geometry),
    is_deduction: measurement.is_deduction ?? false,
    assembly_id: measurement.assembly_id ?? null,
    version: measurement.version,
    created_at: measurement.created_at,
  })
}

function sanitizeGeometry(raw: TakeoffMeasurement['geometry']): JsonObject {
  const base = sanitizeJsonObject(raw) ?? {}
  if ('points' in base && Array.isArray(base.points)) {
    base.points = base.points
      .map((point) => sanitizePoint(point))
      .filter((point): point is JsonObject => point !== null)
  }
  if ('polygon' in base && Array.isArray(base.polygon)) {
    base.polygon = base.polygon
      .map((point) => sanitizeNumberPair(point))
      .filter((point): point is JsonValue[] => point !== null)
  }
  return base
}

function sanitizeBlueprint(blueprint: BlueprintDocument): JsonObject {
  return stripUndefined({
    id: blueprint.id,
    project_id: blueprint.project_id,
    file_name: blueprint.file_name,
    preview_type: blueprint.preview_type,
    calibration_length: blueprint.calibration_length,
    calibration_unit: blueprint.calibration_unit,
    sheet_scale: blueprint.sheet_scale,
    version: blueprint.version,
    deleted_at: blueprint.deleted_at,
    replaces_blueprint_document_id: blueprint.replaces_blueprint_document_id,
    created_at: blueprint.created_at,
  })
}

function sanitizePage(page: BlueprintPage): JsonObject {
  return stripUndefined({
    id: page.id,
    blueprint_document_id: page.blueprint_document_id,
    page_number: page.page_number,
    calibration_world_distance: page.calibration_world_distance,
    calibration_world_unit: page.calibration_world_unit,
    calibration_x1: page.calibration_x1,
    calibration_y1: page.calibration_y1,
    calibration_x2: page.calibration_x2,
    calibration_y2: page.calibration_y2,
    calibration_set_at: page.calibration_set_at,
    scale_verified_at: page.scale_verified_at,
    scale_verified_by: page.scale_verified_by,
    measurement_count: page.measurement_count,
  })
}

function sanitizePoint(value: JsonValue): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const x = finiteNumber((value as JsonObject).x)
  const y = finiteNumber((value as JsonObject).y)
  return x == null || y == null ? null : { x, y }
}

function sanitizeNumberPair(value: JsonValue): JsonValue[] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const x = finiteNumber(value[0])
  const y = finiteNumber(value[1])
  return x == null || y == null ? null : [x, y]
}

function sanitizeJsonObject(value: unknown): JsonObject | null {
  const sanitized = sanitizeJsonValue(value, 0, new WeakSet<object>())
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : null
}

function sanitizeJsonValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return sanitizeString(value)
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) return []
    return value
      .map((entry) => sanitizeJsonValue(entry, depth + 1, seen))
      .filter((entry): entry is JsonValue => entry !== undefined)
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  if (depth >= MAX_JSON_DEPTH) return {}
  seen.add(value)
  const out: JsonObject = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) continue
    const sanitized = sanitizeJsonValue(entry, depth + 1, seen)
    if (sanitized !== undefined) out[key] = sanitized
  }
  seen.delete(value)
  return out
}

function sanitizeString(value: string): string {
  const trimmed = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value
  return trimmed.trimStart().toLowerCase().startsWith('data:') ? OMITTED_DATA_URL : trimmed
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stripUndefined(input: Record<string, JsonValue | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function normalizeRoutePath(routePath: string | null | undefined): string | null {
  const trimmed = routePath?.trim()
  if (!trimmed) return null
  const [pathOnly] = trimmed.split(/[?#]/, 1)
  return pathOnly || null
}

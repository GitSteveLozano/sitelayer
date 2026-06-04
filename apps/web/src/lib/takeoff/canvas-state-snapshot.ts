import type { BlueprintDocument, BlueprintPage, TakeoffMeasurement } from '../api/takeoff'
import type { TakeoffDraft } from '../api/takeoff-drafts'
import type { CaptureStateProviderSnapshot } from '../capture-state-providers'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export interface BuildTakeoffCanvasStateSnapshotInput {
  surface: 'desktop_est_canvas' | 'mobile_takeoff' | 'project_takeoff_canvas'
  project_id: string
  route_path?: string | null
  reason: string
  active_draft?: TakeoffDraft | null
  active_blueprint?: BlueprintDocument | null
  active_page?: BlueprintPage | null
  viewport?: Record<string, unknown> | null
  session?: Record<string, unknown> | null
  draft?: Record<string, unknown> | null
  selection?: Record<string, unknown> | null
  measurements: readonly TakeoffMeasurement[]
}

export function buildTakeoffCanvasStateSnapshot(
  input: BuildTakeoffCanvasStateSnapshotInput,
): CaptureStateProviderSnapshot {
  const measurementStats = summarizeMeasurements(input.measurements)
  return {
    schema: 'sitelayer.takeoff.canvas-state.v1',
    kind: 'state_snapshot',
    piiLevel: 'internal',
    metadata: {
      route_state: true,
      surface: input.surface,
      project_id: input.project_id,
      measurement_count: measurementStats.measurement_count,
    },
    payload: {
      schema_version: 1,
      captured_surface: input.surface,
      reason: input.reason,
      project_id: input.project_id,
      route_path: normalizeRoutePath(input.route_path),
      active_draft: summarizeDraft(input.active_draft),
      active_blueprint: summarizeBlueprint(input.active_blueprint),
      active_page: summarizePage(input.active_page),
      viewport: sanitizeRecord(input.viewport),
      session: sanitizeRecord(input.session),
      draft: summarizeDraftState(input.draft),
      selection: sanitizeRecord(input.selection),
      measurements: measurementStats,
    },
  }
}

function summarizeDraft(draft: TakeoffDraft | null | undefined): JsonObject | null {
  if (!draft) return null
  return stripUndefined({
    id: draft.id,
    name: draft.name,
    type: draft.type,
    kind: draft.kind ?? null,
    status: draft.status,
    version: draft.version,
    source: draft.source ?? null,
    review_required: draft.review_required ?? null,
    pipeline_version: draft.pipeline_version ?? null,
  })
}

function summarizeBlueprint(blueprint: BlueprintDocument | null | undefined): JsonObject | null {
  if (!blueprint) return null
  return stripUndefined({
    id: blueprint.id,
    project_id: blueprint.project_id,
    file_name: blueprint.file_name,
    preview_type: blueprint.preview_type,
    version: blueprint.version,
    sheet_scale: blueprint.sheet_scale,
    calibration_length: blueprint.calibration_length,
    calibration_unit: blueprint.calibration_unit,
    replaces_blueprint_document_id: blueprint.replaces_blueprint_document_id,
  })
}

function summarizePage(page: BlueprintPage | null | undefined): JsonObject | null {
  if (!page) return null
  return stripUndefined({
    id: page.id,
    blueprint_document_id: page.blueprint_document_id,
    page_number: page.page_number,
    measurement_count: page.measurement_count,
    scale_verified: Boolean(page.scale_verified_at),
    calibration_set: Boolean(page.calibration_set_at),
    calibration_world_unit: page.calibration_world_unit,
  })
}

function summarizeDraftState(value: Record<string, unknown> | null | undefined): JsonObject | null {
  const base = sanitizeRecord(value)
  if (!base) return null
  if (Array.isArray(base.points)) base.point_count = base.points.length
  if (Array.isArray(base.scale_points)) base.scale_point_count = base.scale_points.length
  if (Array.isArray(base.edit_points)) base.edit_point_count = base.edit_points.length
  delete base.points
  delete base.scale_points
  delete base.edit_points
  return base
}

function summarizeMeasurements(measurements: readonly TakeoffMeasurement[]): JsonObject {
  const byKind: Record<string, number> = {}
  const byServiceItem: Record<string, number> = {}
  let deductionCount = 0
  let assemblyCount = 0
  for (const measurement of measurements) {
    const geometry = measurement.geometry as Record<string, unknown> | null
    const kind = typeof geometry?.kind === 'string' && geometry.kind.trim() ? geometry.kind.trim() : 'unknown'
    byKind[kind] = (byKind[kind] ?? 0) + 1
    const code = measurement.service_item_code || 'unknown'
    byServiceItem[code] = (byServiceItem[code] ?? 0) + 1
    if (measurement.is_deduction) deductionCount += 1
    if (measurement.assembly_id) assemblyCount += 1
  }
  return {
    measurement_count: measurements.length,
    by_kind: sortCountMap(byKind),
    top_service_items: sortCountMap(byServiceItem).slice(0, 12),
    deduction_count: deductionCount,
    assembly_count: assemblyCount,
  }
}

function sortCountMap(map: Record<string, number>): JsonObject[] {
  return Object.entries(map)
    .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))
    .map(([id, count]) => ({ id, count }))
}

function sanitizeRecord(value: Record<string, unknown> | null | undefined): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue
    const sanitized = sanitizeValue(entry, 0)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return Object.keys(out).length > 0 ? out : null
}

function sanitizeValue(value: unknown, depth: number): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) : value
  if (Array.isArray(value)) {
    if (depth >= 4) return []
    return value
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry): entry is JsonValue => entry !== undefined)
  }
  if (typeof value !== 'object') return undefined
  if (depth >= 4) return {}
  const out: JsonObject = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) continue
    const sanitized = sanitizeValue(entry, depth + 1)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('storage_path') ||
    normalized.includes('storage_key') ||
    normalized.includes('file_url') ||
    normalized.includes('image_thumbnail')
  )
}

function normalizeRoutePath(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value, 'https://sitelayer.local').pathname
  } catch {
    return value.split('?')[0] || null
  }
}

function stripUndefined(value: Record<string, unknown>): JsonObject {
  const out: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeValue(entry, 0)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

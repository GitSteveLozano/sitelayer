// Phase 3 takeoff resource layer — tags, pages, assemblies, import,
// QBO custom-field mappings, and the polygon-canvas data layer
// (blueprints + measurements + measurement create).
//
// Offline-queue policy for this resource:
//   - `useCreateMeasurement` is wrapped in `liveOrQueueCreateMeasurement`.
//     Field foremen draw measurements on-site while the LTE connection
//     fades in and out; a NetworkError enqueues into the
//     `takeoff_measurement_create` kind so the polygon doesn't vanish
//     on a tap that happens to land during an offline window.
//   - Delete / tag / calibrate / assembly / import / QBO-mapping
//     mutations are office-side or admin actions and stay live — they
//     happen on stable connections and any failure should surface to
//     the user immediately rather than silently queue.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, API_URL, buildAuthHeaders, NetworkError, request } from './client'

// ---------------------------------------------------------------------------
// Blueprints + measurements (Phase 3 polygon canvas)
// ---------------------------------------------------------------------------

export interface BlueprintDocument {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  preview_type: string
  calibration_length: string | null
  calibration_unit: string | null
  sheet_scale: string | null
  version: number
  deleted_at: string | null
  replaces_blueprint_document_id: string | null
  file_url?: string
  created_at: string
}

export interface MeasurementGeometry {
  kind: 'polygon' | 'lineal' | 'volume' | 'count'
  points?: Array<{ x: number; y: number }>
  length?: number
  width?: number
  height?: number
  /**
   * Per-axis real-world distance per board unit, written at save time from the
   * page calibration + page aspect so the server computes true sqft/lf instead
   * of board-space area. Absent ⇒ uncalibrated ⇒ board-space (legacy). See
   * `lib/takeoff/world-scale.ts` and `@sitelayer/domain` calculateGeometryQuantity.
   */
  world_per_board_x?: number
  world_per_board_y?: number
  /**
   * Optional roof/slope pitch driver (rise:run, e.g. 6:12). When present the
   * server multiplies the scaled area/length by `√(rise²+run²)/run` so sloped
   * cladding/gables read true surface area. Stored inside this JSONB geometry —
   * no column. Absent ⇒ flat/vertical ⇒ factor 1.0. See `@sitelayer/domain`
   * `slopeFactor` / `calculateGeometryQuantity` (deep-dive H2).
   */
  pitch?: { rise: number; run: number }
}

/**
 * Geometry persisted for a promoted capture-pipeline measurement (blueprint
 * vision, drone, roomplan, photogrammetry), written by the takeoff-drafts
 * promote path. `polygon` is `[x, y]` pairs in the source's own coordinate
 * space (image pixels, lat/lon, …); `surfaceId`/`refs` trace back to the
 * captured artifact. The 3D preview normalizes it to relative scale.
 */
export interface CaptureGeometry {
  kind: 'capture'
  surfaceId?: string
  refs?: string[]
  polygon?: number[][]
  /** Blueprint captures only: pixels-per-foot for the pixel-space polygon, so
   *  the 3D preview can render at true scale instead of relative. */
  pixelsPerFoot?: number
  /** Coordinate space of `polygon` when it isn't board/pixel space. `'lonlat'`
   *  = drone GeoJSON `[lon, lat]`, projected to feet for true-scale render. */
  coordSpace?: 'lonlat'
}

export interface TakeoffMeasurement {
  id: string
  project_id: string
  blueprint_document_id: string | null
  page_id: string | null
  service_item_code: string
  quantity: string
  unit: string
  notes: string | null
  /** First-class elevation tag (Sitemap §5 panel 1). Replaces the `elev:<tag>` notes prefix. */
  elevation: string | null
  /**
   * Inline data-URL thumbnail for photo-measure (Sitemap §5 panel 3).
   * 200KB cap enforced server-side; null for non-photo measurements.
   * Spaces-backed full-resolution upload lands as a follow-on.
   */
  image_thumbnail: string | null
  geometry: MeasurementGeometry | CaptureGeometry | Record<string, never>
  /** PlanSwift Phase 1 cutout/deduct: when true this polygon is a deduction (e.g. a window/door opening) and its area subtracts from the net for its service item. */
  is_deduction?: boolean
  /**
   * PlanSwift Phase 2: when set, this measurement is attached to an assembly
   * recipe — recompute explodes it into N priced material/labor/sub/freight
   * lines instead of one flat line. NULL = flat-line behavior (the default).
   */
  assembly_id?: string | null
  /**
   * Condition layer (Takeoff Deep Dive H1): the reusable typed template this
   * measurement was drawn against, or null for the legacy shape-first flow.
   * Additive — the canvas legend groups by it; the tag flow stays the fallback.
   */
  condition_id?: string | null
  version: number
  created_at: string
}

export function useProjectBlueprints(projectId: string | null | undefined) {
  return useQuery<{ blueprints: BlueprintDocument[] }>({
    queryKey: ['blueprints', 'by-project', projectId ?? ''],
    queryFn: () => request(`/api/projects/${encodeURIComponent(projectId!)}/blueprints`),
    enabled: Boolean(projectId),
  })
}

// ---------------------------------------------------------------------------
// Blueprint upload (multipart → DO Spaces)
// ---------------------------------------------------------------------------

export interface UploadBlueprintOptions {
  /** Override the stored file name; defaults to the File's own name. */
  fileName?: string
}

/**
 * Upload one blueprint (PDF or image). Mirrors `uploadDailyLogPhoto` — a
 * FormData multipart POST so the PDF streams straight into Spaces via the
 * API's busboy handler (`apps/api/src/blueprint-upload.ts`). The browser
 * sets the multipart boundary on content-type; we must NOT set it. The
 * server requires only the `blueprint_file` part (+ optional `file_name`).
 * Returns the inserted `BlueprintDocument` row (API responds 201).
 */
export async function uploadBlueprint(
  projectId: string,
  file: File,
  opts: UploadBlueprintOptions = {},
): Promise<BlueprintDocument> {
  const formData = new FormData()
  formData.append('blueprint_file', file, file.name || 'blueprint.pdf')
  const fileName = opts.fileName ?? file.name
  if (fileName) formData.append('file_name', fileName)
  const headers = await buildAuthHeaders()
  const path = `/api/projects/${encodeURIComponent(projectId)}/blueprints`

  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id')
    let body: unknown
    try {
      const ct = response.headers.get('content-type') ?? ''
      body = ct.includes('application/json') ? await response.json() : await response.text()
    } catch {
      body = null
    }
    throw new ApiError({ status: response.status, path, method: 'POST', requestId, body })
  }
  return (await response.json()) as BlueprintDocument
}

export interface UseUploadBlueprintInput {
  file: File
  fileName?: string
}

/**
 * TanStack mutation wrapping `uploadBlueprint`. On success it invalidates
 * both the broad `['blueprints']` key (calibration/pages/import all live
 * under it) and the specific by-project list so the takeoff surfaces
 * refetch the new document. Accepts a bare `File` or `{ file, fileName }`.
 */
export function useUploadBlueprint(projectId: string) {
  const qc = useQueryClient()
  return useMutation<BlueprintDocument, Error, File | UseUploadBlueprintInput>({
    mutationFn: (input) => {
      if (input instanceof File) return uploadBlueprint(projectId, input)
      return uploadBlueprint(projectId, input.file, input.fileName ? { fileName: input.fileName } : {})
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blueprints'] })
      void qc.invalidateQueries({ queryKey: ['blueprints', 'by-project', projectId] })
    },
  })
}

export function useProjectMeasurements(
  projectId: string | null | undefined,
  options: { draftId?: string | null } = {},
) {
  const draftId = options.draftId ?? null
  return useQuery<{ measurements: TakeoffMeasurement[] }>({
    // Draft scope is part of the cache key so switching drafts swaps the
    // entire result set rather than mixing rows. `'__default'` is a
    // sentinel for "let the server fall back to the project's default
    // draft" — distinct from a user-picked uuid.
    queryKey: ['takeoff', 'measurements', 'by-project', projectId ?? '', draftId ?? '__default'],
    queryFn: () => {
      const qs = draftId ? `?draft_id=${encodeURIComponent(draftId)}` : ''
      return request(`/api/projects/${encodeURIComponent(projectId!)}/takeoff/measurements${qs}`)
    },
    enabled: Boolean(projectId),
  })
}

export interface CreateMeasurementInput {
  blueprint_document_id?: string | null
  page_id?: string | null
  service_item_code: string
  /** The item's curated division (e.g. D5 for Air Barrier). When omitted the API falls back to the project's division, which can trip the 422 catalog guard. */
  division_code?: string | null
  quantity?: number
  unit?: string
  notes?: string | null
  elevation?: string | null
  image_thumbnail?: string | null
  geometry: MeasurementGeometry
  /** PlanSwift Phase 1 cutout/deduct: mark this polygon as a deduction (e.g. a window/door opening). Its area subtracts from the net for its service item. */
  is_deduction?: boolean
  /** Phase A.2: route the measurement to a specific takeoff draft. When omitted, the API falls back to the project's default draft. */
  draft_id?: string | null
  /** Condition layer (Deep Dive H1): the reusable typed template this measurement is drawn against. NULL/omitted = legacy shape-first flow (the tag fallback is unaffected). */
  condition_id?: string | null
}

export type CreateMeasurementResult = TakeoffMeasurement | { queued: true }

async function liveOrQueueCreateMeasurement(
  projectId: string,
  input: CreateMeasurementInput,
): Promise<CreateMeasurementResult> {
  try {
    return await request<TakeoffMeasurement>(`/api/projects/${encodeURIComponent(projectId)}/takeoff/measurement`, {
      method: 'POST',
      json: input,
    })
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('takeoff_measurement_create', { projectId, input: { ...input } })
      return { queued: true }
    }
    throw err
  }
}

export function useCreateMeasurement(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CreateMeasurementResult, Error, CreateMeasurementInput>({
    mutationFn: (input) => liveOrQueueCreateMeasurement(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff'] }),
  })
}

export function useDeleteMeasurement() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; expected_version?: number }>({
    mutationFn: ({ id, expected_version }) =>
      request(`/api/takeoff/measurements/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        json: expected_version !== undefined ? { expected_version } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff'] }),
  })
}

export interface PatchMeasurementInput {
  id: string
  service_item_code?: string
  unit?: string
  notes?: string | null
  /** Toggle cutout/deduct on an existing measurement. */
  is_deduction?: boolean
  /**
   * PlanSwift Phase 2 — attach/detach an assembly recipe.
   *   uuid    → attach (validated server-side: active assembly for this company)
   *   null/'' → detach (back to the flat-line path)
   *   omitted → leave unchanged
   */
  assembly_id?: string | null
  /**
   * Replace the measurement's geometry (EDIT-GEOM vertex drag). The server
   * re-normalizes the geometry and recomputes `quantity` from it, so a dragged
   * vertex re-prices the takeoff. Omit to leave geometry unchanged.
   */
  geometry?: MeasurementGeometry
  expected_version?: number
}

/** Versioned update of a committed measurement (e.g. reassign its service item). */
export function usePatchMeasurement() {
  const qc = useQueryClient()
  return useMutation<TakeoffMeasurement, Error, PatchMeasurementInput>({
    mutationFn: ({ id, ...body }) =>
      request<TakeoffMeasurement>(`/api/takeoff/measurements/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff'] }),
  })
}

// ---------------------------------------------------------------------------
// Multi-condition tags (3A)
// ---------------------------------------------------------------------------

export interface TakeoffTag {
  id: string
  measurement_id: string
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  notes: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

const tagKey = (measurementId: string) => ['takeoff', 'tags', measurementId] as const

export function useTakeoffTags(measurementId: string | null | undefined) {
  return useQuery<{ tags: TakeoffTag[] }>({
    queryKey: tagKey(measurementId ?? ''),
    queryFn: () => request(`/api/takeoff/measurements/${encodeURIComponent(measurementId!)}/tags`),
    enabled: Boolean(measurementId),
  })
}

export function useAddTakeoffTag(measurementId: string) {
  const qc = useQueryClient()
  return useMutation<
    { tag: TakeoffTag },
    Error,
    { service_item_code: string; quantity: number; unit?: string; rate?: number; notes?: string }
  >({
    mutationFn: (input) =>
      request(`/api/takeoff/measurements/${encodeURIComponent(measurementId)}/tags`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tagKey(measurementId) }),
  })
}

export function useRemoveTakeoffTag(measurementId: string) {
  const qc = useQueryClient()
  return useMutation<unknown, Error, string>({
    mutationFn: (tagId) => request(`/api/takeoff/tags/${encodeURIComponent(tagId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tagKey(measurementId) }),
  })
}

export interface UpdateTakeoffTagInput {
  tagId: string
  service_item_code?: string
  quantity?: number
  unit?: string
  rate?: number
  notes?: string | null
}

export function useUpdateTakeoffTag(measurementId: string) {
  const qc = useQueryClient()
  return useMutation<{ tag: TakeoffTag }, Error, UpdateTakeoffTagInput>({
    mutationFn: ({ tagId, ...input }) =>
      request(`/api/takeoff/tags/${encodeURIComponent(tagId)}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tagKey(measurementId) }),
  })
}

// ---------------------------------------------------------------------------
// Blueprint pages + calibration (3B/C)
// ---------------------------------------------------------------------------

export interface BlueprintPage {
  id: string
  blueprint_document_id: string
  page_number: number
  storage_path: string | null
  calibration_world_distance: string | null
  calibration_world_unit: string | null
  calibration_x1: string | null
  calibration_y1: string | null
  calibration_x2: string | null
  calibration_y2: string | null
  calibration_set_at: string | null
  /** Per-sheet human scale sign-off (migration 123). Non-null ⇒ VERIFIED. */
  scale_verified_at: string | null
  scale_verified_by: string | null
  measurement_count: number
}

const pagesKey = (docId: string) => ['blueprints', 'pages', docId] as const

export function useBlueprintPages(docId: string | null | undefined) {
  return useQuery<{ pages: BlueprintPage[] }>({
    queryKey: pagesKey(docId ?? ''),
    queryFn: () => request(`/api/blueprints/${encodeURIComponent(docId!)}/pages`),
    enabled: Boolean(docId),
  })
}

export function useCalibratePage() {
  const qc = useQueryClient()
  return useMutation<
    { page: BlueprintPage },
    Error,
    { pageId: string; world_distance: number; world_unit: string; x1: number; y1: number; x2: number; y2: number }
  >({
    mutationFn: ({ pageId, ...input }) =>
      request(`/api/blueprint-pages/${encodeURIComponent(pageId)}/calibrate`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprints'] }),
  })
}

/**
 * Persist a per-sheet scale VERIFIED sign-off (EST · SCALE VERIFY, dsg__31).
 * Distinct from calibration: this is the estimator's "I trust this sheet's
 * scale" confirmation. `verified: false` clears it for re-review. Invalidates
 * the broad `['blueprints']` key so both the verify screen and the canvas
 * SHEETS panel refetch.
 */
export function useVerifyPage() {
  const qc = useQueryClient()
  return useMutation<{ page: BlueprintPage }, Error, { pageId: string; verified?: boolean }>({
    mutationFn: ({ pageId, verified = true }) =>
      request(`/api/blueprint-pages/${encodeURIComponent(pageId)}/verify`, {
        method: 'POST',
        json: { verified },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprints'] }),
  })
}

// ---------------------------------------------------------------------------
// Plan-revision diffs (H3)
// ---------------------------------------------------------------------------

/**
 * One stored region-of-change between plan revisions (migration 037
 * `blueprint_page_diffs`). `affected_measurement_ids` is the snapshot of
 * takeoff measurements whose centroid falls inside the changed bbox — the
 * cache that drives the "N measurements affected" badge. Numeric fields come
 * back as strings (pg numeric) per this codebase's convention.
 */
export interface BlueprintPageDiff {
  id: string
  new_page_id: string
  prior_page_id: string | null
  new_page_number: number
  prior_page_number: number | null
  change_kind: 'added' | 'removed' | 'modified'
  bbox_x: string
  bbox_y: string
  bbox_w: string
  bbox_h: string
  confidence: string
  affected_measurement_ids: string[]
  notes: string | null
  created_at: string
}

export interface BlueprintDiffsResponse {
  diffs: BlueprintPageDiff[]
  /** Deduped union of every diff's affected measurement ids (server rollup). */
  affected_measurement_ids: string[]
  affected_measurement_count: number
}

/**
 * Stored plan-revision diffs for a blueprint document (GET
 * /api/blueprints/:id/diffs). Returns an empty list when no diff worker has
 * populated rows yet, so callers can hide the badge on an empty result. The
 * route is read-only; diff population is a follow-up slice.
 */
export function useBlueprintDiffs(docId: string | null | undefined) {
  return useQuery<BlueprintDiffsResponse>({
    queryKey: ['blueprints', 'diffs', docId ?? ''],
    queryFn: () => request(`/api/blueprints/${encodeURIComponent(docId!)}/diffs`),
    enabled: Boolean(docId),
  })
}

// ---------------------------------------------------------------------------
// Assemblies (3F)
// ---------------------------------------------------------------------------

export interface Assembly {
  id: string
  service_item_code: string
  name: string
  description: string | null
  total_rate: string
  unit: string
  version: number
  created_at: string
  updated_at: string
}

export interface AssemblyComponent {
  id: string
  assembly_id: string
  kind: 'material' | 'labor' | 'sub' | 'freight'
  name: string
  quantity_per_unit: string
  unit: string
  unit_cost: string
  waste_pct: string
  sort_order: number
  /**
   * PlanSwift Phase 2 — optional quantity formula. When set, explode evaluates
   * it with `measurement_quantity` + `formula_vars` bound and the result
   * replaces the static `quantity_per_unit`. NULL = static-quantity path.
   */
  quantity_formula?: string | null
  /** Named vars bound when evaluating `quantity_formula` (e.g. `{ coverage_rate: 32 }`). */
  formula_vars?: Record<string, number | string> | null
}

const assemblyListKey = ['assemblies', 'list'] as const
const assemblyDetailKey = (id: string) => ['assemblies', 'detail', id] as const

export function useAssemblies(serviceItemCode?: string) {
  const qs = serviceItemCode ? `?service_item_code=${encodeURIComponent(serviceItemCode)}` : ''
  return useQuery<{ assemblies: Assembly[] }>({
    queryKey: [...assemblyListKey, serviceItemCode ?? ''],
    queryFn: () => request(`/api/assemblies${qs}`),
  })
}

export function useAssembly(id: string | null | undefined) {
  return useQuery<{ assembly: Assembly; components: AssemblyComponent[] }>({
    queryKey: assemblyDetailKey(id ?? ''),
    queryFn: () => request(`/api/assemblies/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  })
}

export function useCreateAssembly() {
  const qc = useQueryClient()
  return useMutation<
    { assembly: Assembly; components: AssemblyComponent[] },
    Error,
    { service_item_code: string; name: string; description?: string; unit?: string }
  >({
    mutationFn: (input) => request('/api/assemblies', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

export function useAddAssemblyComponent(assemblyId: string) {
  const qc = useQueryClient()
  return useMutation<
    { component: AssemblyComponent },
    Error,
    {
      kind: 'material' | 'labor' | 'sub' | 'freight'
      name: string
      quantity_per_unit: number
      unit: string
      unit_cost: number
      waste_pct?: number
      /** Phase 2 — optional quantity formula (validated server-side). */
      quantity_formula?: string | null
      formula_vars?: Record<string, number | string> | null
    }
  >({
    mutationFn: (input) =>
      request(`/api/assemblies/${encodeURIComponent(assemblyId)}/components`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assemblies'] }),
  })
}

// ---------------------------------------------------------------------------
// CSV import (3G)
// ---------------------------------------------------------------------------

export interface ImportRow {
  service_item_code: string
  quantity: number
  unit?: string
  rate?: number
  notes?: string
}

export function useImportTakeoff(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    { imported: number; source_label: string },
    Error,
    { rows: ImportRow[]; source_label?: string; page_id?: string }
  >({
    mutationFn: (input) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/takeoff/import`, { method: 'POST', json: input }),
    onSuccess: () => {
      // Imports add takeoff measurements (tags + measurements) and may
      // bump per-page measurement_count via DB trigger, so the
      // blueprints/pages cache also goes stale.
      qc.invalidateQueries({ queryKey: ['takeoff'] })
      qc.invalidateQueries({ queryKey: ['blueprints'] })
    },
  })
}

// ---------------------------------------------------------------------------
// QBO custom field mappings (3H)
// ---------------------------------------------------------------------------

export interface QboCustomFieldMapping {
  id: string
  entity_type: string
  field_name: string
  qbo_definition_id: string
  qbo_label: string | null
}

export function useQboCustomFields() {
  return useQuery<{ mappings: QboCustomFieldMapping[] }>({
    queryKey: ['qbo', 'custom-fields'],
    queryFn: () => request('/api/qbo/custom-fields'),
  })
}

export function useUpsertQboCustomField() {
  const qc = useQueryClient()
  return useMutation<
    { mapping: QboCustomFieldMapping },
    Error,
    {
      entity_type: 'Estimate' | 'Invoice' | 'Bill' | 'PurchaseOrder'
      field_name: string
      qbo_definition_id: string
      qbo_label?: string
      notes?: string
    }
  >({
    mutationFn: (input) => request('/api/qbo/custom-fields', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qbo', 'custom-fields'] }),
  })
}

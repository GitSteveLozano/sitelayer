// Multi-draft takeoff resource layer (Phase A.3 of MULTI_DRAFT_TAKEOFF_SPEC.md).
// Backed by the routes added in apps/api/src/routes/takeoff-drafts.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, API_URL, buildAuthHeaders, request, requestBlob } from './client'

export interface TakeoffDraft {
  id: string
  company_id: string
  project_id: string
  name: string
  /** Free-text discriminator. 'measurement' today; 'scaffolding' reserved for the future scaffolding-design tool. */
  type: string
  /**
   * Review-routing discriminator (migration 122), orthogonal to `source`
   * (which capture pipeline produced the geometry). 'takeoff' = area/measurement
   * auto-takeoff or a manual draft; 'count' = symbol auto-count. The AI queue
   * routes "Review draft →" to the count-review vs takeoff-review screen on this.
   */
  kind?: 'takeoff' | 'count'
  status: 'active' | 'archived'
  version: number
  /** Phase C: pipeline that produced this draft. 'manual' for canvas-authored drafts. */
  source?: 'manual' | 'roomplan' | 'photogrammetry' | 'drone' | 'blueprint_vision'
  /** Phase C: pipeline-supplied review flag — true when any quantity scored below the confidence floor. */
  review_required?: boolean
  /** Phase C: semver of the producing pipeline. Null for manual drafts. */
  pipeline_version?: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type CaptureKind = 'roomplan' | 'photogrammetry' | 'drone' | 'blueprint_vision'

export type CountSensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

/**
 * Per-symbol AI count scope (M1). Passed inside the capture `payload` as
 * `count_scope`; the blueprint_vision pipeline honors it (returns a per-symbol
 * count scoped to `sheets` at `sensitivity`) instead of a whole-draft takeoff.
 * Omit it (no symbol chosen) to keep the existing whole-draft behavior.
 */
export interface CaptureCountScope {
  symbol: { label: string; sheet?: string }
  sheets: string[]
  sensitivity: CountSensitivity
}

export interface CaptureRequestBody {
  /** Which capture pipeline to run (how the geometry is produced). */
  kind: CaptureKind
  /**
   * Review-routing discriminator persisted on the resulting draft (migration
   * 122). Omit (or 'takeoff') for the auto-takeoff flow; 'count' tags the
   * symbol auto-count flow so the AI queue routes its review to count-review.
   */
  draft_kind?: 'takeoff' | 'count'
  name?: string
  payload: Record<string, unknown>
}

/**
 * Build a capture payload for a per-symbol count run. Defaults `payload`'s
 * `dryRun` (deterministic stub — no Anthropic spend) and nests the validated
 * count scope under `count_scope`. Pass it as `payload` to `useCaptureTakeoffDraft`.
 */
export function countScopePayload(scope: CaptureCountScope): Record<string, unknown> {
  return { dryRun: true, count_scope: scope }
}

export interface CaptureResultSummary {
  quantities_count: number
  review_required: boolean
  capture_source: string
  /**
   * Live/dry-run discriminator (C1 follow-up). 'live' means the API actually
   * ran the Anthropic Claude-vision sheet read against the streamed multipart
   * PDF (BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY). 'dry-run' covers
   * every stub/demo/fallback path. Optional so an older API build that predates
   * the field still type-checks — the review UI treats absent as 'dry-run' and
   * keeps the demo badge.
   */
  mode?: 'live' | 'dry-run'
  geometry: { rooms: number; surfaces: number; objects: number }
  pipeline_version: string
}

export interface CaptureResponse {
  draft: TakeoffDraft
  result_summary: CaptureResultSummary
}

const draftsByProjectKey = (projectId: string, includeArchived: boolean) =>
  ['takeoff-drafts', 'by-project', projectId, includeArchived ? 'all' : 'active'] as const

export function useTakeoffDrafts(projectId: string | null | undefined, options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? false
  return useQuery<{ drafts: TakeoffDraft[] }>({
    queryKey: draftsByProjectKey(projectId ?? '', includeArchived),
    queryFn: () => {
      const qs = includeArchived ? '?include_archived=1' : ''
      return request(`/api/projects/${encodeURIComponent(projectId!)}/takeoff-drafts${qs}`)
    },
    enabled: Boolean(projectId),
  })
}

// ---------------------------------------------------------------------------
// Company-wide AI-takeoff review feed (Wave 5).
// Backed by GET /api/takeoff-drafts — capture-pipeline drafts across every
// project in the company, so the estimator's "Review drafts" lane renders
// one feed instead of an N+1 fan-out over the per-project hook above.
// ---------------------------------------------------------------------------

/** One row of the company-wide review feed. Projection of `takeoff_drafts`
 *  joined to `projects` for the human-readable project name; `quantities_count`
 *  is derived server-side from the stored `TakeoffResult`. */
export interface CompanyTakeoffDraft {
  id: string
  project_id: string
  project_name: string
  name: string
  source: 'roomplan' | 'photogrammetry' | 'drone' | 'blueprint_vision'
  /**
   * Review-routing discriminator (migration 122). 'count' drafts route to the
   * count-review screen; everything else (incl. legacy rows defaulted by the
   * migration) routes to takeoff-review. Optional so an older API build that
   * predates migration 122 still type-checks — the queue falls back to
   * 'takeoff' routing when absent.
   */
  kind?: 'takeoff' | 'count'
  review_required: boolean
  quantities_count: number
  created_at: string
}

export interface CompanyTakeoffDraftsFilters {
  /** Restrict to one capture pipeline (omit for all pipelines). */
  source?: CompanyTakeoffDraft['source']
  /** Only drafts the pipeline flagged for review. */
  reviewRequired?: boolean
}

const companyDraftsKey = (filters: CompanyTakeoffDraftsFilters) =>
  ['takeoff-drafts', 'company-feed', filters.source ?? 'all', filters.reviewRequired ? 'review' : 'any'] as const

/**
 * List capture-pipeline takeoff drafts across all of the company's projects.
 * Manual canvas drafts are excluded server-side — this feed only carries
 * drafts that need estimator review before promotion.
 */
export function useCompanyTakeoffDrafts(filters: CompanyTakeoffDraftsFilters = {}) {
  return useQuery<{ drafts: CompanyTakeoffDraft[] }>({
    queryKey: companyDraftsKey(filters),
    queryFn: () => {
      const qs = new URLSearchParams()
      if (filters.source) qs.set('source', filters.source)
      if (filters.reviewRequired) qs.set('review_required', '1')
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return request(`/api/takeoff-drafts${suffix}`)
    },
  })
}

export function useCreateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft }, Error, { name: string; type?: string }>({
    mutationFn: (input) =>
      request(`/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

export function useUpdateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    { draft: TakeoffDraft },
    Error,
    { id: string; name?: string; status?: 'active' | 'archived'; expected_version: number }
  >({
    mutationFn: ({ id, ...body }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

export function useDuplicateTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft; measurement_count: number }, Error, { id: string; name?: string }>({
    mutationFn: ({ id, name }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        json: name ? { name } : {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
      // Newly duplicated draft contains its source's measurements; the
      // canvas keys its measurement query on draft_id, so invalidate
      // everything under 'takeoff' to be safe.
      qc.invalidateQueries({ queryKey: ['takeoff'] })
    },
  })
}

export function useDeleteTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ draft: TakeoffDraft }, Error, { id: string }>({
    mutationFn: ({ id }) =>
      request(`/api/takeoff-drafts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] }),
  })
}

// ---------------------------------------------------------------------------
// Promote captured quantities → takeoff_measurements (Phase C.3 promote flow).
// The capture endpoint stashes a `TakeoffResult` on the draft. The operator
// reviews each `quantity` in the canvas, optionally remaps `service_item_code`,
// and POSTs the subset they want to commit as scope. The server inserts a
// `takeoff_measurements` row per accepted quantity and returns the resulting
// measurement list plus skipped diagnostics.
// ---------------------------------------------------------------------------

/** Minimal slice of `TakeoffResult` consumed by the promote UI. The full
 * schema lives in @sitelayer/capture-schema; we mirror just the fields
 * we render (id, code candidates, value/unit, confidence, geometry refs)
 * to avoid pulling the entire zod schema into the web bundle. */
export interface CapturedQuantity {
  id: string
  description: string
  masterformatCode?: string
  uniformatCode?: string
  omniclassCode?: string
  unit: string
  value: number
  confidence: number
  provenance?: { kind?: string }
  geometryRefs?: string[]
}

/** One synthesized symbol instance from a per-symbol count (M1). The pipeline
 *  emits these into `geometry.objects[]` (schema-valid home for symbol
 *  instances); each carries a `bbox` whose origin is the marker coordinate the
 *  review canvas overlays. `category` is the counted symbol's label. */
export interface CapturedGeometryObject {
  id: string
  category: string
  bbox?: number[]
}

export interface CapturedTakeoffResult {
  schemaVersion: string
  takeoffId: string
  projectId: string
  source: string
  pipelineVersion: string
  quantities: CapturedQuantity[]
  reviewRequired?: boolean
  /** Cross-pipeline geometry. For a per-symbol count, `objects[]` holds one
   *  entry per detected instance (M1). Optional — absent for whole-draft results. */
  geometry?: { objects?: CapturedGeometryObject[] }
}

/** A per-symbol count marker for the review canvas: the (x, y) origin of an
 *  instance's bbox plus a `low` flag for instances below the review floor. */
export interface CountMarker {
  id: string
  x: number
  y: number
  low: boolean
}

/**
 * Extract per-symbol count markers from a captured result. Reads the
 * synthesized `geometry.objects[]` (one per instance) and pairs each with the
 * count quantity's confidence to flag low-confidence marks. Returns an empty
 * array for whole-draft results (no objects), so callers can fall back to their
 * decorative marker layout.
 */
export function countMarkersFromResult(result: CapturedTakeoffResult | undefined): CountMarker[] {
  const objects = result?.geometry?.objects
  if (!Array.isArray(objects) || objects.length === 0) return []
  // The per-symbol count emits a single rolled-up quantity; treat its
  // confidence as the floor signal for the whole set. (A future live detector
  // can attach per-instance confidence; this stays additive when it does.)
  const countConfidence = result?.quantities?.[0]?.confidence ?? 1
  const low = countConfidence < 0.7
  const markers: CountMarker[] = []
  for (const o of objects) {
    if (!o || !Array.isArray(o.bbox) || o.bbox.length < 2) continue
    const x = o.bbox[0]
    const y = o.bbox[1]
    if (typeof x !== 'number' || typeof y !== 'number') continue
    markers.push({ id: o.id, x, y, low })
  }
  return markers
}

export interface DraftResultResponse {
  takeoff_result: CapturedTakeoffResult
  source: string
  review_required: boolean
  pipeline_version: string | null
}

const draftResultKey = (draftId: string) => ['takeoff-drafts', 'result', draftId] as const

export function useTakeoffDraftResult(draftId: string | null | undefined) {
  return useQuery<DraftResultResponse>({
    queryKey: draftResultKey(draftId ?? ''),
    queryFn: () => request(`/api/takeoff-drafts/${encodeURIComponent(draftId!)}/result`),
    enabled: Boolean(draftId),
    // Captured results are immutable for the life of the draft; a refetch
    // is only useful when the operator switches drafts (separate queryKey)
    // or after a fresh capture (handled by useCaptureTakeoffDraft's
    // onSuccess invalidation, which targets the by-project key — bump
    // this stale time so we don't re-pull the JSON on every focus.)
    staleTime: 60_000,
  })
}

export interface PromoteRequestBody {
  quantity_ids: string[]
  service_item_code_overrides?: Record<string, string>
}

export interface PromoteResponse {
  measurements: Array<Record<string, unknown>>
  promoted_count: number
  skipped_count: number
  skipped: Array<{ quantity_id: string; reason: string }>
}

export function usePromoteCapturedQuantities(projectId: string, draftId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation<PromoteResponse, Error, PromoteRequestBody>({
    mutationFn: (input) => {
      if (!draftId) {
        throw new Error('draft id is required to promote quantities')
      }
      return request<PromoteResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/${encodeURIComponent(draftId)}/promote`,
        {
          method: 'POST',
          json: input,
        },
      )
    },
    onSuccess: () => {
      // Invalidate measurements + estimate views — the new rows belong to
      // the active draft so any draft-scoped query needs to refetch.
      qc.invalidateQueries({ queryKey: ['takeoff'] })
      qc.invalidateQueries({ queryKey: ['estimate'] })
    },
  })
}

/**
 * Phase C: run one of the four capture pipelines (roomplan /
 * photogrammetry / drone / blueprint_vision) against a JSON payload
 * and land the result as a new takeoff draft. The server validates
 * `kind`, dispatches to the matching @sitelayer/pipe-* package, and
 * stashes the TakeoffResult on the new draft.
 */
export function useCaptureTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CaptureResponse, Error, CaptureRequestBody>({
    mutationFn: (input) =>
      request<CaptureResponse>(`/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/capture`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
    },
  })
}

// ---------------------------------------------------------------------------
// Live blueprint AI sheet-read (C1 follow-up).
// The dry-run capture above posts JSON ({ dryRun:true }) and never reaches
// `blueprint-vision.ts`'s live path. The live path needs a streamed
// `blueprint_file` multipart part PLUS the API reporting live mode is
// available (BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY). When both hold
// AND the project actually has a blueprint document, the setup screen streams
// the project's blueprint PDF here for a real Claude-vision read; otherwise it
// falls back to `useCaptureTakeoffDraft` (dry-run + demo badge).
// ---------------------------------------------------------------------------

/**
 * Whether the API reports the live blueprint AI sheet-read path is available.
 * Reads the public `/api/features` snapshot (`blueprint_vision_live`). Cached
 * for the page lifetime — the env gate doesn't change without a redeploy
 * (which restarts the SPA via the stale-chunk boundary). Absent/false ⇒ the
 * setup screen stays on the dry-run/demo path.
 */
export function useBlueprintVisionLiveAvailable() {
  return useQuery<{ blueprint_vision_live: boolean }, Error, boolean>({
    queryKey: ['features', 'blueprint-vision-live'],
    queryFn: () =>
      request<{ blueprint_vision_live?: boolean }>('/api/features', { skipAuth: true }).then((res) => ({
        blueprint_vision_live: res.blueprint_vision_live === true,
      })),
    select: (data) => data.blueprint_vision_live,
    staleTime: 5 * 60_000,
  })
}

export interface CaptureLiveInput {
  /** The project's blueprint PDF bytes, streamed as the `blueprint_file` part. */
  file: File
  name?: string
  /** Review-routing discriminator persisted on the draft (migration 122). */
  draftKind?: 'takeoff' | 'count'
  /**
   * Optional pipeline knobs smuggled as a JSON `payload` field on the
   * multipart body (the API re-parses it). knownDimensionFt / wallHeightFt /
   * model are honoured by the live Anthropic path.
   */
  payload?: Record<string, unknown>
}

/**
 * Stream the project's blueprint PDF to the capture endpoint as
 * multipart/form-data so the API runs the live Claude-vision sheet read.
 * Mirrors `uploadBlueprint` / `uploadDailyLogPhoto` — FormData body, auth
 * headers from `buildAuthHeaders`, and the browser owns the multipart
 * boundary (we must NOT set content-type). The server infers
 * kind='blueprint_vision' from the multipart branch; we still send `kind`
 * + `draft_kind` explicitly to stay symmetric with the JSON path.
 */
export async function captureBlueprintVisionLive(projectId: string, input: CaptureLiveInput): Promise<CaptureResponse> {
  const formData = new FormData()
  formData.append('blueprint_file', input.file, input.file.name || 'blueprint.pdf')
  formData.append('kind', 'blueprint_vision')
  formData.append('draft_kind', input.draftKind ?? 'takeoff')
  if (input.name) formData.append('name', input.name)
  // The multipart branch defaults payload to {}; only attach one when the
  // caller supplied pipeline knobs so we don't send an empty JSON string.
  if (input.payload && Object.keys(input.payload).length > 0) {
    formData.append('payload', JSON.stringify(input.payload))
  }

  const headers = await buildAuthHeaders()
  const path = `/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/capture`
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
  return (await response.json()) as CaptureResponse
}

/**
 * Download a stored blueprint document's bytes and wrap them in a `File` so
 * the live capture path can re-stream them as the `blueprint_file` multipart
 * part. The bytes come back through the authenticated `/api/blueprints/:id/file`
 * route (which serves the PDF inline or 302s to a presigned URL — fetch follows
 * both). `fileName` keeps the original name + extension so the API infers the
 * right mime type.
 */
export async function fetchBlueprintFile(blueprintId: string, fileName: string): Promise<File> {
  const blob = await requestBlob(`/api/blueprints/${encodeURIComponent(blueprintId)}/file`)
  const safeName = fileName.trim() || 'blueprint.pdf'
  const type = blob.type || 'application/pdf'
  return new File([blob], safeName, { type })
}

/**
 * Mutation wrapping `captureBlueprintVisionLive`. Invalidates the project's
 * draft list on success just like `useCaptureTakeoffDraft`.
 */
export function useCaptureBlueprintVisionLive(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CaptureResponse, Error, CaptureLiveInput>({
    mutationFn: (input) => captureBlueprintVisionLive(projectId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
    },
  })
}

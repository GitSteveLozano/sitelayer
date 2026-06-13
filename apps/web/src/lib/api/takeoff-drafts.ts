// Multi-draft takeoff resource layer (Phase A.3 of MULTI_DRAFT_TAKEOFF_SPEC.md).
// Backed by the routes added in apps/api/src/routes/takeoff-drafts.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { REVIEW_CONFIDENCE_FLOOR } from '../../machines/takeoff-confidence'
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
  /**
   * Async-capture lifecycle (migration 018). 'processing' = a live capture is
   * running on the worker; 'failed' = the provider read errored (see
   * `capture_error`); 'ready' = reviewable (manual + pre-migration rows are
   * 'ready'). Optional so an older API build that predates the column still
   * type-checks — absent is treated as 'ready'.
   */
  capture_status?: CaptureStatus
  /** Honest output discriminator — see {@link CaptureProvenance}. Null for
   *  manual drafts, pre-migration rows, and processing/failed drafts. */
  capture_provenance?: CaptureProvenance | null
  /** Provider error string for capture_status='failed'; null otherwise. */
  capture_error?: string | null
  /** REAL provider token usage for live captures (never estimated). Null on
   *  manual / dry-run / pre-migration rows. */
  capture_token_usage?: CaptureTokenUsage | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** Async-capture lifecycle states on a takeoff draft (migration 018). */
export type CaptureStatus = 'processing' | 'ready' | 'failed'

/**
 * Honest discriminator for what actually produced a draft's quantities:
 *   - 'gemini-live' / 'anthropic-live' — a REAL provider sheet read.
 *   - 'stub-dry-run' — deterministic demo/stub rows (blueprint dry-run, count
 *     stub). Must NEVER be presented as a real extraction.
 *   - 'deterministic' — real-input parse (roomplan / photogrammetry / drone).
 */
export type CaptureProvenance = 'gemini-live' | 'anthropic-live' | 'stub-dry-run' | 'deterministic'

/** REAL provider token usage stored on the draft. Token fields are null when
 *  the provider response omitted them — they are never estimated. */
export interface CaptureTokenUsage {
  provider: string
  model: string
  input_tokens: number | null
  output_tokens: number | null
}

/**
 * Demo-vs-real classifier for the review badges. `'stub-dry-run'` is the only
 * provenance that means demo data; the two `*-live` values and 'deterministic'
 * are real output. When provenance is absent (older API / pre-migration row /
 * still processing) the caller's fallback decides — pass the conservative
 * value for the surface (the takeoff review screens fall back to their
 * navigation-state capture mode, defaulting to demo).
 */
export function isLiveProvenance(provenance: CaptureProvenance | string | null | undefined): boolean | null {
  if (provenance == null) return null
  return provenance === 'gemini-live' || provenance === 'anthropic-live'
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
  /**
   * Async-capture split (2026-06-12): 'ready' = synchronous capture, result is
   * on the draft now (201). 'processing' = LIVE capture accepted and queued on
   * the worker (202) — NO result is returned inline; poll
   * GET /api/takeoff-drafts/:id/result until status leaves 'processing'.
   * Optional so an older API build that predates the field still type-checks
   * (absent ⇒ 'ready', the old synchronous contract).
   */
  status?: 'ready' | 'processing'
  /** Which provider the worker will call — only on 202 'processing' responses. */
  provider?: 'gemini' | 'anthropic'
  quantities_count: number
  review_required: boolean
  /** Absent on 202 'processing' responses (no result exists yet). */
  capture_source?: string
  /**
   * Live/dry-run discriminator (C1 follow-up). 'live' means the API queued a
   * REAL provider sheet read (202). 'dry-run' covers every synchronous
   * stub/demo/deterministic path (back-compat with the demo badge). Optional so
   * an older API build that predates the field still type-checks — the review
   * UI treats absent as 'dry-run' and keeps the demo badge.
   */
  mode?: 'live' | 'dry-run'
  /** Honest output discriminator on synchronous (201) responses:
   *  'stub-dry-run' (demo rows) or 'deterministic' (real-input parse).
   *  Null on 202 'processing' responses (poll for the final provenance). */
  provenance?: CaptureProvenance | null
  /** Absent on 202 'processing' responses. */
  geometry?: { rooms: number; surfaces: number; objects: number }
  /** Absent on 202 'processing' responses. */
  pipeline_version?: string
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

/** A captured room metric record. Mirrors `TakeoffGeometry.rooms[]` in
 *  @sitelayer/capture-schema (web keeps a structural slice so the zod schema
 *  never lands in the web bundle). Rooms carry metrics, not polygons — the
 *  drawable footprint lives on `surfaces[]`. */
export interface CapturedGeometryRoom {
  id: string
  label?: string
  story?: number
  floorAreaSqFt?: number
  perimeterLf?: number
}

/** A captured surface record. Mirrors `TakeoffGeometry.surfaces[]` in
 *  @sitelayer/capture-schema. `polygon` (when present) is the drawable boundary
 *  in the source pipeline's own coordinate space (image pixels / lon-lat). */
export interface CapturedGeometrySurface {
  id: string
  kind: 'wall' | 'floor' | 'ceiling' | 'roof' | 'facade' | 'opening'
  parentRoomId?: string
  areaSqFt?: number
  polygon?: number[][]
}

/** A captured wall line. Mirrors `TakeoffGeometry.walls[]` in
 *  @sitelayer/capture-schema. Unlike a `surface.polygon` (flat footprint), a wall
 *  is a vertical plane: the 3D adapter extrudes the `start`→`end` plan-view run up
 *  by `heightFt`. Coordinates share the surface-polygon convention (`[x, y]` =
 *  plan-view east/south, feet for RoomPlan). */
export interface CapturedGeometryWall {
  id: string
  parentRoomId?: string
  start: [number, number]
  end: [number, number]
  heightFt: number
  thicknessFt?: number
}

/** The cross-pipeline geometry block of a captured `TakeoffResult`. A
 *  structural slice of `TakeoffGeometry` (@sitelayer/capture-schema) covering
 *  the fields the web renders: per-symbol count `objects[]` (M1), the drawable
 *  `surfaces[]` / `rooms[]`, and captured wall lines `walls[]` consumed by the
 *  3D preview adapter. */
export interface CapturedGeometry {
  rooms?: CapturedGeometryRoom[]
  surfaces?: CapturedGeometrySurface[]
  objects?: CapturedGeometryObject[]
  walls?: CapturedGeometryWall[]
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
   *  entry per detected instance (M1); for a whole-draft capture, `surfaces[]`
   *  / `rooms[]` carry the drawable footprint the 3D preview adapter renders.
   *  Optional — absent for results that produced only rolled-up quantities. */
  geometry?: CapturedGeometry
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
export function countMarkersFromResult(result: CapturedTakeoffResult | null | undefined): CountMarker[] {
  const objects = result?.geometry?.objects
  if (!Array.isArray(objects) || objects.length === 0) return []
  // The per-symbol count emits a single rolled-up quantity; treat its
  // confidence as the floor signal for the whole set. (A future live detector
  // can attach per-instance confidence; this stays additive when it does.)
  const countConfidence = result?.quantities?.[0]?.confidence ?? 1
  const low = countConfidence < REVIEW_CONFIDENCE_FLOOR
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
  /**
   * Async-capture poll state (2026-06-12): 'processing' = the worker is still
   * running the live read (takeoff_result is null — keep polling); 'failed' =
   * the provider read errored (`error` carries the provider error string,
   * takeoff_result stays null — re-running is a fresh POST /capture);
   * 'ready' = reviewable. Optional so an older API build that predates the
   * field still type-checks (absent ⇒ 'ready', the old contract).
   */
  status?: CaptureStatus
  /** Provider error string when status='failed'; null/absent otherwise. */
  error?: string | null
  /** Null while status is 'processing' or 'failed'. */
  takeoff_result: CapturedTakeoffResult | null
  source: string
  review_required: boolean
  pipeline_version: string | null
  /** Honest output discriminator. Null while processing/failed and on
   *  pre-migration rows. */
  provenance?: CaptureProvenance | null
  /** REAL provider token usage. Null on dry-run / pre-migration rows. */
  token_usage?: CaptureTokenUsage | null
}

/** Normalized poll state for a draft-result response — absent status (older
 *  API build) means the old synchronous contract, i.e. 'ready'. */
export function draftResultStatus(data: DraftResultResponse | undefined): CaptureStatus | null {
  if (!data) return null
  return data.status ?? 'ready'
}

const draftResultKey = (draftId: string) => ['takeoff-drafts', 'result', draftId] as const

/** Poll cadence while a live capture is processing on the worker. Shared with
 *  the takeoff-session machine's runCapture poll loop. */
export const DRAFT_RESULT_PROCESSING_POLL_MS = 2_500

/** THE single draft-result fetch (wave-3 convergence) — used by the
 *  `useTakeoffDraftResult` query and the machine's runCapture poll loop. */
export function fetchTakeoffDraftResult(draftId: string): Promise<DraftResultResponse> {
  return request(`/api/takeoff-drafts/${encodeURIComponent(draftId)}/result`)
}

export function useTakeoffDraftResult(draftId: string | null | undefined) {
  return useQuery<DraftResultResponse>({
    queryKey: draftResultKey(draftId ?? ''),
    queryFn: () => fetchTakeoffDraftResult(draftId!),
    enabled: Boolean(draftId),
    // Ready results are immutable for the life of the draft; a refetch
    // is only useful when the operator switches drafts (separate queryKey)
    // or after a fresh capture (handled by useCaptureTakeoffDraft's
    // onSuccess invalidation, which targets the by-project key — bump
    // this stale time so we don't re-pull the JSON on every focus.)
    staleTime: 60_000,
    // Async live captures (2026-06-12): a 202'd capture lands the draft at
    // status='processing' and the worker transitions it to ready/failed.
    // House polling pattern (qbo-sync.ts): keep refetching while in flight,
    // stop the moment the status leaves 'processing'.
    refetchInterval: (query) =>
      draftResultStatus(query.state.data) === 'processing' ? DRAFT_RESULT_PROCESSING_POLL_MS : false,
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

/** One rejected service_item_code override from a 422 promote response. The
 *  server returns these when an operator-typed `service_item_code_overrides`
 *  value isn't in the company's curated `service_item_divisions` catalog. */
export interface PromoteRejection {
  quantity_id: string
  service_item_code: string
  reason: string
}

/**
 * Pull the curated-catalog rejections out of a failed promote. The promote
 * endpoint returns `422 { error, rejected[], rejected_codes[] }` when one or
 * more operator-typed code overrides aren't in `service_item_divisions`; this
 * digs that structured payload out of the thrown `ApiError` (whose `.body`
 * carries the JSON error body) so the review UI can highlight the offending
 * edit inputs instead of showing a bare error string. Returns `[]` for any
 * other failure shape.
 */
export function promoteRejectionsFromError(error: unknown): PromoteRejection[] {
  if (!(error instanceof ApiError)) return []
  const body = error.body
  if (!body || typeof body !== 'object') return []
  const rejected = (body as { rejected?: unknown }).rejected
  if (!Array.isArray(rejected)) return []
  const out: PromoteRejection[] = []
  for (const r of rejected) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    if (typeof row.quantity_id !== 'string' || typeof row.service_item_code !== 'string') continue
    out.push({
      quantity_id: row.quantity_id,
      service_item_code: row.service_item_code,
      reason: typeof row.reason === 'string' ? row.reason : 'not in curated catalog',
    })
  }
  return out
}

/**
 * THE single promote call site (wave-3 est-canvas review convergence). Every
 * promote path — the takeoff-session machine's `promoteCaptured` actor, the
 * `usePromoteCapturedQuantities` mutation behind AgentSuggestionsPanel, and
 * the count/auto-takeoff review screens — funnels through this function, so
 * the endpoint shape can never fork per surface again.
 */
export function promoteCapturedQuantities(
  projectId: string,
  draftId: string,
  input: PromoteRequestBody,
): Promise<PromoteResponse> {
  return request<PromoteResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/${encodeURIComponent(draftId)}/promote`,
    {
      method: 'POST',
      json: input,
    },
  )
}

export function usePromoteCapturedQuantities(projectId: string, draftId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation<PromoteResponse, Error, PromoteRequestBody>({
    mutationFn: (input) => {
      if (!draftId) {
        throw new Error('draft id is required to promote quantities')
      }
      return promoteCapturedQuantities(projectId, draftId, input)
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
 *
 * Async split (2026-06-12): dry-run / count-scope / roomplan /
 * photogrammetry / drone stay synchronous (201, result_summary.status
 * 'ready'). A LIVE blueprint_vision capture (live provider env, no dryRun)
 * returns 202 with result_summary.status 'processing' and NO inline result —
 * the caller must poll the draft via `useTakeoffDraftResult` until the
 * status leaves 'processing'.
 */
/** THE single JSON capture call site (wave-3 convergence) — used by both the
 *  `useCaptureTakeoffDraft` mutation and the takeoff-session machine's
 *  `runCapture` actor (`machines/takeoff-session-deps.ts`). */
export function captureTakeoffDraft(projectId: string, input: CaptureRequestBody): Promise<CaptureResponse> {
  return request<CaptureResponse>(`/api/projects/${encodeURIComponent(projectId)}/takeoff-drafts/capture`, {
    method: 'POST',
    json: input,
  })
}

export function useCaptureTakeoffDraft(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CaptureResponse, Error, CaptureRequestBody>({
    mutationFn: (input) => captureTakeoffDraft(projectId, input),
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
 * multipart/form-data so the API runs the live AI sheet read (Gemini prod
 * default or env-gated Anthropic — both providers accept the multipart
 * upload since the 2026-06-12 async split). Mirrors `uploadBlueprint` /
 * `uploadDailyLogPhoto` — FormData body, auth headers from
 * `buildAuthHeaders`, and the browser owns the multipart boundary (we must
 * NOT set content-type). The server infers kind='blueprint_vision' from the
 * multipart branch; we still send `kind` + `draft_kind` explicitly to stay
 * symmetric with the JSON path.
 *
 * When the live provider env is present the server answers 202 with
 * result_summary.status='processing' (no inline result — poll via
 * `useTakeoffDraftResult`); without it the dry-run stub answers 201.
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

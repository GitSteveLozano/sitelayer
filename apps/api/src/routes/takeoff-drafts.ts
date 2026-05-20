import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { getRequestContext } from '@sitelayer/logger'
import type { ActiveCompany } from '../auth-types.js'
import { currentTraceHeaders, recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordCostLog } from '../cost-log.js'
import { isValidUuid, parseExpectedVersion } from '../http-utils.js'
import type { TakeoffResult } from '@sitelayer/capture-schema'
import {
  BlueprintUploadError,
  isMultipartRequest,
  parseBlueprintMultipart,
  type BlueprintMultipartResult,
} from '../blueprint-upload.js'
import type { BlueprintStorage } from '../storage.js'
import { loadServiceItemCatalogIndex, rejectionMessageForCatalog } from '../catalog.js'
import { captureRoomplanDraft } from '../takeoff-capture-pipelines/roomplan.js'
import { capturePhotogrammetryDraft } from '../takeoff-capture-pipelines/photogrammetry.js'
import { captureDroneDraft } from '../takeoff-capture-pipelines/drone.js'
import {
  captureBlueprintVisionDraft,
  resolveBlueprintVisionMode,
  type BlueprintLiveInputs,
} from '../takeoff-capture-pipelines/blueprint-vision.js'
import { defaultCaptureName } from '../takeoff-capture-pipelines/shared.js'

export type TakeoffDraftRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  currentUserId?: string | null
  /** Spaces / local-fs backend. Required for the live blueprint_vision
   *  capture path (`POST /api/projects/:id/takeoff-drafts/capture` with
   *  multipart/form-data). Optional for tests that only exercise the
   *  dry-run JSON path. */
  storage?: BlueprintStorage
  /** Hard cap (bytes) on the multipart PDF body. Falls back to
   *  `MAX_BLUEPRINT_UPLOAD_BYTES` semantics from server.ts. */
  maxBlueprintUploadBytes?: number
}

const ALLOWED_STATUS = new Set(['active', 'archived'])
const ALLOWED_CAPTURE_KINDS = new Set(['roomplan', 'photogrammetry', 'drone', 'blueprint_vision'])

// Placeholder cost per blueprint page Claude Opus reads. The real cost
// is token-driven (input + output) but the Anthropic SDK call site does
// not surface usage today; we record a flat per-page estimate so the
// per-company spend column has data while we wait for the SDK to expose
// it. metadata flags the estimation method.
const BLUEPRINT_VISION_COST_PER_PAGE_USD = 0.25

/**
 * Count drawing pages in a captured blueprint TakeoffResult. Returns 0
 * for non-blueprint captures or when the artifact metadata is missing
 * — the caller skips cost logging in that case.
 */
function countBlueprintPages(takeoffResult: unknown): number {
  if (!takeoffResult || typeof takeoffResult !== 'object') return 0
  const sa = (takeoffResult as { sourceArtifact?: unknown }).sourceArtifact
  if (!sa || typeof sa !== 'object') return 0
  const kind = (sa as { kind?: unknown }).kind
  if (kind !== 'blueprint') return 0
  const blueprint = (sa as { blueprint?: unknown }).blueprint
  if (!blueprint || typeof blueprint !== 'object') return 0
  const pdfMeta = (blueprint as { pdfMeta?: unknown }).pdfMeta
  if (!pdfMeta || typeof pdfMeta !== 'object') return 0
  const pages = (pdfMeta as { pages?: unknown }).pages
  return typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 0
}
const RETURNING_COLUMNS = `id, company_id, project_id, name, type, status, source, takeoff_result_blob_uri, review_required, pipeline_version, version, deleted_at, created_at, updated_at`
const PROMOTED_MEASUREMENT_COLUMNS = `id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, draft_id, version, deleted_at, created_at`

/**
 * Resolve the canonical `service_item_code` for a captured `TakeoffQuantity`.
 * The capture schema emits MasterFormat / UniFormat / OmniClass codes (any
 * one of which is required by the zod refine); sitelayer's `service_items`
 * catalog is keyed on MasterFormat-shaped codes, so we prefer that and fall
 * back to the others rather than silently dropping the quantity. Returns
 * `null` when nothing usable is on the record — caller skips with a reason.
 */
function deriveServiceItemCodeFromQuantity(
  quantity: { masterformatCode?: unknown; uniformatCode?: unknown; omniclassCode?: unknown } | null | undefined,
): string | null {
  if (!quantity) return null
  const candidates = [quantity.masterformatCode, quantity.uniformatCode, quantity.omniclassCode]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

/**
 * Shape-check the JSON pulled out of `takeoff_drafts.takeoff_result_json`
 * just enough to walk `quantities[]` without throwing. The capture writer
 * (POST /capture above) already ran the full zod schema on the way in, so
 * a stored value with the wrong shape is a forensic indicator the row was
 * mutated out-of-band; treat it like "no quantities" rather than 500.
 */
function readQuantitiesFromStoredResult(raw: unknown): Array<{
  id: unknown
  value?: unknown
  unit?: unknown
  description?: unknown
  confidence?: unknown
  masterformatCode?: unknown
  uniformatCode?: unknown
  omniclassCode?: unknown
  provenance?: unknown
  geometryRefs?: unknown
}> {
  if (!raw || typeof raw !== 'object') return []
  const quantities = (raw as { quantities?: unknown }).quantities
  if (!Array.isArray(quantities)) return []
  return quantities.filter((q) => q && typeof q === 'object' && 'id' in (q as Record<string, unknown>)) as Array<{
    id: unknown
    value?: unknown
    unit?: unknown
    description?: unknown
    confidence?: unknown
    masterformatCode?: unknown
    uniformatCode?: unknown
    omniclassCode?: unknown
    provenance?: unknown
    geometryRefs?: unknown
  }>
}

/**
 * Map a captured quantity's `geometryRefs` (lookup keys into the draft's
 * shared geometry section) into the JSONB blob we persist on the new
 * `takeoff_measurements` row. The shape mirrors what the polygon canvas
 * writes today (kind: polygon | lineal | volume | count) so downstream
 * code (calculateGeometryQuantity, takeoff-summary) doesn't fork. When
 * we can't find a usable reference we emit `{}` — the column is NOT
 * NULL — which preserves the quantity number on the row.
 */
function resolveCapturedGeometry(quantity: { geometryRefs?: unknown }, result: unknown): Record<string, unknown> {
  if (!quantity.geometryRefs || !Array.isArray(quantity.geometryRefs) || quantity.geometryRefs.length === 0) {
    return {}
  }
  const refs = quantity.geometryRefs.filter((r): r is string => typeof r === 'string')
  if (refs.length === 0) return {}
  const geometry = result && typeof result === 'object' ? (result as { geometry?: unknown }).geometry : undefined
  if (!geometry || typeof geometry !== 'object') {
    return { kind: 'capture', refs }
  }
  // Surface the polygon for the first referenced surface (if any) so the
  // canvas can render the promoted measurement immediately. Falls back to
  // a `capture` placeholder shape with the original refs preserved so
  // operators can trace back to the captured artifact.
  const surfaces = (geometry as { surfaces?: unknown }).surfaces
  if (Array.isArray(surfaces)) {
    for (const ref of refs) {
      const match = surfaces.find((s) => s && typeof s === 'object' && (s as { id?: unknown }).id === ref) as
        | { polygon?: unknown }
        | undefined
      if (match?.polygon && Array.isArray(match.polygon) && match.polygon.length >= 3) {
        return { kind: 'capture', surfaceId: ref, polygon: match.polygon, refs }
      }
    }
  }
  return { kind: 'capture', refs }
}

/** Build the notes blob for a promoted measurement so we keep a trail
 * back to the capture pipeline that proposed it. */
function buildPromotedNotes(quantity: {
  description?: unknown
  confidence?: unknown
  provenance?: unknown
}): string | null {
  const parts: string[] = []
  if (typeof quantity.description === 'string' && quantity.description.trim().length > 0) {
    parts.push(quantity.description.trim())
  }
  const provenanceKind =
    quantity.provenance && typeof quantity.provenance === 'object'
      ? (quantity.provenance as { kind?: unknown }).kind
      : undefined
  if (typeof provenanceKind === 'string' && provenanceKind.length > 0) {
    parts.push(`promoted from ${provenanceKind}`)
  } else {
    parts.push('promoted from capture')
  }
  if (typeof quantity.confidence === 'number' && Number.isFinite(quantity.confidence)) {
    parts.push(`confidence=${quantity.confidence.toFixed(2)}`)
  }
  const joined = parts.join(' · ')
  return joined.length > 0 ? joined : null
}

/**
 * Run the requested capture pipeline against its kind-specific payload
 * and return the resulting `TakeoffResult` with review-floor applied.
 * Throws on validation / pipeline errors; the caller maps to 400/422.
 */
async function dispatchCapturePipeline(
  kind: string,
  payload: Record<string, unknown>,
  projectId: string,
  blueprintLive?: BlueprintLiveInputs,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  switch (kind) {
    case 'roomplan':
      return captureRoomplanDraft(payload, projectId)
    case 'photogrammetry':
      return capturePhotogrammetryDraft(payload, projectId)
    case 'drone':
      return captureDroneDraft(payload, projectId)
    case 'blueprint_vision':
      return captureBlueprintVisionDraft(payload, projectId, blueprintLive)
    default:
      throw new Error(`unsupported capture kind: ${kind}`)
  }
}

/**
 * Resolve the project's active default draft id. The migration backfills
 * one per project, and `handleProjectRoutes` auto-creates one when a new
 * project is inserted, so this should always return a row in normal
 * operation. Returns null only if the project itself doesn't exist or has
 * had all its drafts hard-deleted (unsupported via the API; would require
 * direct DB access).
 */
export async function resolveDefaultDraftId(pool: Pool, companyId: string, projectId: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `select id from takeoff_drafts
       where company_id = $1
         and project_id = $2
         and deleted_at is null
         and status = 'active'
       order by created_at asc
       limit 1`,
    [companyId, projectId],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Throw via sendJson(400) if an explicit draft_id is provided but does not
 * belong to (companyId, projectId). Returns null when no draft_id is
 * provided. The caller decides whether to fall back to the default draft.
 */
export async function validateDraftId(
  pool: Pool,
  companyId: string,
  projectId: string,
  draftId: string,
): Promise<boolean> {
  if (!isValidUuid(draftId)) return false
  const result = await pool.query<{ id: string }>(
    `select id from takeoff_drafts
       where company_id = $1
         and project_id = $2
         and id = $3
         and deleted_at is null`,
    [companyId, projectId, draftId],
  )
  return result.rows.length > 0
}

/**
 * Handle takeoff_drafts routes:
 * - GET    /api/projects/<projectId>/takeoff-drafts
 *     List drafts for the project. By default returns only active drafts;
 *     pass `?include_archived=1` to include archived ones too. Soft-deleted
 *     drafts (deleted_at IS NOT NULL) are always hidden.
 * - POST   /api/projects/<projectId>/takeoff-drafts
 *     Create a new draft. Body: `{ name, type? }`. Default type='measurement'.
 * - PATCH  /api/takeoff-drafts/<id>
 *     Rename / archive. Body: `{ name?, status?, expected_version? }`.
 *     status must be 'active' or 'archived'. Version-checked.
 * - POST   /api/takeoff-drafts/<id>/duplicate
 *     Clone the draft plus all its measurements into a new draft.
 *     Body: `{ name? }` — defaults to "<source name> (copy)".
 * - DELETE /api/takeoff-drafts/<id>
 *     Soft delete (sets deleted_at). Measurements stay around but are
 *     invisible to the UI; a hard-delete via psql would null out
 *     `takeoff_measurements.draft_id` thanks to the FK's ON DELETE SET NULL.
 *
 * Phase A.2 of docs/MULTI_DRAFT_TAKEOFF_SPEC.md.
 */
export async function handleTakeoffDraftRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TakeoffDraftRouteCtx,
): Promise<boolean> {
  // POST /api/projects/:projectId/takeoff-drafts/capture (Phase C.2)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff-drafts\/capture$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }

    // Multipart branch (live blueprint_vision): stream the PDF to Spaces
    // first, then hand the bytes to the pipeline. JSON branch unchanged.
    let multipartResult: BlueprintMultipartResult | null = null
    let body: Record<string, unknown>
    if (isMultipartRequest(req)) {
      if (!ctx.storage) {
        ctx.sendJson(500, { error: 'blueprint storage backend not configured' })
        return true
      }
      const blueprintId = randomUUID()
      const maxBytes = ctx.maxBlueprintUploadBytes ?? 200 * 1024 * 1024
      try {
        multipartResult = await parseBlueprintMultipart(
          req,
          ctx.storage,
          ctx.company.id,
          blueprintId,
          'blueprint.pdf',
          { maxFileBytes: maxBytes },
        )
      } catch (err) {
        if (err instanceof BlueprintUploadError) {
          ctx.sendJson(err.status, { error: err.message })
          return true
        }
        throw err
      }
      body = multipartResult.fields
      // payload may be smuggled in as a JSON string field on multipart bodies
      // so the caller can still pass knownDimensionFt etc.
      const payloadField = typeof body.payload === 'string' ? body.payload : ''
      if (payloadField) {
        try {
          const parsed = JSON.parse(payloadField) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body.payload = parsed as Record<string, unknown>
          }
        } catch {
          // Ignore parse failures; the downstream check enforces shape.
        }
      }
    } else {
      body = await ctx.readBody()
    }

    const kind = String(body.kind ?? '').trim() || (multipartResult ? 'blueprint_vision' : '')
    if (!ALLOWED_CAPTURE_KINDS.has(kind)) {
      ctx.sendJson(400, {
        error: `kind must be one of ${[...ALLOWED_CAPTURE_KINDS].join(', ')}`,
      })
      return true
    }
    if (multipartResult && kind !== 'blueprint_vision') {
      ctx.sendJson(400, { error: 'multipart upload only supported for kind=blueprint_vision' })
      return true
    }
    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : multipartResult
          ? {}
          : null
    if (!payload) {
      ctx.sendJson(400, { error: 'payload (object) is required' })
      return true
    }
    const name = String(body.name ?? '').trim() || defaultCaptureName(kind)

    // Verify project tenancy before kicking the pipeline so a foreign
    // projectId doesn't waste a Claude/Luma call on the way to a 404.
    const projectCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select id from projects
         where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, projectId],
      ),
    )
    if (!projectCheck.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    let blueprintLive: BlueprintLiveInputs | undefined
    if (multipartResult && ctx.storage) {
      // Read bytes back out of storage so the pipeline sees the same
      // payload that landed in Spaces. Avoids a second buffer in memory
      // beyond what putStream already required, but keeps the artifact
      // pdfSha256 anchored on the persisted bytes.
      try {
        const persisted = await ctx.storage.get(multipartResult.storagePath)
        blueprintLive = { pdfBytes: persisted, storagePath: multipartResult.storagePath }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'storage read failed'
        ctx.sendJson(500, { error: `failed to read uploaded blueprint: ${message}` })
        return true
      }
    }

    let dispatchOutcome: { result: TakeoffResult; pipelineVersion: string }
    try {
      dispatchOutcome = await dispatchCapturePipeline(kind, payload, projectId, blueprintLive)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'pipeline failed'
      ctx.sendJson(422, { error: message })
      return true
    }
    const { result: takeoffResult, pipelineVersion } = dispatchOutcome
    const reviewRequired = takeoffResult.quantities.some((q) => q.confidence < 0.5)

    // Was the underlying pipeline actually a live Anthropic call? The
    // dispatcher returns the same TakeoffResult shape either way, so we
    // re-resolve the env-gated mode flag here instead of threading a
    // bool through the pipeline contract. Live mode requires both the
    // multipart upload (which the route created blueprintLive from) and
    // the env vars (BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY).
    const usedBlueprintVisionLive =
      kind === 'blueprint_vision' && blueprintLive != null && resolveBlueprintVisionMode() === 'live'
    const blueprintPagesCount = usedBlueprintVisionLive ? countBlueprintPages(takeoffResult) : 0

    const created = await withMutationTx(async (client) => {
      const insertResult = await client.query(
        `insert into takeoff_drafts (
            company_id, project_id, name, type, status,
            source, takeoff_result_json, review_required, pipeline_version
          )
          values ($1, $2, $3, 'measurement', 'active', $4, $5::jsonb, $6, $7)
          returning ${RETURNING_COLUMNS}`,
        [ctx.company.id, projectId, name, kind, JSON.stringify(takeoffResult), reviewRequired, pipelineVersion],
      )
      const row = insertResult.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: row.id,
        action: 'create',
        row: { ...row, source: kind, pipeline_version: pipelineVersion },
        actorUserId: ctx.currentUserId ?? null,
      })
      // Cost attribution for blueprint vision: flat $0.25/page placeholder
      // (the Anthropic SDK call site doesn't surface token counts). One row
      // per attempt rather than per page so the cost log lines up 1:1 with
      // the draft it produced; metadata pages count lets the read endpoint
      // recover the per-page rate.
      if (usedBlueprintVisionLive && blueprintPagesCount > 0) {
        const requestCtx = getRequestContext()
        const { sentryTrace } = currentTraceHeaders()
        await recordCostLog(client, {
          companyId: ctx.company.id,
          operation: 'blueprint_vision_page',
          costUsd: BLUEPRINT_VISION_COST_PER_PAGE_USD * blueprintPagesCount,
          description: `blueprint_vision:capture pages=${blueprintPagesCount}`,
          requestId: requestCtx?.requestId ?? null,
          sentryTrace,
          metadata: {
            pages: blueprintPagesCount,
            estimation: 'flat_per_page',
            per_page_usd: BLUEPRINT_VISION_COST_PER_PAGE_USD,
            input_tokens: null,
            output_tokens: null,
            pipeline_version: pipelineVersion,
            draft_id: row.id,
          },
        })
      }
      return row
    })

    ctx.sendJson(201, {
      draft: created,
      result_summary: {
        quantities_count: takeoffResult.quantities.length,
        review_required: reviewRequired,
        capture_source: takeoffResult.source,
        geometry: {
          rooms: takeoffResult.geometry?.rooms?.length ?? 0,
          surfaces: takeoffResult.geometry?.surfaces?.length ?? 0,
          objects: takeoffResult.geometry?.objects?.length ?? 0,
        },
        pipeline_version: pipelineVersion,
      },
    })
    return true
  }

  // POST /api/projects/:projectId/takeoff-drafts/:draftId/promote — turn
  // selected captured quantities into real `takeoff_measurements` rows.
  //
  // Body: { quantity_ids: string[], service_item_code_overrides?: {<id>: <code>} }
  //
  // Operators review AI-generated quantities in the canvas, optionally
  // remap a quantity onto a different curated service item, and PROMOTE
  // the subset they want as committed scope. Promotion is additive: it
  // never mutates the draft's takeoff_result_json — that stays as the
  // immutable audit trail of what the pipeline proposed. Skipped quantities
  // (missing id, no derivable service_item_code) come back in the response
  // so the client can flag them rather than silently dropping rows.
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff-drafts\/[^/]+\/promote$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const segments = url.pathname.split('/')
    const projectId = segments[3] ?? ''
    const draftId = segments[5] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    if (!isValidUuid(draftId)) {
      ctx.sendJson(400, { error: 'draft id must be a valid uuid' })
      return true
    }

    const body = await ctx.readBody()
    const rawIds = Array.isArray(body.quantity_ids) ? body.quantity_ids : null
    if (!rawIds || rawIds.length === 0) {
      ctx.sendJson(400, { error: 'quantity_ids (non-empty array) is required' })
      return true
    }
    const quantityIds = rawIds
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim())
    if (quantityIds.length === 0) {
      ctx.sendJson(400, { error: 'quantity_ids must contain at least one non-empty string' })
      return true
    }

    // service_item_code_overrides: optional per-quantity remap so the
    // operator can route a low-confidence "08 14 00 wood door" onto the
    // company's curated catalog code without touching the source result.
    const overridesRaw = body.service_item_code_overrides
    const overrides = new Map<string, string>()
    if (overridesRaw !== undefined && overridesRaw !== null) {
      if (typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) {
        ctx.sendJson(400, { error: 'service_item_code_overrides must be an object map' })
        return true
      }
      for (const [k, v] of Object.entries(overridesRaw as Record<string, unknown>)) {
        if (typeof k !== 'string' || k.trim().length === 0) continue
        if (typeof v !== 'string' || v.trim().length === 0) {
          ctx.sendJson(400, { error: `service_item_code_overrides[${k}] must be a non-empty string` })
          return true
        }
        overrides.set(k.trim(), v.trim())
      }
    }

    // Pull the draft + its stored TakeoffResult. The tenant filter prevents
    // a foreign company from promoting another tenant's draft even with a
    // guessed uuid; the project_id check ties the promotion to the URL.
    const draftQuery = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{
        id: string
        takeoff_result_json: unknown
        source: string
      }>(
        `select id, takeoff_result_json, source
         from takeoff_drafts
        where company_id = $1 and project_id = $2 and id = $3 and deleted_at is null`,
        [ctx.company.id, projectId, draftId],
      ),
    )
    const draftRow = draftQuery.rows[0]
    if (!draftRow) {
      ctx.sendJson(404, { error: 'draft not found' })
      return true
    }
    if (!draftRow.takeoff_result_json) {
      ctx.sendJson(404, { error: 'draft has no captured takeoff result to promote' })
      return true
    }

    const storedResult = draftRow.takeoff_result_json
    const storedQuantities = readQuantitiesFromStoredResult(storedResult)
    const quantitiesById = new Map<string, (typeof storedQuantities)[number]>()
    for (const q of storedQuantities) {
      if (typeof q.id === 'string') quantitiesById.set(q.id, q)
    }

    type Skip = { quantity_id: string; reason: string }
    const skipped: Skip[] = []
    type Prepared = {
      quantityId: string
      serviceItemCode: string
      quantity: number
      unit: string
      geometryJson: string
      notes: string | null
      /** True when the service_item_code came from `service_item_code_overrides`
       *  rather than from the AI-derived MasterFormat/UniFormat/OmniClass field.
       *  Drives catalog enforcement below: operator-typed codes must match the
       *  curated `service_item_divisions` catalog (same gate as takeoff-write.ts),
       *  while AI proposals continue to bypass that gate so the review queue can
       *  surface them. */
      fromOverride: boolean
    }
    const prepared: Prepared[] = []

    for (const id of quantityIds) {
      const q = quantitiesById.get(id)
      if (!q) {
        skipped.push({ quantity_id: id, reason: 'quantity_id not present in draft result' })
        continue
      }
      const override = overrides.get(id) ?? null
      const serviceItemCode = override ?? deriveServiceItemCodeFromQuantity(q)
      if (!serviceItemCode) {
        skipped.push({
          quantity_id: id,
          reason: 'no service_item_code on quantity (supply an override)',
        })
        continue
      }
      const unitRaw = typeof q.unit === 'string' ? q.unit.trim() : ''
      if (!unitRaw) {
        skipped.push({ quantity_id: id, reason: 'quantity is missing unit' })
        continue
      }
      const valueNumber = typeof q.value === 'number' ? q.value : Number(q.value ?? NaN)
      if (!Number.isFinite(valueNumber) || valueNumber < 0) {
        skipped.push({ quantity_id: id, reason: 'quantity value is not a finite non-negative number' })
        continue
      }
      const geometry = resolveCapturedGeometry(q, storedResult)
      prepared.push({
        quantityId: id,
        serviceItemCode,
        quantity: valueNumber,
        unit: unitRaw,
        geometryJson: JSON.stringify(geometry),
        notes: buildPromotedNotes(q),
        fromOverride: override !== null,
      })
    }

    if (prepared.length === 0) {
      ctx.sendJson(422, {
        error: 'no quantities could be promoted',
        skipped,
      })
      return true
    }

    // Catalog enforcement, override path only. AI-proposed `service_item_code`
    // values (those derived from MasterFormat/UniFormat/OmniClass on the
    // captured quantity) intentionally bypass `service_item_divisions` so
    // pre-review records can be promoted into the operator's queue. When the
    // operator types in an explicit override though, treat it like a direct
    // takeoff write: it has to clear the same curated-catalog gate that
    // `takeoff-write.ts` enforces, otherwise an out-of-band typo would land
    // an uncurated code in `takeoff_measurements`.
    const overrideRows = prepared.filter((p) => p.fromOverride)
    if (overrideRows.length > 0) {
      const projectDivisionResult = await withCompanyClient(ctx.company.id, (c) =>
        c.query<{ division_code: string | null }>(
          'select division_code from projects where company_id = $1 and id = $2',
          [ctx.company.id, projectId],
        ),
      )
      const projectDivisionCode = projectDivisionResult.rows[0]?.division_code ?? null
      const catalogIndex = await loadServiceItemCatalogIndex(
        ctx.pool,
        ctx.company.id,
        overrideRows.map((p) => p.serviceItemCode),
      )
      const rejected: Array<{ quantity_id: string; service_item_code: string; reason: string }> = []
      for (const row of overrideRows) {
        const status = catalogIndex.check(row.serviceItemCode, projectDivisionCode)
        if (!status.ok) {
          rejected.push({
            quantity_id: row.quantityId,
            service_item_code: row.serviceItemCode,
            reason: rejectionMessageForCatalog(status.reason),
          })
        }
      }
      if (rejected.length > 0) {
        ctx.sendJson(422, {
          error: 'service_item_code_overrides include codes not in curated catalog',
          rejected,
          // Surface the offending codes as a flat list too so the UI can
          // highlight inputs without re-walking the rejected[] objects.
          rejected_codes: Array.from(new Set(rejected.map((r) => r.service_item_code))),
        })
        return true
      }
    }

    const inserted = await withMutationTx(async (client) => {
      const rows: Array<Record<string, unknown>> = []
      for (const p of prepared) {
        const insertResult = await client.query(
          `insert into takeoff_measurements (
              company_id, project_id, service_item_code, quantity, unit, notes,
              geometry, version, draft_id
            )
            values ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8)
            returning ${PROMOTED_MEASUREMENT_COLUMNS}`,
          [ctx.company.id, projectId, p.serviceItemCode, p.quantity, p.unit, p.notes, p.geometryJson, draftId],
        )
        const row = insertResult.rows[0]
        rows.push(row)
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'takeoff_measurement',
          entityId: row.id as string,
          action: 'create',
          row,
          syncPayload: { action: 'create', measurement: row },
          outboxPayload: { measurement: row },
          actorUserId: ctx.currentUserId ?? null,
        })
      }
      return rows
    })

    ctx.sendJson(201, {
      measurements: inserted,
      promoted_count: inserted.length,
      skipped_count: skipped.length,
      skipped,
    })
    return true
  }

  // GET /api/takeoff-drafts/:id/result — return the stashed TakeoffResult JSON
  if (req.method === 'GET' && url.pathname.match(/^\/api\/takeoff-drafts\/[^/]+\/result$/)) {
    const draftId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(draftId)) {
      ctx.sendJson(400, { error: 'draft id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{
        takeoff_result_json: unknown
        source: string
        review_required: boolean
        pipeline_version: string | null
      }>(
        `select takeoff_result_json, source, review_required, pipeline_version
         from takeoff_drafts
        where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, draftId],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'draft not found' })
      return true
    }
    if (!result.rows[0].takeoff_result_json) {
      ctx.sendJson(404, { error: 'draft has no captured takeoff result (manual draft)' })
      return true
    }
    ctx.sendJson(200, {
      takeoff_result: result.rows[0].takeoff_result_json,
      source: result.rows[0].source,
      review_required: result.rows[0].review_required,
      pipeline_version: result.rows[0].pipeline_version,
    })
    return true
  }

  // GET /api/projects/:projectId/takeoff-drafts
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff-drafts$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const includeArchived = url.searchParams.get('include_archived') === '1'
    const where = includeArchived
      ? `company_id = $1 and project_id = $2 and deleted_at is null`
      : `company_id = $1 and project_id = $2 and deleted_at is null and status = 'active'`
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${RETURNING_COLUMNS}
         from takeoff_drafts
        where ${where}
        order by case when status = 'active' then 0 else 1 end, created_at asc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { drafts: result.rows })
    return true
  }

  // POST /api/projects/:projectId/takeoff-drafts
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff-drafts$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const type = String(body.type ?? 'measurement').trim() || 'measurement'

    // Confirm the project exists for this tenant before inserting.
    // Otherwise we'd silently fail-open: the composite FK would reject the
    // insert but only on COMMIT, returning a less helpful 500.
    const projectCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select id from projects
         where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, projectId],
      ),
    )
    if (!projectCheck.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    const created = await withMutationTx(async (client) => {
      const insertResult = await client.query(
        `insert into takeoff_drafts (company_id, project_id, name, type, status)
         values ($1, $2, $3, $4, 'active')
         returning ${RETURNING_COLUMNS}`,
        [ctx.company.id, projectId, name, type],
      )
      const row = insertResult.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: row.id,
        action: 'create',
        row,
        actorUserId: ctx.currentUserId ?? null,
      })
      return row
    })
    ctx.sendJson(201, { draft: created })
    return true
  }

  // PATCH /api/takeoff-drafts/:id
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/takeoff-drafts\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const draftId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(draftId)) {
      ctx.sendJson(400, { error: 'draft id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const nameRaw = body.name === undefined ? null : String(body.name).trim()
    const statusRaw = body.status === undefined ? null : String(body.status).trim()
    if (nameRaw !== null && !nameRaw) {
      ctx.sendJson(400, { error: 'name cannot be empty' })
      return true
    }
    if (statusRaw !== null && !ALLOWED_STATUS.has(statusRaw)) {
      ctx.sendJson(400, { error: "status must be 'active' or 'archived'" })
      return true
    }
    if (nameRaw === null && statusRaw === null) {
      ctx.sendJson(400, { error: 'no updates supplied (name or status required)' })
      return true
    }

    const conflict: { current_version?: number } = {}
    const updated = await withMutationTx(async (client) => {
      const currentRow = await client.query<{ version: number }>(
        `select version from takeoff_drafts
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
        [ctx.company.id, draftId],
      )
      if (!currentRow.rows[0]) return null
      if (expectedVersion !== null && Number(currentRow.rows[0].version) !== expectedVersion) {
        conflict.current_version = Number(currentRow.rows[0].version)
        return null
      }
      const updateResult = await client.query(
        `update takeoff_drafts
           set name = coalesce($3, name),
               status = coalesce($4, status),
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${RETURNING_COLUMNS}`,
        [ctx.company.id, draftId, nameRaw, statusRaw],
      )
      const row = updateResult.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: row.id,
        action: 'update',
        row,
        actorUserId: ctx.currentUserId ?? null,
      })
      return row
    })
    if (conflict.current_version !== undefined) {
      ctx.sendJson(409, { error: 'version conflict', current_version: conflict.current_version })
      return true
    }
    if (!updated) {
      ctx.sendJson(404, { error: 'draft not found' })
      return true
    }
    ctx.sendJson(200, { draft: updated })
    return true
  }

  // POST /api/takeoff-drafts/:id/duplicate
  if (req.method === 'POST' && url.pathname.match(/^\/api\/takeoff-drafts\/[^/]+\/duplicate$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const draftId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(draftId)) {
      ctx.sendJson(400, { error: 'draft id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const explicitName = body.name === undefined ? null : String(body.name).trim()

    const duplicated = await withMutationTx(async (client) => {
      const source = await client.query<{
        id: string
        company_id: string
        project_id: string
        name: string
        type: string
      }>(
        `select id, company_id, project_id, name, type
           from takeoff_drafts
          where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, draftId],
      )
      if (!source.rows[0]) return null
      const src = source.rows[0]
      const newName = explicitName && explicitName.length > 0 ? explicitName : `${src.name} (copy)`

      const insertedDraft = await client.query(
        `insert into takeoff_drafts (company_id, project_id, name, type, status)
         values ($1, $2, $3, $4, 'active')
         returning ${RETURNING_COLUMNS}`,
        [src.company_id, src.project_id, newName, src.type],
      )
      const newDraft = insertedDraft.rows[0]

      // Clone the source draft's measurements into the new draft. Reset
      // version to 1 because each row is a fresh insert; preserve geometry,
      // service item, blueprint linkage, notes, division, and elevation so
      // the duplicated draft renders identically to the source.
      const copiedMeasurements = await client.query<{ id: string }>(
        `insert into takeoff_measurements (
            company_id, project_id, blueprint_document_id, page_id, service_item_code,
            quantity, unit, notes, geometry, version, division_code,
            elevation, image_thumbnail, draft_id
          )
          select company_id, project_id, blueprint_document_id, page_id, service_item_code,
                 quantity, unit, notes, geometry, 1, division_code,
                 elevation, image_thumbnail, $2
            from takeoff_measurements
           where company_id = $3
             and draft_id = $1
             and deleted_at is null
          returning id`,
        [src.id, newDraft.id, ctx.company.id],
      )

      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: newDraft.id,
        action: 'create',
        row: newDraft,
        actorUserId: ctx.currentUserId ?? null,
      })
      return { draft: newDraft, measurementCount: copiedMeasurements.rowCount ?? 0 }
    })
    if (!duplicated) {
      ctx.sendJson(404, { error: 'draft not found' })
      return true
    }
    ctx.sendJson(201, {
      draft: duplicated.draft,
      measurement_count: duplicated.measurementCount,
    })
    return true
  }

  // DELETE /api/takeoff-drafts/:id
  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/takeoff-drafts\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const draftId = url.pathname.split('/')[3] ?? ''
    if (!isValidUuid(draftId)) {
      ctx.sendJson(400, { error: 'draft id must be a valid uuid' })
      return true
    }

    const deleted = await withMutationTx(async (client) => {
      const result = await client.query(
        `update takeoff_drafts
           set deleted_at = now(),
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${RETURNING_COLUMNS}`,
        [ctx.company.id, draftId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_draft',
        entityId: row.id,
        action: 'delete',
        row,
        actorUserId: ctx.currentUserId ?? null,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'draft not found' })
      return true
    }
    ctx.sendJson(200, { draft: deleted })
    return true
  }

  return false
}

import type http from 'node:http'
import type { Pool } from 'pg'
import { calculateGeometryQuantity, normalizeGeometry } from '@sitelayer/domain'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseExpectedVersion, parseJsonBody } from '../http-utils.js'
import {
  assertServiceItemCatalogStatus as assertServiceItemCatalogStatusImpl,
  loadServiceItemCatalogIndex,
  rejectionMessageForCatalog,
} from '../catalog.js'
import { createEstimateFromMeasurements, getScopeVsBid } from './estimate.js'
import { resolveDefaultDraftId, validateDraftId } from './takeoff-drafts.js'

export type TakeoffWriteRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type PreparedTakeoffMeasurementInput = {
  serviceItemCode: string
  quantity: number
  unit: string
  notes: string | null
  geometryJson: string | null
  blueprintDocumentId: string | null
  pageId: string | null
  divisionCode: string | null
  // Sitemap §5 panel 1 — first-class elevation tag (East / South /
  // West / North / Roof / Other / null = untagged).
  elevation: string | null
  // Sitemap §5 panel 3 — photo-measure thumbnail as a data URL.
  // Compressed client-side (≈ 30–80KB) so it fits inline; the
  // photo-bucket follow-on will swap this for a Spaces storage key.
  imageThumbnail: string | null
  // PlanSwift Phase 1 cutout/deduct: when true this polygon is a deduction
  // (e.g. a window/door opening) and the estimate subtracts its area from the
  // net for its service item. `quantity` itself stays the positive area.
  isDeduction: boolean
  // Condition layer (Takeoff Deep Dive H1): the reusable typed template this
  // measurement was drawn against, or null for the legacy shape-first flow.
  // Additive — existing readers ignore it; the tag flow stays the fallback.
  conditionId: string | null
  // PlanSwift org axes (gap G6): free-form Phase / Location / Zone / Folder so a
  // big estimate is navigable and reports (gap G4) roll up by any axis.
  // division_code + the fixed `elevation` enum already exist; these are the four
  // missing free-form axes.
  phase: string | null
  location: string | null
  zone: string | null
  folder: string | null
  // Job-cost code (migration 006): free-form accounting axis tagged onto each
  // measured quantity so spend rolls up by cost code, sibling to the org axes
  // above. NULL = untagged; threaded the same way as phase/zone.
  costCode: string | null
  // Extensible per-item property bag (PlanSwift's open-property-bag trick): AI
  // metadata, trade-pack fields, future attributes without a schema change.
  props: Record<string, unknown>
}

// POST /api/projects/:id/takeoff/measurement + /measurements wire-format.
// Deliberately PERMISSIVE: the schema only types the scalar control fields
// the route reads directly (`expected_version` / `version` / `draft_id`).
// The single-measurement body IS the measurement input (every other key is
// passed straight to `prepareTakeoffMeasurementInput`), and the batch body's
// per-measurement objects are validated by that same deep parser — so both
// schemas stay `.loose()` and keep the measurement payload `unknown` rather
// than risk narrowing what the SPA already sends.
const NumericInputSchema = z.union([z.number(), z.string()])

const TakeoffMeasurementBodySchema = z
  .object({
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
    draft_id: z.string().nullish(),
  })
  .loose()

const TakeoffMeasurementsBodySchema = z
  .object({
    measurements: z.array(z.unknown()).optional(),
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
    draft_id: z.string().nullish(),
  })
  .loose()

const ELEVATION_VOCAB = new Set(['east', 'south', 'west', 'north', 'roof', 'other'])

// Cap inline thumbnail size to keep the JSON body small. 200KB is
// generous for a 512×n JPEG @ q=0.7; bigger inputs almost certainly
// mean the client forgot to compress.
const MAX_INLINE_THUMBNAIL_BYTES = 200 * 1024

function prepareTakeoffMeasurementInput(rawInput: unknown, label = 'measurement'): PreparedTakeoffMeasurementInput {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new HttpError(400, `${label} must be an object`)
  }

  const input = rawInput as Record<string, unknown>
  const serviceItemCode = String(input.service_item_code ?? '').trim()
  const unit = String(input.unit ?? '').trim()
  const notes =
    input.notes === undefined || input.notes === null || String(input.notes).trim() === '' ? null : String(input.notes)
  const blueprintDocumentId =
    input.blueprint_document_id === undefined ||
    input.blueprint_document_id === null ||
    input.blueprint_document_id === ''
      ? null
      : String(input.blueprint_document_id)
  const pageId =
    input.page_id === undefined || input.page_id === null || input.page_id === '' ? null : String(input.page_id)
  const divisionCode =
    input.division_code === undefined || input.division_code === null || String(input.division_code).trim() === ''
      ? null
      : String(input.division_code).trim()
  const rawElevation =
    input.elevation === undefined || input.elevation === null || String(input.elevation).trim() === ''
      ? null
      : String(input.elevation).trim().toLowerCase()
  if (rawElevation !== null && !ELEVATION_VOCAB.has(rawElevation)) {
    throw new HttpError(400, `${label}.elevation must be one of: east, south, west, north, roof, other`)
  }
  const elevation = rawElevation

  const rawThumb =
    input.image_thumbnail === undefined || input.image_thumbnail === null || String(input.image_thumbnail).trim() === ''
      ? null
      : String(input.image_thumbnail)
  if (rawThumb !== null) {
    if (!rawThumb.startsWith('data:image/')) {
      throw new HttpError(400, `${label}.image_thumbnail must be a data: URL with image MIME`)
    }
    if (rawThumb.length > MAX_INLINE_THUMBNAIL_BYTES) {
      throw new HttpError(
        413,
        `${label}.image_thumbnail exceeds the 200KB inline cap; compress client-side or use the photo upload endpoint when wired`,
      )
    }
  }
  const imageThumbnail = rawThumb

  if (!serviceItemCode) {
    throw new HttpError(400, `${label}.service_item_code is required`)
  }
  if (!unit) {
    throw new HttpError(400, `${label}.unit is required`)
  }
  if (blueprintDocumentId && !isValidUuid(blueprintDocumentId)) {
    throw new HttpError(400, `${label}.blueprint_document_id must be a valid uuid`)
  }
  if (pageId && !isValidUuid(pageId)) {
    throw new HttpError(400, `${label}.page_id must be a valid uuid`)
  }
  if (pageId && !blueprintDocumentId) {
    throw new HttpError(400, `${label}.blueprint_document_id is required when page_id is supplied`)
  }

  const rawGeometry = input.geometry
  let quantity = Number(input.quantity ?? 0)
  let geometryJson: string | null = null
  if (rawGeometry !== undefined && rawGeometry !== null && rawGeometry !== '') {
    const geometry = normalizeGeometry(rawGeometry)
    if (!geometry) {
      throw new HttpError(
        400,
        `${label}.geometry must be a polygon (>=3 points), a lineal path (>=2 points), or a volume box with positive L/W/H`,
      )
    }
    // Pitch (H2): `normalizeGeometry` validates+carries an optional `pitch`
    // (rise:run) inside the geometry, and `calculateGeometryQuantity` applies
    // `slopeFactor = √(rise²+run²)/run` to the scaled area/length. No column —
    // pitch round-trips through the JSONB persisted below. Flat ⇒ factor 1.0.
    quantity = calculateGeometryQuantity(geometry)
    // Reject NaN/Infinity: a self-intersecting polygon or a pathological volume
    // box can produce NaN, and `n <= 0` is false for NaN so the trailing check
    // would emit a less specific error.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `${label}.geometry must produce a positive, finite quantity`)
    }
    geometryJson = JSON.stringify(geometry)
  }

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new HttpError(400, `${label}.quantity must be a non-negative number`)
  }

  const isDeduction = input.is_deduction === true

  const conditionId =
    input.condition_id === undefined || input.condition_id === null || String(input.condition_id).trim() === ''
      ? null
      : String(input.condition_id).trim()
  if (conditionId && !isValidUuid(conditionId)) {
    throw new HttpError(400, `${label}.condition_id must be a valid uuid`)
  }

  // PlanSwift org axes (gap G6): free-form Phase / Location / Zone / Folder.
  const orgTag = (key: 'phase' | 'location' | 'zone' | 'folder'): string | null => {
    const v = (input as Record<string, unknown>)[key]
    if (v === undefined || v === null) return null
    const s = String(v).trim()
    if (!s) return null
    if (s.length > 120) throw new HttpError(400, `${label}.${key} exceeds the 120-character cap`)
    return s
  }
  const phase = orgTag('phase')
  const location = orgTag('location')
  const zone = orgTag('zone')
  const folder = orgTag('folder')

  // Job-cost code (migration 006): same free-form, trimmed, capped handling as
  // the org axes above.
  const costCode = ((): string | null => {
    const v = (input as Record<string, unknown>).cost_code
    if (v === undefined || v === null) return null
    const s = String(v).trim()
    if (!s) return null
    if (s.length > 120) throw new HttpError(400, `${label}.cost_code exceeds the 120-character cap`)
    return s
  })()

  // Extensible per-item property bag.
  let props: Record<string, unknown> = {}
  const rawProps = input.props
  if (rawProps !== undefined && rawProps !== null) {
    if (typeof rawProps !== 'object' || Array.isArray(rawProps)) {
      throw new HttpError(400, `${label}.props must be a JSON object`)
    }
    if (JSON.stringify(rawProps).length > 16 * 1024) {
      throw new HttpError(413, `${label}.props exceeds the 16KB inline cap`)
    }
    props = rawProps as Record<string, unknown>
  }

  return {
    serviceItemCode,
    quantity,
    unit,
    notes,
    geometryJson,
    blueprintDocumentId,
    pageId,
    divisionCode,
    elevation,
    imageThumbnail,
    isDeduction,
    conditionId,
    phase,
    location,
    zone,
    folder,
    costCode,
    props,
  }
}

export async function assertBlueprintDocumentsBelongToProject(
  pool: Pool,
  companyId: string,
  projectId: string,
  blueprintDocumentIds: Array<string | null>,
) {
  const uniqueIds = Array.from(new Set(blueprintDocumentIds.filter((id): id is string => Boolean(id))))
  if (!uniqueIds.length) return

  const result = await pool.query<{ id: string }>(
    `
    select id
    from blueprint_documents
    where company_id = $1
      and project_id = $2
      and id = any($3::uuid[])
      and deleted_at is null
    `,
    [companyId, projectId, uniqueIds],
  )
  const validIds = new Set(result.rows.map((row) => row.id))
  const invalidIds = uniqueIds.filter((id) => !validIds.has(id))
  if (invalidIds.length) {
    throw new HttpError(400, 'blueprint_document_id must belong to the project')
  }
}

export async function assertBlueprintPagesBelongToProject(
  pool: Pool,
  companyId: string,
  projectId: string,
  references: Array<{ blueprintDocumentId: string | null; pageId: string | null }>,
) {
  const pageRefs = references.filter(
    (ref): ref is { blueprintDocumentId: string | null; pageId: string } => ref.pageId !== null,
  )
  if (!pageRefs.length) return

  const uniquePageIds = Array.from(new Set(pageRefs.map((ref) => ref.pageId)))
  const result = await pool.query<{ id: string; blueprint_document_id: string }>(
    `
    select p.id, p.blueprint_document_id
    from blueprint_pages p
    join blueprint_documents d on d.company_id = p.company_id and d.id = p.blueprint_document_id
    where p.company_id = $1
      and d.project_id = $2
      and p.id = any($3::uuid[])
      and d.deleted_at is null
    `,
    [companyId, projectId, uniquePageIds],
  )
  const pagesById = new Map(result.rows.map((row) => [row.id, row.blueprint_document_id]))
  const invalidPageId = uniquePageIds.find((id) => !pagesById.has(id))
  if (invalidPageId) {
    throw new HttpError(400, 'page_id must belong to the project')
  }
  const mismatchedRef = pageRefs.find(
    (ref) => ref.blueprintDocumentId !== null && pagesById.get(ref.pageId) !== ref.blueprintDocumentId,
  )
  if (mismatchedRef) {
    throw new HttpError(400, 'page_id must belong to blueprint_document_id')
  }
}

function assertServiceItemCatalogStatus(
  pool: Pool,
  companyId: string,
  serviceItemCode: string,
  divisionCode: string | null,
) {
  return assertServiceItemCatalogStatusImpl(pool, companyId, serviceItemCode, divisionCode)
}

/**
 * Handle takeoff write routes:
 * - POST /api/projects/<id>/takeoff/measurement  — append one polygon/manual measurement
 * - POST /api/projects/<id>/takeoff/measurements — replace the full set (batch upload)
 *
 * Both routes recompute estimate_lines after a successful write and return the
 * updated estimate + scope-vs-bid summary so the client stays in sync without
 * a second round-trip.
 */
export async function handleTakeoffWriteRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TakeoffWriteRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurement$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const parsedBody = parseJsonBody(TakeoffMeasurementBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const measurementInput = prepareTakeoffMeasurementInput(body)

    const projectVersionResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query('select version from projects where company_id = $1 and id = $2', [ctx.company.id, projectId]),
    )
    const currentProject = projectVersionResult.rows[0]
    if (!currentProject) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
      ctx.sendJson(409, { error: 'version conflict', current_version: Number(currentProject.version) })
      return true
    }

    await assertBlueprintDocumentsBelongToProject(ctx.pool, ctx.company.id, projectId, [
      measurementInput.blueprintDocumentId,
    ])
    await assertBlueprintPagesBelongToProject(ctx.pool, ctx.company.id, projectId, [
      { blueprintDocumentId: measurementInput.blueprintDocumentId, pageId: measurementInput.pageId },
    ])

    // Resolve target draft. Explicit body.draft_id wins (validated against
    // project tenancy); otherwise fall back to the active default draft.
    // Returns 400 for foreign draft_id, 500-equivalent via empty fallback
    // if a project somehow has no drafts (shouldn't happen post-066).
    const explicitDraftId =
      typeof body.draft_id === 'string' && body.draft_id.trim().length > 0 ? body.draft_id.trim() : null
    let draftId: string | null = null
    if (explicitDraftId) {
      const ok = await validateDraftId(ctx.pool, ctx.company.id, projectId, explicitDraftId)
      if (!ok) {
        ctx.sendJson(400, { error: 'draft_id does not belong to this project' })
        return true
      }
      draftId = explicitDraftId
    } else {
      draftId = await resolveDefaultDraftId(ctx.pool, ctx.company.id, projectId)
      if (!draftId) {
        ctx.sendJson(409, {
          error: 'project has no active default draft; create one via POST /api/projects/:id/takeoff-drafts',
        })
        return true
      }
    }

    // Curated-catalog enforcement (per spec): a takeoff cannot reference a
    // service item without at least one curated division mapping, and if a
    // division was supplied it must be in the allowed set.
    const projectDivisionResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ division_code: string | null }>(
        'select division_code from projects where company_id = $1 and id = $2',
        [ctx.company.id, projectId],
      ),
    )
    const fallbackDivision = measurementInput.divisionCode ?? projectDivisionResult.rows[0]?.division_code ?? null
    const catalogStatus = await assertServiceItemCatalogStatus(
      ctx.pool,
      ctx.company.id,
      measurementInput.serviceItemCode,
      fallbackDivision,
    )
    if (!catalogStatus.ok) {
      ctx.sendJson(422, {
        error: rejectionMessageForCatalog(catalogStatus.reason),
        service_item_code: measurementInput.serviceItemCode,
        division_code: fallbackDivision,
      })
      return true
    }

    // Condition layer (Deep Dive H1): when a measurement is drawn against a
    // Condition, confirm the Condition is a live row for THIS company before
    // persisting condition_id (defense in depth — the FK only checks
    // existence, not tenancy). Additive: condition_id stays null for the
    // legacy shape-first flow and nothing else changes.
    if (measurementInput.conditionId) {
      const ownsCondition = await withCompanyClient(ctx.company.id, (c) =>
        c.query<{ exists: boolean }>(
          `select exists(
             select 1 from takeoff_conditions
             where company_id = $1 and id = $2 and deleted_at is null
           ) as exists`,
          [ctx.company.id, measurementInput.conditionId],
        ),
      )
      if (!ownsCondition.rows[0]?.exists) {
        ctx.sendJson(400, { error: 'condition_id does not belong to this company' })
        return true
      }
    }

    const measurement = await withMutationTx(async (client) => {
      const insertResult = await client.query(
        `
        insert into takeoff_measurements (
          company_id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, version, division_code, elevation, image_thumbnail, draft_id, is_deduction, condition_id, phase, location, zone, folder, cost_code, props
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::jsonb, '{}'::jsonb), 1, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, coalesce($21::jsonb, '{}'::jsonb))
        returning id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, draft_id, is_deduction, condition_id, phase, location, zone, folder, cost_code, props, version, deleted_at, created_at
        `,
        [
          ctx.company.id,
          projectId,
          measurementInput.blueprintDocumentId,
          measurementInput.pageId,
          measurementInput.serviceItemCode,
          measurementInput.quantity,
          measurementInput.unit,
          measurementInput.notes,
          measurementInput.geometryJson,
          measurementInput.divisionCode,
          measurementInput.elevation,
          measurementInput.imageThumbnail,
          draftId,
          measurementInput.isDeduction,
          measurementInput.conditionId,
          measurementInput.phase,
          measurementInput.location,
          measurementInput.zone,
          measurementInput.folder,
          measurementInput.costCode,
          JSON.stringify(measurementInput.props),
        ],
      )
      const row = insertResult.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_measurement',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', measurement: row },
        outboxPayload: { measurement: row },
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    // Estimate recompute is a separate side-effect that fans out to
    // estimate_lines; not inside the mutation tx because a recompute failure
    // must not roll back a successfully-recorded measurement. Scope the
    // recompute to the draft we just wrote to (Phase A.4) so sibling
    // drafts' estimates survive untouched.
    const estimate = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId, { draftId })
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId, { draftId })
    ctx.sendJson(201, { measurement, estimate, scope_vs_bid: scopeVsBid })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    const parsedBody = parseJsonBody(TakeoffMeasurementsBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const measurements = Array.isArray(body.measurements) ? body.measurements : []
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)

    if (!measurements.length) {
      ctx.sendJson(400, { error: 'measurements array is required' })
      return true
    }

    const preparedMeasurements = measurements.map((measurement, index) =>
      prepareTakeoffMeasurementInput(measurement, `measurements[${index}]`),
    )
    const projectVersionResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query('select version from projects where company_id = $1 and id = $2', [ctx.company.id, projectId]),
    )
    const currentProject = projectVersionResult.rows[0]
    if (!currentProject) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
      ctx.sendJson(409, { error: 'version conflict', current_version: Number(currentProject.version) })
      return true
    }
    await assertBlueprintDocumentsBelongToProject(
      ctx.pool,
      ctx.company.id,
      projectId,
      preparedMeasurements.map((measurement) => measurement.blueprintDocumentId),
    )
    await assertBlueprintPagesBelongToProject(
      ctx.pool,
      ctx.company.id,
      projectId,
      preparedMeasurements.map((measurement) => ({
        blueprintDocumentId: measurement.blueprintDocumentId,
        pageId: measurement.pageId,
      })),
    )

    // Resolve target draft for the bulk-replace. The destructive soft-delete
    // below is scoped to (project_id, draft_id) so other drafts on the same
    // project survive untouched.
    const explicitBulkDraftId =
      typeof body.draft_id === 'string' && body.draft_id.trim().length > 0 ? body.draft_id.trim() : null
    let bulkDraftId: string | null = null
    if (explicitBulkDraftId) {
      const ok = await validateDraftId(ctx.pool, ctx.company.id, projectId, explicitBulkDraftId)
      if (!ok) {
        ctx.sendJson(400, { error: 'draft_id does not belong to this project' })
        return true
      }
      bulkDraftId = explicitBulkDraftId
    } else {
      bulkDraftId = await resolveDefaultDraftId(ctx.pool, ctx.company.id, projectId)
      if (!bulkDraftId) {
        ctx.sendJson(409, {
          error: 'project has no active default draft; create one via POST /api/projects/:id/takeoff-drafts',
        })
        return true
      }
    }

    // Curated-catalog enforcement applied per measurement BEFORE the
    // destructive soft-delete of the existing set, so a single bad row doesn't
    // wipe the project's takeoff history. Pre-load the
    // (service_item_code, division_code) tuples in one query so a
    // 50-measurement replay doesn't fan out to 100 round-trips.
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
      preparedMeasurements.map((m) => m.serviceItemCode),
    )
    for (const measurement of preparedMeasurements) {
      const fallbackDivision = measurement.divisionCode ?? projectDivisionCode
      const catalogStatus = catalogIndex.check(measurement.serviceItemCode, fallbackDivision)
      if (!catalogStatus.ok) {
        ctx.sendJson(422, {
          error: rejectionMessageForCatalog(catalogStatus.reason),
          service_item_code: measurement.serviceItemCode,
          division_code: fallbackDivision,
        })
        return true
      }
    }

    const replaced = await withMutationTx(async (client) => {
      // Scope the destructive soft-delete to the target draft so sibling
      // drafts on the same project survive untouched.
      await client.query(
        `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and project_id = $2 and draft_id = $3 and deleted_at is null
        `,
        [ctx.company.id, projectId, bulkDraftId],
      )

      const createdRows: Record<string, unknown>[] = []
      for (const measurement of preparedMeasurements) {
        const insertResult = await client.query(
          `
          insert into takeoff_measurements (
            company_id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, version, division_code, elevation, image_thumbnail, draft_id, is_deduction, phase, location, zone, folder, cost_code, props
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::jsonb, '{}'::jsonb), 1, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, coalesce($20::jsonb, '{}'::jsonb))
          returning id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, draft_id, is_deduction, phase, location, zone, folder, cost_code, props, version, deleted_at, created_at
          `,
          [
            ctx.company.id,
            projectId,
            measurement.blueprintDocumentId,
            measurement.pageId,
            measurement.serviceItemCode,
            measurement.quantity,
            measurement.unit,
            measurement.notes,
            measurement.geometryJson,
            measurement.divisionCode,
            measurement.elevation,
            measurement.imageThumbnail,
            bulkDraftId,
            measurement.isDeduction,
            measurement.phase,
            measurement.location,
            measurement.zone,
            measurement.folder,
            measurement.costCode,
            JSON.stringify(measurement.props),
          ],
        )
        createdRows.push(insertResult.rows[0])
      }

      const estimate = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId, {
        draftId: bulkDraftId,
        executor: client,
      })
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_measurement',
        entityId: projectId,
        action: 'replace',
        syncPayload: {
          action: 'replace',
          measurementCount: createdRows.length,
          measurements: createdRows,
          estimate,
        },
        outboxPayload: {
          measurementCount: createdRows.length,
          measurements: createdRows,
          estimate,
        },
      })
      return { createdRows, estimate }
    })
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId, { draftId: bulkDraftId })
    ctx.sendJson(201, {
      measurements: replaced.createdRows,
      estimate: replaced.estimate,
      scope_vs_bid: scopeVsBid,
    })
    return true
  }

  return false
}

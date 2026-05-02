import type http from 'node:http'
import type { Pool } from 'pg'
import { calculateGeometryQuantity, normalizeGeometry } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseExpectedVersion } from '../http-utils.js'
import {
  assertServiceItemCatalogStatus as assertServiceItemCatalogStatusImpl,
  loadServiceItemCatalogIndex,
  rejectionMessageForCatalog,
} from '../catalog.js'
import { createEstimateFromMeasurements, getScopeVsBid } from './estimate.js'

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
  divisionCode: string | null
  // Sitemap §5 panel 1 — first-class elevation tag (East / South /
  // West / North / Roof / Other / null = untagged).
  elevation: string | null
  // Sitemap §5 panel 3 — photo-measure thumbnail as a data URL.
  // Compressed client-side (≈ 30–80KB) so it fits inline; the
  // photo-bucket follow-on will swap this for a Spaces storage key.
  imageThumbnail: string | null
}

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

  return {
    serviceItemCode,
    quantity,
    unit,
    notes,
    geometryJson,
    blueprintDocumentId,
    divisionCode,
    elevation,
    imageThumbnail,
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
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const measurementInput = prepareTakeoffMeasurementInput(body)

    const projectVersionResult = await ctx.pool.query(
      'select version from projects where company_id = $1 and id = $2',
      [ctx.company.id, projectId],
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

    // Curated-catalog enforcement (per spec): a takeoff cannot reference a
    // service item without at least one curated division mapping, and if a
    // division was supplied it must be in the allowed set.
    const projectDivisionResult = await ctx.pool.query<{ division_code: string | null }>(
      'select division_code from projects where company_id = $1 and id = $2',
      [ctx.company.id, projectId],
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

    const measurement = await withMutationTx(async (client) => {
      const insertResult = await client.query(
        `
        insert into takeoff_measurements (
          company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code, elevation, image_thumbnail
        )
        values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1, $9, $10, $11)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, version, deleted_at, created_at
        `,
        [
          ctx.company.id,
          projectId,
          measurementInput.blueprintDocumentId,
          measurementInput.serviceItemCode,
          measurementInput.quantity,
          measurementInput.unit,
          measurementInput.notes,
          measurementInput.geometryJson,
          measurementInput.divisionCode,
          measurementInput.elevation,
          measurementInput.imageThumbnail,
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
    // must not roll back a successfully-recorded measurement.
    const estimate = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId)
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId)
    ctx.sendJson(201, { measurement, estimate, scope_vs_bid: scopeVsBid })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const measurements = Array.isArray(body.measurements) ? body.measurements : []
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)

    if (!measurements.length) {
      ctx.sendJson(400, { error: 'measurements array is required' })
      return true
    }

    const preparedMeasurements = measurements.map((measurement, index) =>
      prepareTakeoffMeasurementInput(measurement, `measurements[${index}]`),
    )
    const projectVersionResult = await ctx.pool.query(
      'select version from projects where company_id = $1 and id = $2',
      [ctx.company.id, projectId],
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

    // Curated-catalog enforcement applied per measurement BEFORE the
    // destructive soft-delete of the existing set, so a single bad row doesn't
    // wipe the project's takeoff history. Pre-load the
    // (service_item_code, division_code) tuples in one query so a
    // 50-measurement replay doesn't fan out to 100 round-trips.
    const projectDivisionResult = await ctx.pool.query<{ division_code: string | null }>(
      'select division_code from projects where company_id = $1 and id = $2',
      [ctx.company.id, projectId],
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
      await client.query(
        `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and project_id = $2 and deleted_at is null
        `,
        [ctx.company.id, projectId],
      )

      const createdRows: Record<string, unknown>[] = []
      for (const measurement of preparedMeasurements) {
        const insertResult = await client.query(
          `
          insert into takeoff_measurements (
            company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code, elevation, image_thumbnail
          )
          values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1, $9, $10, $11)
          returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, version, deleted_at, created_at
          `,
          [
            ctx.company.id,
            projectId,
            measurement.blueprintDocumentId,
            measurement.serviceItemCode,
            measurement.quantity,
            measurement.unit,
            measurement.notes,
            measurement.geometryJson,
            measurement.divisionCode,
            measurement.elevation,
            measurement.imageThumbnail,
          ],
        )
        createdRows.push(insertResult.rows[0])
      }

      const estimate = await createEstimateFromMeasurements(ctx.pool, ctx.company.id, projectId, client)
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
    const scopeVsBid = await getScopeVsBid(ctx.pool, ctx.company.id, projectId)
    ctx.sendJson(201, {
      measurements: replaced.createdRows,
      estimate: replaced.estimate,
      scope_vs_bid: scopeVsBid,
    })
    return true
  }

  return false
}

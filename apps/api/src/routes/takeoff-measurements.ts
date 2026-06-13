import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { calculateGeometryQuantity, detectDeductionOverlaps, normalizeGeometry } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { evaluateLww } from '../lww.js'
import { recordMutationLedger, withCompanyClient } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseJsonBody } from '../http-utils.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'
import { resolveDefaultDraftId } from './takeoff-drafts.js'
import { assertBlueprintPagesBelongToProject } from './takeoff-write.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

const ELEVATION_VOCAB_PATCH = new Set(['east', 'south', 'west', 'north', 'roof', 'other'])

const NumericInputSchema = z.union([z.number(), z.string()])

// PATCH /api/takeoff/measurements/:id wire-format. Every column is optional
// (partial patch). `geometry` is a deep polygon/lineal/volume blob handed
// to `normalizeGeometry` downstream, so it stays `unknown` here; the schema
// only types the scalar control fields + version. Permissive on purpose —
// the handler keeps its own null/undefined/'' discrimination.
const TakeoffMeasurementPatchBodySchema = z
  .object({
    service_item_code: z.string().nullish(),
    quantity: NumericInputSchema.nullish(),
    unit: z.string().nullish(),
    notes: z.string().nullish(),
    blueprint_document_id: z.string().nullish(),
    page_id: z.string().nullish(),
    geometry: z.unknown().optional(),
    elevation: z.string().nullish(),
    is_deduction: z.boolean().nullish(),
    assembly_id: z.string().nullish(),
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
  })
  .loose()

// DELETE /api/takeoff/measurements/:id wire-format. The body, when present,
// only carries the optimistic-concurrency version fields.
const TakeoffMeasurementDeleteBodySchema = z
  .object({
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
  })
  .loose()

export type TakeoffMeasurementRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  /**
   * Same contract as server.ts's `assertBlueprintDocumentsBelongToProject`.
   * Throws HttpError(400) when any id is missing/foreign-tenant.
   */
  assertBlueprintDocumentsBelongToProject: (
    companyId: string,
    projectId: string,
    blueprintDocumentIds: Array<string | null>,
  ) => Promise<void>
}

/**
 * Handle takeoff_measurement routes:
 * - GET    /api/projects/<id>/takeoff/measurements  — per-project list
 * - PATCH  /api/takeoff/measurements/<id>           — versioned update;
 *                                                      LWW-gated via the
 *                                                      If-Unmodified-Since
 *                                                      header (409 with
 *                                                      authoritative server
 *                                                      row when stale)
 * - DELETE /api/takeoff/measurements/<id>           — versioned soft-delete
 *
 * The POST/POST-bulk paths still live in server.ts because they share
 * catalog enforcement helpers with measurement create.
 */
export async function handleTakeoffMeasurementRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TakeoffMeasurementRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    // Optional ?draft_id= filter (Phase A.2). When omitted, default to the
    // project's active default draft so existing callers (the takeoff
    // canvas before the picker UI lands in Phase A.3) keep seeing a coherent
    // measurement set. Migration 066 backfilled existing projects and
    // project-create now auto-inserts a default draft, so the only path to
    // `resolveDefaultDraftId === null` is an operator hard-deleting every
    // draft via psql — in which case we return an empty set rather than
    // silently surfacing rows from a deleted draft.
    const explicitDraftId = url.searchParams.get('draft_id')
    let draftFilter: string
    const params: unknown[] = [ctx.company.id, projectId]
    if (explicitDraftId !== null) {
      if (!isValidUuid(explicitDraftId)) {
        ctx.sendJson(400, { error: 'draft_id must be a valid uuid' })
        return true
      }
      draftFilter = 'and draft_id = $3'
      params.push(explicitDraftId)
    } else {
      const defaultDraftId = await resolveDefaultDraftId(ctx.pool, ctx.company.id, projectId)
      if (defaultDraftId === null) {
        ctx.sendJson(200, { measurements: [] })
        return true
      }
      draftFilter = 'and draft_id = $3'
      params.push(defaultDraftId)
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `
      select id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, division_code, elevation, image_thumbnail, draft_id, is_deduction, condition_id, phase, location, zone, folder, cost_code, props, version, deleted_at, created_at
      from takeoff_measurements
      where company_id = $1 and project_id = $2 and deleted_at is null ${draftFilter}
      order by created_at desc
      `,
        params,
      ),
    )
    ctx.sendJson(200, { measurements: result.rows })
    return true
  }

  // GET /api/projects/:id/takeoff/deduction-overlaps — flag overlapping cutout
  // (is_deduction) polygons on the same page (gap G8: "overlaps not
  // deduplicated"). Overlapping cutouts double-subtract their shared area,
  // deflating the net takeoff. Read-only; the dedup/clip itself is a follow-up.
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/deduction-overlaps$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const explicitDraftId = url.searchParams.get('draft_id')
    const params: unknown[] = [ctx.company.id, projectId]
    let draftFilter: string
    if (explicitDraftId !== null) {
      if (!isValidUuid(explicitDraftId)) {
        ctx.sendJson(400, { error: 'draft_id must be a valid uuid' })
        return true
      }
      draftFilter = 'and draft_id = $3'
      params.push(explicitDraftId)
    } else {
      const defaultDraftId = await resolveDefaultDraftId(ctx.pool, ctx.company.id, projectId)
      if (defaultDraftId === null) {
        ctx.sendJson(200, { overlaps: [], count: 0 })
        return true
      }
      draftFilter = 'and draft_id = $3'
      params.push(defaultDraftId)
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string; page_id: string | null; is_deduction: boolean; geometry: unknown }>(
        `select id, page_id, is_deduction, geometry
           from takeoff_measurements
          where company_id = $1 and project_id = $2 and deleted_at is null ${draftFilter}`,
        params,
      ),
    )
    const overlaps = detectDeductionOverlaps(
      result.rows.map((r) => ({ id: r.id, pageId: r.page_id, isDeduction: r.is_deduction, geometry: r.geometry })),
    )
    ctx.sendJson(200, { overlaps, count: overlaps.length })
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const measurementId = url.pathname.split('/')[4] ?? ''
    if (!measurementId) {
      ctx.sendJson(400, { error: 'measurement id is required' })
      return true
    }
    const parsed = parseJsonBody(TakeoffMeasurementPatchBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    let geometryJson: string | null = null
    let quantity: unknown = body.quantity ?? null
    if (body.geometry !== undefined && body.geometry !== null && body.geometry !== '') {
      const geometry = normalizeGeometry(body.geometry)
      if (!geometry) {
        ctx.sendJson(400, {
          error: 'geometry must be a polygon, lineal path, or volume box with positive dimensions',
        })
        return true
      }
      geometryJson = JSON.stringify(geometry)
      quantity = calculateGeometryQuantity(geometry)
      const numericQuantity = Number(quantity)
      if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
        ctx.sendJson(400, { error: 'geometry must produce a positive, finite quantity' })
        return true
      }
    }
    if (quantity !== null && quantity !== undefined && quantity !== '') {
      const parsedQuantity = Number(quantity)
      if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
        ctx.sendJson(400, { error: 'quantity must be a non-negative number' })
        return true
      }
      quantity = parsedQuantity
    }
    const patchBlueprintDocumentId =
      body.blueprint_document_id === undefined ||
      body.blueprint_document_id === null ||
      body.blueprint_document_id === ''
        ? null
        : String(body.blueprint_document_id)
    const patchPageId =
      body.page_id === undefined || body.page_id === null || body.page_id === '' ? null : String(body.page_id)
    if (patchBlueprintDocumentId) {
      if (!isValidUuid(patchBlueprintDocumentId)) {
        ctx.sendJson(400, { error: 'blueprint_document_id must be a valid uuid' })
        return true
      }
    }
    if (patchPageId) {
      if (!isValidUuid(patchPageId)) {
        ctx.sendJson(400, { error: 'page_id must be a valid uuid' })
        return true
      }
    }
    // PlanSwift Phase 2: attach/detach an assembly to this measurement.
    //   - assembly_id: <uuid>  → attach (validated: active assembly for this company)
    //   - assembly_id: null/'' → detach (back to the flat-line path)
    //   - assembly_id absent    → leave unchanged
    // `attachAssembly` distinguishes "patch the column" from "leave alone".
    let attachAssembly = false
    let nextAssemblyId: string | null = null
    if (body.assembly_id !== undefined) {
      attachAssembly = true
      if (body.assembly_id === null || body.assembly_id === '') {
        nextAssemblyId = null
      } else {
        const candidate = String(body.assembly_id)
        if (!isValidUuid(candidate)) {
          ctx.sendJson(400, { error: 'assembly_id must be a valid uuid or null' })
          return true
        }
        const exists = await withCompanyClient(ctx.company.id, (c) =>
          c.query<{ id: string }>(
            `select id from service_item_assemblies
              where company_id = $1 and id = $2 and deleted_at is null limit 1`,
            [ctx.company.id, candidate],
          ),
        )
        if (!exists.rows[0]) {
          ctx.sendJson(404, { error: 'assembly not found' })
          return true
        }
        nextAssemblyId = candidate
      }
    }

    if (patchBlueprintDocumentId || patchPageId) {
      const measurementProjectResult = await withCompanyClient(ctx.company.id, (c) =>
        c.query<{ project_id: string; blueprint_document_id: string | null; page_id: string | null }>(
          `select project_id, blueprint_document_id, page_id
           from takeoff_measurements
           where company_id = $1 and id = $2 and deleted_at is null
           limit 1`,
          [ctx.company.id, measurementId],
        ),
      )
      const currentMeasurement = measurementProjectResult.rows[0]
      if (!currentMeasurement) {
        ctx.sendJson(404, { error: 'measurement not found' })
        return true
      }
      const nextBlueprintDocumentId = patchBlueprintDocumentId ?? currentMeasurement.blueprint_document_id
      const nextPageId = patchPageId ?? currentMeasurement.page_id
      if (nextPageId && !nextBlueprintDocumentId) {
        ctx.sendJson(400, { error: 'blueprint_document_id is required when page_id is supplied' })
        return true
      }
      await ctx.assertBlueprintDocumentsBelongToProject(ctx.company.id, currentMeasurement.project_id, [
        patchBlueprintDocumentId,
      ])
      await assertBlueprintPagesBelongToProject(ctx.pool, ctx.company.id, currentMeasurement.project_id, [
        { blueprintDocumentId: nextBlueprintDocumentId, pageId: nextPageId },
      ])
    }

    const ifUnmodifiedSince = req.headers['if-unmodified-since']
    if (ifUnmodifiedSince) {
      const currentRow = await withCompanyClient(ctx.company.id, (c) =>
        c.query<{
          id: string
          project_id: string
          blueprint_document_id: string | null
          service_item_code: string
          quantity: string
          unit: string
          notes: string | null
          geometry: unknown
          version: number
          deleted_at: string | null
          created_at: string
          updated_at: string
        }>(
          `select id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes,
                geometry, elevation, version, deleted_at, created_at, updated_at
         from takeoff_measurements
         where company_id = $1 and id = $2`,
          [ctx.company.id, measurementId],
        ),
      )
      const current = currentRow.rows[0]
      if (current) {
        const lww = evaluateLww(current.updated_at, ifUnmodifiedSince)
        if (!lww.ok && lww.reason === 'server_newer') {
          ctx.sendJson(409, {
            error: 'server has a newer change',
            entity: 'takeoff_measurement',
            server_value: current,
            server_updated_at: lww.serverUpdatedAt.toISOString(),
            client_reference: lww.clientReference.toISOString(),
          })
          return true
        }
        if (!lww.ok && lww.reason === 'header_unparseable') {
          ctx.sendJson(400, {
            error: 'If-Unmodified-Since header is not a valid timestamp',
            raw: lww.rawHeader,
          })
          return true
        }
      }
    }

    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'takeoff_measurement',
      entityName: 'measurement',
      table: 'takeoff_measurements',
      id: measurementId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      update: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update takeoff_measurements
          set
            service_item_code = coalesce($3, service_item_code),
            quantity = coalesce($4, quantity),
            unit = coalesce($5, unit),
            notes = coalesce($6, notes),
            blueprint_document_id = coalesce($7, blueprint_document_id),
            geometry = coalesce($8::jsonb, geometry),
            elevation = coalesce($10, elevation),
            page_id = coalesce($11, page_id),
            is_deduction = coalesce($12, is_deduction),
            assembly_id = case when $13::boolean then $14::uuid else assembly_id end,
            version = version + 1,
            updated_at = now()
          where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
          returning id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, elevation, is_deduction, assembly_id, version, deleted_at, created_at, updated_at
          `,
          [
            ctx.company.id,
            measurementId,
            body.service_item_code ?? null,
            quantity,
            body.unit ?? null,
            body.notes ?? null,
            patchBlueprintDocumentId,
            geometryJson,
            expectedVersion,
            body.elevation === undefined || body.elevation === null || String(body.elevation).trim() === ''
              ? null
              : (() => {
                  const v = String(body.elevation).trim().toLowerCase()
                  if (!ELEVATION_VOCAB_PATCH.has(v)) {
                    throw new HttpError(400, 'elevation must be one of: east, south, west, north, roof, other')
                  }
                  return v
                })(),
            patchPageId,
            body.is_deduction === undefined ? null : body.is_deduction === true,
            attachAssembly,
            nextAssemblyId,
          ],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'takeoff_measurement',
          entityId: measurementId,
          action: 'update',
          row,
          syncPayload: { action: 'update', measurement: row },
        })
        return row
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const measurementId = url.pathname.split('/')[4] ?? ''
    if (!measurementId) {
      ctx.sendJson(400, { error: 'measurement id is required' })
      return true
    }
    const parsed = parseJsonBody(TakeoffMeasurementDeleteBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'takeoff_measurement',
      entityName: 'measurement',
      table: 'takeoff_measurements',
      id: measurementId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update takeoff_measurements
          set deleted_at = now(), version = version + 1
          where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
          returning id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, elevation, version, deleted_at, created_at
          `,
          [ctx.company.id, measurementId, expectedVersion],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'takeoff_measurement',
          entityId: measurementId,
          action: 'delete',
          row,
          syncPayload: { action: 'delete', measurement: row },
        })
        return row
      },
    })
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `takeoff-measurements` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const takeoffMeasurementsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'takeoff-measurements',
  order: 330,
  handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
    handleTakeoffMeasurementRoutes(req, url, {
      pool,
      company,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      checkVersion,
      assertBlueprintDocumentsBelongToProject: ctx.assertBlueprintDocumentsBelongToProject,
    }),
}

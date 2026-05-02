import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { calculateGeometryQuantity, normalizeGeometry } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { evaluateLww } from '../lww.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseExpectedVersion } from '../http-utils.js'

const ELEVATION_VOCAB_PATCH = new Set(['east', 'south', 'west', 'north', 'roof', 'other'])

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
    const result = await ctx.pool.query(
      `
      select id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, elevation, image_thumbnail, version, deleted_at, created_at
      from takeoff_measurements
      where company_id = $1 and project_id = $2 and deleted_at is null
      order by created_at desc
      `,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { measurements: result.rows })
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const measurementId = url.pathname.split('/')[4] ?? ''
    if (!measurementId) {
      ctx.sendJson(400, { error: 'measurement id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
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
    if (patchBlueprintDocumentId) {
      if (!isValidUuid(patchBlueprintDocumentId)) {
        ctx.sendJson(400, { error: 'blueprint_document_id must be a valid uuid' })
        return true
      }
      const measurementProjectResult = await ctx.pool.query<{ project_id: string }>(
        'select project_id from takeoff_measurements where company_id = $1 and id = $2 and deleted_at is null limit 1',
        [ctx.company.id, measurementId],
      )
      const measurementProjectId = measurementProjectResult.rows[0]?.project_id
      if (!measurementProjectId) {
        ctx.sendJson(404, { error: 'measurement not found' })
        return true
      }
      await ctx.assertBlueprintDocumentsBelongToProject(ctx.company.id, measurementProjectId, [
        patchBlueprintDocumentId,
      ])
    }

    const ifUnmodifiedSince = req.headers['if-unmodified-since']
    if (ifUnmodifiedSince) {
      const currentRow = await ctx.pool.query<{
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
        `select id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes,
                geometry, elevation, version, deleted_at, created_at, updated_at
         from takeoff_measurements
         where company_id = $1 and id = $2`,
        [ctx.company.id, measurementId],
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

    const updated = await withMutationTx(async (client: PoolClient) => {
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
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, elevation, version, deleted_at, created_at, updated_at
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
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'takeoff_measurements',
          'company_id = $1 and id = $2',
          [ctx.company.id, measurementId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'measurement not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const measurementId = url.pathname.split('/')[4] ?? ''
    if (!measurementId) {
      ctx.sendJson(400, { error: 'measurement id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, elevation, version, deleted_at, created_at
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
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'takeoff_measurements',
          'company_id = $1 and id = $2',
          [ctx.company.id, measurementId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'measurement not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

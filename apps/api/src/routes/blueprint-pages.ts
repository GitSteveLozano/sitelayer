import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid } from '../http-utils.js'
import { assertKeyInCompany, getBlueprintMimeType, StorageError, type BlueprintStorage } from '../storage.js'

export type BlueprintPageRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  storage: BlueprintStorage
  blueprintDownloadPresigned: boolean
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void
}

const PAGE_COLUMNS = `
  id, company_id, blueprint_document_id, page_number, storage_path,
  calibration_world_distance, calibration_world_unit,
  calibration_x1, calibration_y1, calibration_x2, calibration_y2,
  calibration_set_at, calibration_set_by,
  scale_verified_at, scale_verified_by,
  measurement_count, origin, created_at, updated_at
`

interface PageRow {
  id: string
  company_id: string
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
  calibration_set_by: string | null
  scale_verified_at: string | null
  scale_verified_by: string | null
  measurement_count: number
  origin: string | null
  created_at: string
  updated_at: string
}

/**
 * Multi-page blueprints + per-page scale calibration (Phase 3B + 3C).
 *
 *   GET  /api/blueprints/:docId/pages              list pages on a doc
 *   POST /api/blueprints/:docId/pages              add a page (admin)
 *   GET  /api/blueprint-pages/:id/file             serve/redirect the
 *                                                  selected page asset
 *   POST /api/blueprint-pages/:id/calibrate        store the two-point
 *                                                  scale calibration
 *   POST /api/blueprint-pages/:id/verify           confirm / un-confirm the
 *                                                  sheet's scale (persists the
 *                                                  per-sheet VERIFIED state the
 *                                                  EST · SCALE VERIFY screen
 *                                                  surfaces). Body { verified }
 *                                                  defaults to true.
 *
 * The legacy single-page world is preserved by the migration's
 * backfill — every existing document has a page_number=1 row.
 */
export async function handleBlueprintPageRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BlueprintPageRouteCtx,
): Promise<boolean> {
  const docPagesMatch = url.pathname.match(/^\/api\/blueprints\/([^/]+)\/pages$/)

  if (req.method === 'GET' && docPagesMatch) {
    const docId = docPagesMatch[1]!
    if (!isValidUuid(docId)) {
      ctx.sendJson(400, { error: 'document id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<PageRow>(
        `select ${PAGE_COLUMNS}
       from blueprint_pages
       where company_id = $1 and blueprint_document_id = $2
       order by page_number asc`,
        [ctx.company.id, docId],
      ),
    )
    ctx.sendJson(200, { pages: result.rows })
    return true
  }

  if (req.method === 'POST' && docPagesMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const docId = docPagesMatch[1]!
    if (!isValidUuid(docId)) {
      ctx.sendJson(400, { error: 'document id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const pageNumber = Number(body.page_number)
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      ctx.sendJson(400, { error: 'page_number must be an integer >= 1' })
      return true
    }
    const storagePath = typeof body.storage_path === 'string' ? body.storage_path : null

    const docCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ exists: boolean }>(
        `select exists(select 1 from blueprint_documents where company_id = $1 and id = $2) as exists`,
        [ctx.company.id, docId],
      ),
    )
    if (!docCheck.rows[0]?.exists) {
      ctx.sendJson(404, { error: 'blueprint document not found' })
      return true
    }

    const created = await withMutationTx(async (client: PoolClient) => {
      const inserted = await client.query<PageRow>(
        `insert into blueprint_pages
           (company_id, blueprint_document_id, page_number, storage_path)
         values ($1, $2, $3, $4)
         on conflict (blueprint_document_id, page_number) do update
           set storage_path = excluded.storage_path,
               updated_at = now()
         returning ${PAGE_COLUMNS}`,
        [ctx.company.id, docId, pageNumber, storagePath],
      )
      const row = inserted.rows[0]
      if (!row) throw new HttpError(500, 'blueprint page insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'blueprint_page',
        entityId: row.id,
        action: 'create',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    ctx.sendJson(201, { page: created })
    return true
  }

  const fileMatch = url.pathname.match(/^\/api\/blueprint-pages\/([^/]+)\/file$/)
  if (req.method === 'GET' && fileMatch) {
    const pageId = fileMatch[1]!
    if (!isValidUuid(pageId)) {
      ctx.sendJson(400, { error: 'page id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{
        page_number: number
        page_storage_path: string | null
        file_name: string
        document_storage_path: string
      }>(
        `
        select
          p.page_number,
          p.storage_path as page_storage_path,
          d.file_name,
          d.storage_path as document_storage_path
        from blueprint_pages p
        join blueprint_documents d
          on d.company_id = p.company_id
         and d.id = p.blueprint_document_id
         and d.deleted_at is null
        where p.company_id = $1 and p.id = $2
        limit 1
        `,
        [ctx.company.id, pageId],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'blueprint page not found' })
      return true
    }

    const storagePath = row.page_storage_path ?? row.document_storage_path
    const sourceName = row.page_storage_path ? fileNameFromPath(row.page_storage_path) : row.file_name
    try {
      const storageKey = assertBlueprintPageFilePath(ctx.company.id, storagePath)
      if (ctx.blueprintDownloadPresigned) {
        const signedUrl = await ctx.storage.getDownloadUrl(storageKey, { fileName: sourceName })
        if (signedUrl) {
          ctx.sendFileRedirect(signedUrl)
          return true
        }
      }
      const content = await ctx.storage.get(storageKey)
      ctx.sendFileContent(getBlueprintMimeType(sourceName), sanitizeFileName(sourceName), content)
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      ctx.sendJson(404, { error: 'blueprint page file not found' })
    }
    return true
  }

  const calibrateMatch = url.pathname.match(/^\/api\/blueprint-pages\/([^/]+)\/calibrate$/)
  if (req.method === 'POST' && calibrateMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const pageId = calibrateMatch[1]!
    if (!isValidUuid(pageId)) {
      ctx.sendJson(400, { error: 'page id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const distance = Number(body.world_distance)
    const unit = typeof body.world_unit === 'string' ? body.world_unit.trim() : 'in'
    const x1 = Number(body.x1)
    const y1 = Number(body.y1)
    const x2 = Number(body.x2)
    const y2 = Number(body.y2)
    if (![distance, x1, y1, x2, y2].every(Number.isFinite)) {
      ctx.sendJson(400, { error: 'world_distance + (x1, y1, x2, y2) all required' })
      return true
    }
    if (distance <= 0) {
      ctx.sendJson(400, { error: 'world_distance must be > 0' })
      return true
    }
    // Two-point calibration with both ends at the same pixel is a
    // zero-length segment — pixels-per-unit would be infinite. Reject
    // before persisting so downstream callers don't divide by zero.
    if (x1 === x2 && y1 === y2) {
      ctx.sendJson(400, { error: 'calibration points must be distinct' })
      return true
    }

    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<PageRow>(
        `update blueprint_pages
           set calibration_world_distance = $3,
               calibration_world_unit = $4,
               calibration_x1 = $5,
               calibration_y1 = $6,
               calibration_x2 = $7,
               calibration_y2 = $8,
               calibration_set_at = now(),
               calibration_set_by = $9,
               updated_at = now()
         where company_id = $1 and id = $2
         returning ${PAGE_COLUMNS}`,
        [ctx.company.id, pageId, distance, unit, x1, y1, x2, y2, ctx.currentUserId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'blueprint_page',
        entityId: row.id,
        action: 'calibrate',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'page not found' })
      return true
    }
    ctx.sendJson(200, { page: updated })
    return true
  }

  // POST /api/blueprint-pages/:id/verify — persist the per-sheet scale
  // VERIFIED state. `{ verified: false }` clears it (re-review). This is a
  // human sign-off, distinct from calibration: AI-autoscale can set a
  // calibration without anyone having confirmed the sheet, and an estimator
  // may want to eyeball a calibrated sheet before trusting its quantities.
  const verifyMatch = url.pathname.match(/^\/api\/blueprint-pages\/([^/]+)\/verify$/)
  if (req.method === 'POST' && verifyMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const pageId = verifyMatch[1]!
    if (!isValidUuid(pageId)) {
      ctx.sendJson(400, { error: 'page id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    // Default to verifying; only an explicit `false` un-verifies.
    const verified = body.verified === undefined ? true : body.verified === true

    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<PageRow>(
        `update blueprint_pages
           set scale_verified_at = case when $3 then now() else null end,
               scale_verified_by = case when $3 then $4 else null end,
               updated_at = now()
         where company_id = $1 and id = $2
         returning ${PAGE_COLUMNS}`,
        [ctx.company.id, pageId, verified, ctx.currentUserId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'blueprint_page',
        entityId: row.id,
        action: verified ? 'verify_scale' : 'unverify_scale',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'page not found' })
      return true
    }
    ctx.sendJson(200, { page: updated })
    return true
  }

  return false
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return cleaned || 'blueprint-page'
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'blueprint-page'
}

function assertBlueprintPageFilePath(companyId: string, storagePath: string): string {
  try {
    return assertKeyInCompany(companyId, storagePath)
  } catch (err) {
    if (err instanceof StorageError) throw new HttpError(err.status, err.message)
    throw err
  }
}

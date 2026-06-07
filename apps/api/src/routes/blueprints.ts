import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertKeyInCompany,
  buildBlueprintPageStorageKey,
  buildBlueprintStorageKey,
  getBlueprintMimeType,
  StorageError,
  type BlueprintStorage,
} from '../storage.js'
import { isMultipartRequest, parseBlueprintMultipart, type BlueprintMultipartResult } from '../blueprint-upload.js'
import type { PdfPageRasterizer } from '../blueprint-rasterize.js'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, recordMutationOutbox, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { z } from 'zod'
import { HttpError, parseExpectedVersion, parseJsonBody } from '../http-utils.js'
import { deleteVersionedEntity } from '../versioned-update.js'

// DELETE /api/blueprints/:id wire-format. Deep parsing is delegated to
// `deleteVersionedEntity`, which only reads the optimistic-version control
// fields off the body — so we type just those (string-or-number) and keep
// `.loose()` for everything else. The multipart-bearing POST/PATCH/versions
// handlers in this module are intentionally left raw (multipart + multi-alias
// bodies are out of scope for the JSON request-validation boundary).
const NumericInputSchema = z.union([z.number(), z.string()])
const BlueprintDeleteBodySchema = z
  .object({
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
  })
  .loose()

type BlueprintDocumentRow = {
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
  file_url: string
  created_at: string
}

const DEFAULT_MAX_RASTERIZE_PDF_BYTES = 25 * 1024 * 1024

export type BlueprintRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  storage: BlueprintStorage
  maxBlueprintUploadBytes: number
  blueprintDownloadPresigned: boolean
  /**
   * Serve a blueprint file body with CORS headers already applied.
   * Called for the inline file-download path when a presigned URL is not
   * available.
   */
  sendFileContent: (mimeType: string, fileName: string, content: Buffer) => void
  /**
   * Issue a 302 redirect to a presigned storage URL, with CORS headers
   * already applied.
   */
  sendFileRedirect: (location: string) => void
  rasterizePdfPage?: PdfPageRasterizer | undefined
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return cleaned || 'blueprint.pdf'
}

function getBlueprintFilePath(companyId: string, blueprintId: string, fileName: string): string {
  return buildBlueprintStorageKey(companyId, blueprintId, fileName)
}

function assertBlueprintFilePath(companyId: string, filePath: string): string {
  try {
    return assertKeyInCompany(companyId, filePath)
  } catch (err) {
    if (err instanceof StorageError) throw new HttpError(err.status, err.message)
    throw err
  }
}

function resolveBlueprintStoragePath(
  companyId: string,
  blueprintId: string,
  fileName: string,
  requestedPath?: string | null,
): string {
  const cleanRequested = requestedPath?.trim()
  if (!cleanRequested) return buildBlueprintStorageKey(companyId, blueprintId, fileName)
  return assertBlueprintFilePath(companyId, cleanRequested)
}

function maxRasterizePdfBytes(): number {
  const parsed = Number(process.env.MAX_BLUEPRINT_RASTERIZE_BYTES ?? DEFAULT_MAX_RASTERIZE_PDF_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RASTERIZE_PDF_BYTES
}

function decodeBlueprintFileBase64(contentsBase64: string): Buffer {
  const source = contentsBase64.includes(',') ? (contentsBase64.split(',', 2)[1] ?? '') : contentsBase64
  return Buffer.from(source, 'base64')
}

/**
 * Normalize a client-supplied `sheet_scale` into the form the
 * `numeric(12,4)` column accepts. `sheet_scale` is a unitless ratio
 * (e.g. 0.25), not a draftsman's label like "1/4in=1ft" — passing the
 * raw label straight to Postgres throws 22P02 (invalid_text_representation)
 * which surfaces as an opaque 500. Returns `undefined` when no value was
 * supplied (caller treats that as "leave column unchanged"), a finite
 * number when it parses, or `null` when the value is present but not a
 * finite number (caller turns that into a 400).
 */
function parseSheetScale(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function persistBlueprintFile(
  storage: BlueprintStorage,
  companyId: string,
  blueprintId: string,
  fileName: string,
  contents: Buffer,
): Promise<string> {
  const key = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  await storage.put(key, contents, getBlueprintMimeType(fileName))
  return key
}

async function copyBlueprintFile(
  storage: BlueprintStorage,
  companyId: string,
  blueprintId: string,
  sourcePath: string,
  fileName: string,
): Promise<string> {
  const sourceKey = assertBlueprintFilePath(companyId, sourcePath)
  const destKey = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  await storage.copy(sourceKey, destKey)
  return destKey
}

async function maybeRasterizeFirstPdfPage(
  ctx: BlueprintRouteCtx,
  blueprintId: string,
  fileName: string,
  documentStoragePath: string,
  source: { pdfBytes?: Buffer | null; sourceBytes?: number | null } = {},
): Promise<string | null> {
  if (!ctx.rasterizePdfPage || !fileName.toLowerCase().endsWith('.pdf')) return null
  const maxBytes = maxRasterizePdfBytes()
  if (!source.pdfBytes && source.sourceBytes == null) return null
  if (source.sourceBytes != null && source.sourceBytes > maxBytes) return null
  if (source.pdfBytes && source.pdfBytes.length > maxBytes) return null
  try {
    const documentStorageKey = assertBlueprintFilePath(ctx.company.id, documentStoragePath)
    const pdfBytes = source.pdfBytes ?? (await ctx.storage.get(documentStorageKey))
    if (pdfBytes.length > maxBytes) return null
    const rasterBytes = await ctx.rasterizePdfPage(pdfBytes, { pageNumber: 1 })
    const rasterStoragePath = buildBlueprintPageStorageKey(ctx.company.id, blueprintId, 1, 'png')
    await ctx.storage.put(rasterStoragePath, rasterBytes, 'image/png')
    return rasterStoragePath
  } catch (err) {
    console.warn('[blueprints] first-page rasterization failed; keeping PDF fallback', {
      blueprintId,
      companyId: ctx.company.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function cleanupGeneratedRaster(ctx: BlueprintRouteCtx, storagePath: string | null): Promise<void> {
  if (!storagePath) return
  try {
    await ctx.storage.deleteObject(storagePath)
  } catch (err) {
    console.warn('[blueprints] failed to clean up generated page raster after transaction failure', {
      companyId: ctx.company.id,
      storagePath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function listBlueprintDocuments(_pool: Pool, companyId: string, projectId: string) {
  const result = await withCompanyClient(companyId, (client) =>
    client.query(
      `
    select
      id,
      project_id,
      file_name,
      storage_path,
      preview_type,
      calibration_length,
      calibration_unit,
      sheet_scale,
      version,
      deleted_at,
      replaces_blueprint_document_id,
      concat('/api/blueprints/', id, '/file') as file_url,
      created_at
    from blueprint_documents
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by version desc, created_at desc
    `,
      [companyId, projectId],
    ),
  )
  return result.rows as BlueprintDocumentRow[]
}

/**
 * Handle blueprint document routes:
 * - GET    /api/projects/<id>/blueprints      — list blueprints for project
 * - POST   /api/projects/<id>/blueprints      — admin/foreman/office; upload
 *                                               (multipart or base64 JSON)
 * - PATCH  /api/blueprints/<id>              — admin/foreman/office; versioned
 *                                               metadata + optional file update
 * - POST   /api/blueprints/<id>/versions     — admin/foreman/office; create a
 *                                               new version, copies measurements
 * - GET    /api/blueprints/<id>/file         — serve or redirect file content
 * - DELETE /api/blueprints/<id>              — admin/foreman/office; soft-delete
 */
export async function handleBlueprintRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BlueprintRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    ctx.sendJson(200, { blueprints: await listBlueprintDocuments(ctx.pool, ctx.company.id, projectId) })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    let body: Record<string, unknown>
    let multipartResult: BlueprintMultipartResult | null = null
    let blueprintId: string
    if (isMultipartRequest(req)) {
      blueprintId = randomUUID()
      multipartResult = await parseBlueprintMultipart(req, ctx.storage, ctx.company.id, blueprintId, 'blueprint.pdf', {
        maxFileBytes: ctx.maxBlueprintUploadBytes,
      })
      body = multipartResult.fields
    } else {
      body = await ctx.readBody()
      blueprintId = String(body.id ?? randomUUID())
    }
    const fileName = String(body.file_name ?? body.original_file_name ?? multipartResult?.fileName ?? '').trim()
    const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
    const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
    if (!fileName && !fileContentsBase64 && !multipartResult) {
      ctx.sendJson(400, { error: 'file_name, file_contents_base64, or multipart upload is required' })
      return true
    }
    const versionResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ version: number }>(
        'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
        [ctx.company.id, projectId],
      ),
    )
    const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
    const resolvedFileName = fileName || multipartResult?.fileName || 'blueprint.pdf'
    const fileContents = fileContentsBase64 ? decodeBlueprintFileBase64(fileContentsBase64) : null
    let resolvedStoragePath = multipartResult
      ? multipartResult.storagePath
      : resolveBlueprintStoragePath(ctx.company.id, blueprintId, resolvedFileName, requestedStoragePath)
    if (!multipartResult && fileContents) {
      resolvedStoragePath = await persistBlueprintFile(
        ctx.storage,
        ctx.company.id,
        blueprintId,
        resolvedFileName,
        fileContents,
      )
    }
    const firstPageStoragePath = await maybeRasterizeFirstPdfPage(
      ctx,
      blueprintId,
      resolvedFileName,
      resolvedStoragePath,
      {
        pdfBytes: fileContents,
        sourceBytes: multipartResult?.bytes ?? fileContents?.length ?? null,
      },
    )
    let blueprint: unknown
    try {
      blueprint = await withMutationTx(async (client) => {
        const inserted = await client.query(
          `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
          [
            blueprintId,
            ctx.company.id,
            projectId,
            resolvedFileName,
            resolvedStoragePath,
            body.preview_type ?? null,
            body.calibration_length ?? null,
            body.calibration_unit ?? null,
            body.sheet_scale ?? null,
            version,
            body.replaces_blueprint_document_id ?? null,
          ],
        )
        const row = inserted.rows[0]
        await client.query(
          `
        insert into blueprint_pages (company_id, blueprint_document_id, page_number, storage_path)
        values ($1, $2, 1, $3)
        on conflict (blueprint_document_id, page_number) do nothing
        `,
          [ctx.company.id, row.id, firstPageStoragePath ?? row.storage_path],
        )
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'blueprint_document',
          entityId: row.id,
          action: 'create',
          row,
          syncPayload: { action: 'create', blueprint: row },
        })
        return row
      })
    } catch (err) {
      await cleanupGeneratedRaster(ctx, firstPageStoragePath)
      throw err
    }
    ctx.sendJson(201, blueprint)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const blueprintId = url.pathname.split('/')[3] ?? ''
    if (!blueprintId) {
      ctx.sendJson(400, { error: 'blueprint id is required' })
      return true
    }
    let body: Record<string, unknown>
    let multipartResult: BlueprintMultipartResult | null = null
    if (isMultipartRequest(req)) {
      multipartResult = await parseBlueprintMultipart(req, ctx.storage, ctx.company.id, blueprintId, 'blueprint.pdf', {
        maxFileBytes: ctx.maxBlueprintUploadBytes,
      })
      body = multipartResult.fields
    } else {
      body = await ctx.readBody()
    }
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const sheetScale = parseSheetScale(body.sheet_scale)
    if (sheetScale === null) {
      ctx.sendJson(400, { error: 'sheet_scale must be a finite number (a unitless ratio, e.g. 0.25)' })
      return true
    }
    const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
    const storagePath = multipartResult
      ? multipartResult.storagePath
      : body.storage_path === undefined || !String(body.storage_path).trim()
        ? null
        : resolveBlueprintStoragePath(
            ctx.company.id,
            blueprintId,
            String(body.file_name ?? 'blueprint.pdf'),
            String(body.storage_path),
          )
    const updated = await withMutationTx(async (client) => {
      const result = await client.query(
        `
        update blueprint_documents
        set
          file_name = coalesce($3, file_name),
          storage_path = coalesce($4, storage_path),
          preview_type = coalesce($5, preview_type),
          calibration_length = coalesce($6, calibration_length),
          calibration_unit = coalesce($7, calibration_unit),
          sheet_scale = coalesce($8, sheet_scale),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
        [
          ctx.company.id,
          blueprintId,
          body.file_name ?? multipartResult?.fileName ?? null,
          storagePath,
          body.preview_type ?? null,
          body.calibration_length ?? null,
          body.calibration_unit ?? null,
          sheetScale ?? null,
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'blueprint_document',
        entityId: blueprintId,
        action: 'update',
        row,
        syncPayload: { action: 'update', blueprint: row },
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'blueprint_documents',
          'company_id = $1 and id = $2',
          [ctx.company.id, blueprintId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'blueprint not found' })
      return true
    }
    // Persisting blob is post-commit: a storage write is not part of
    // the DB transaction, so blobs only land after the row is durable.
    if (fileContentsBase64) {
      await persistBlueprintFile(
        ctx.storage,
        ctx.company.id,
        blueprintId,
        String(updated.file_name ?? body.file_name ?? 'blueprint.pdf'),
        decodeBlueprintFileBase64(fileContentsBase64),
      )
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/versions$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const sourceBlueprintId = url.pathname.split('/')[3] ?? ''
    if (!sourceBlueprintId) {
      ctx.sendJson(400, { error: 'blueprint id is required' })
      return true
    }
    const sourceResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `
      select id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at
      from blueprint_documents
      where company_id = $1 and id = $2 and deleted_at is null
      limit 1
      `,
        [ctx.company.id, sourceBlueprintId],
      ),
    )
    const source = sourceResult.rows[0]
    if (!source) {
      ctx.sendJson(404, { error: 'blueprint not found' })
      return true
    }
    let body: Record<string, unknown>
    let multipartResult: BlueprintMultipartResult | null = null
    const blueprintId = randomUUID()
    if (isMultipartRequest(req)) {
      multipartResult = await parseBlueprintMultipart(
        req,
        ctx.storage,
        ctx.company.id,
        blueprintId,
        String(source.file_name ?? 'blueprint.pdf'),
        { maxFileBytes: ctx.maxBlueprintUploadBytes },
      )
      body = multipartResult.fields
    } else {
      body = await ctx.readBody()
    }
    const copyMeasurements = body.copy_measurements !== false
    const fileName = String(body.file_name ?? multipartResult?.fileName ?? source.file_name ?? 'blueprint.pdf').trim()
    const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
    const fileContents = fileContentsBase64 ? decodeBlueprintFileBase64(fileContentsBase64) : null
    const versionResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ version: number }>(
        'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
        [ctx.company.id, source.project_id],
      ),
    )
    const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
    const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
    let storagePath = multipartResult
      ? multipartResult.storagePath
      : requestedStoragePath
        ? resolveBlueprintStoragePath(ctx.company.id, blueprintId, fileName, requestedStoragePath)
        : ''
    if (!multipartResult && fileContents) {
      storagePath = await persistBlueprintFile(ctx.storage, ctx.company.id, blueprintId, fileName, fileContents)
    } else if (!multipartResult && source.storage_path) {
      try {
        storagePath = await copyBlueprintFile(ctx.storage, ctx.company.id, blueprintId, source.storage_path, fileName)
      } catch {
        storagePath = getBlueprintFilePath(ctx.company.id, blueprintId, fileName)
      }
    } else if (!storagePath) {
      storagePath = getBlueprintFilePath(ctx.company.id, blueprintId, fileName)
    }
    const rasterSource = {
      pdfBytes: fileContents,
      sourceBytes: multipartResult?.bytes ?? fileContents?.length ?? null,
    }
    const versionFirstPageStoragePath = await maybeRasterizeFirstPdfPage(
      ctx,
      blueprintId,
      fileName,
      storagePath,
      rasterSource,
    )
    let newBlueprint: unknown
    try {
      newBlueprint = await withMutationTx(async (client) => {
        const inserted = await client.query(
          `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
          [
            blueprintId,
            ctx.company.id,
            source.project_id,
            fileName,
            storagePath,
            body.preview_type ?? source.preview_type ?? null,
            body.calibration_length ?? source.calibration_length ?? null,
            body.calibration_unit ?? source.calibration_unit ?? null,
            body.sheet_scale ?? source.sheet_scale ?? null,
            version,
            source.id,
          ],
        )
        const row = inserted.rows[0]
        const copiedPages = await client.query<{ source_page_id: string; new_page_id: string }>(
          `
        with source_pages as (
          select id, company_id, page_number, storage_path,
                 calibration_world_distance, calibration_world_unit,
                 calibration_x1, calibration_y1, calibration_x2, calibration_y2
          from blueprint_pages
          where company_id = $1 and blueprint_document_id = $2
        ),
        inserted_pages as (
          insert into blueprint_pages (
            company_id, blueprint_document_id, page_number, storage_path,
            calibration_world_distance, calibration_world_unit,
            calibration_x1, calibration_y1, calibration_x2, calibration_y2
          )
          select
            company_id, $3::uuid, page_number, coalesce(case when page_number = 1 then $5::text end, storage_path, $4),
            calibration_world_distance, calibration_world_unit,
            calibration_x1, calibration_y1, calibration_x2, calibration_y2
          from source_pages
          on conflict (blueprint_document_id, page_number) do update
            set storage_path = excluded.storage_path,
                calibration_world_distance = excluded.calibration_world_distance,
                calibration_world_unit = excluded.calibration_world_unit,
                calibration_x1 = excluded.calibration_x1,
                calibration_y1 = excluded.calibration_y1,
                calibration_x2 = excluded.calibration_x2,
                calibration_y2 = excluded.calibration_y2,
                updated_at = now()
          returning id, page_number
        )
        select s.id as source_page_id, i.id as new_page_id
        from source_pages s
        join inserted_pages i on i.page_number = s.page_number
        `,
          [ctx.company.id, source.id, row.id, row.storage_path, versionFirstPageStoragePath],
        )
        if (copiedPages.rows.length === 0) {
          await client.query(
            `
          insert into blueprint_pages (company_id, blueprint_document_id, page_number, storage_path)
          values ($1, $2, 1, $3)
          on conflict (blueprint_document_id, page_number) do nothing
          `,
            [ctx.company.id, row.id, versionFirstPageStoragePath ?? row.storage_path],
          )
        }
        if (copyMeasurements) {
          const sourceMeasurements = await client.query(
            `
          select project_id, page_id, service_item_code, quantity, unit, notes, geometry, division_code, draft_id
          from takeoff_measurements
          where company_id = $1 and blueprint_document_id = $2 and deleted_at is null
          order by created_at asc
          `,
            [ctx.company.id, source.id],
          )
          // Batched copy: build parallel arrays for each column, then a
          // single multi-row INSERT via unnest. Previously this was a
          // for/await loop issuing one INSERT per row (N+1) — at N=1000
          // measurements that's a 1000-round-trip per blueprint version.
          if (sourceMeasurements.rows.length > 0) {
            const projectIds: string[] = []
            const serviceItemCodes: string[] = []
            const quantities: string[] = []
            const units: string[] = []
            const notesArr: string[] = []
            const geometries: string[] = []
            const divisionCodes: Array<string | null> = []
            const pageIds: Array<string | null> = []
            const draftIds: string[] = []
            const copiedPageBySourceId = new Map(copiedPages.rows.map((p) => [p.source_page_id, p.new_page_id]))
            for (const measurement of sourceMeasurements.rows) {
              projectIds.push(measurement.project_id)
              serviceItemCodes.push(measurement.service_item_code)
              quantities.push(String(measurement.quantity))
              units.push(measurement.unit)
              notesArr.push(
                `${measurement.notes ?? ''}${measurement.notes ? ' · ' : ''}copied from blueprint v${source.version}`,
              )
              geometries.push(JSON.stringify(measurement.geometry ?? {}))
              divisionCodes.push(measurement.division_code ?? null)
              pageIds.push(measurement.page_id ? (copiedPageBySourceId.get(measurement.page_id) ?? null) : null)
              // draft_id is NOT NULL on takeoff_measurements; the copied
              // measurement stays in the same draft as its source row.
              draftIds.push(measurement.draft_id)
            }
            await client.query(
              `
            insert into takeoff_measurements (
              company_id, project_id, blueprint_document_id, page_id, service_item_code, quantity, unit, notes, geometry, version, division_code, draft_id
            )
            select
              $1::uuid,
              t.project_id::uuid,
              $2::uuid,
              t.page_id::uuid,
              t.service_item_code,
              t.quantity::numeric,
              t.unit,
              t.notes,
              t.geometry::jsonb,
              1,
              t.division_code,
              t.draft_id::uuid
            from unnest(
              $3::text[], $4::text[], $5::text[], $6::text[],
              $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]
            ) as t(project_id, service_item_code, quantity, unit, notes, geometry, division_code, page_id, draft_id)
            `,
              [
                ctx.company.id,
                row.id,
                projectIds,
                serviceItemCodes,
                quantities,
                units,
                notesArr,
                geometries,
                divisionCodes,
                pageIds,
                draftIds,
              ],
            )
          }
        }
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'blueprint_document',
          entityId: row.id,
          action: 'version',
          row,
          syncPayload: { action: 'version', source_blueprint_id: source.id, blueprint: row },
        })
        return row
      })
    } catch (err) {
      await cleanupGeneratedRaster(ctx, versionFirstPageStoragePath)
      throw err
    }
    ctx.sendJson(201, newBlueprint)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/file$/)) {
    const blueprintId = url.pathname.split('/')[3] ?? ''
    if (!blueprintId) {
      ctx.sendJson(400, { error: 'blueprint id is required' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        'select file_name, storage_path from blueprint_documents where company_id = $1 and id = $2 and deleted_at is null limit 1',
        [ctx.company.id, blueprintId],
      ),
    )
    const blueprint = result.rows[0]
    if (!blueprint) {
      ctx.sendJson(404, { error: 'blueprint not found' })
      return true
    }
    try {
      const storageKey = assertBlueprintFilePath(ctx.company.id, String(blueprint.storage_path))
      const fileName = String(blueprint.file_name)
      // Presigned-URL download is OFF by default (BLUEPRINT_DOWNLOAD_PRESIGNED).
      // When OFF we MUST stream the bytes back through the API so no Spaces
      // URL ever leaves the server — blueprints are untrusted PII blobs and a
      // leaked presigned URL is a credential-free read of customer data
      // (see CLAUDE.md "Blueprint storage hygiene" #3). Only flip it on once
      // Spaces CORS is validated for the web origin; never widen the
      // presigned TTL past the 15-minute Spaces default.
      if (ctx.blueprintDownloadPresigned) {
        const signedUrl = await ctx.storage.getDownloadUrl(storageKey, { fileName })
        if (signedUrl) {
          ctx.sendFileRedirect(signedUrl)
          return true
        }
      }
      const content = await ctx.storage.get(storageKey)
      const mimeType = getBlueprintMimeType(fileName)
      ctx.sendFileContent(mimeType, sanitizeFileName(fileName), content)
    } catch {
      ctx.sendJson(404, { error: 'blueprint file not found' })
    }
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const blueprintId = url.pathname.split('/')[3] ?? ''
    if (!blueprintId) {
      ctx.sendJson(400, { error: 'blueprint id is required' })
      return true
    }
    const parsed = parseJsonBody(BlueprintDeleteBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'blueprint_document',
      entityName: 'blueprint',
      table: 'blueprint_documents',
      id: blueprintId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update blueprint_documents
          set deleted_at = now(), version = version + 1
          where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
          returning id, project_id, file_name, storage_path, version, deleted_at, created_at
          `,
          [ctx.company.id, blueprintId, expectedVersion],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'blueprint_document',
          entityId: blueprintId,
          action: 'delete',
          row,
          syncPayload: { action: 'delete', blueprint: row },
        })
        // Enqueue the Spaces / local-FS object GC alongside the soft-
        // delete. Without this the row goes away but the underlying blob
        // sits in DO Spaces forever and racks up storage spend. The
        // dedicated worker runner (apps/worker/src/runners/blueprint-
        // storage-gc.ts) drains rows of this mutation_type and calls
        // storage.deleteObject(). The idempotency key is keyed by
        // blueprintId so a re-issued DELETE (or a retry) collapses onto
        // the same outbox row via the existing ON CONFLICT path.
        if (row.storage_path) {
          await recordMutationOutbox(
            ctx.company.id,
            'blueprint_document',
            blueprintId,
            'delete_blueprint_storage_object',
            { storage_path: row.storage_path },
            `blueprint_storage_delete:${blueprintId}`,
            'server',
            null,
            client,
          )
        }
        const pageStorage = await client.query<{ storage_path: string }>(
          `
          select distinct storage_path
          from blueprint_pages
          where company_id = $1
            and blueprint_document_id = $2
            and storage_path is not null
            and storage_path <> $3
          `,
          [ctx.company.id, blueprintId, row.storage_path],
        )
        for (const page of pageStorage.rows) {
          await recordMutationOutbox(
            ctx.company.id,
            'blueprint_page',
            blueprintId,
            'delete_blueprint_storage_object',
            { storage_path: page.storage_path },
            `blueprint_page_storage_delete:${blueprintId}:${page.storage_path}`,
            'server',
            null,
            client,
          )
        }
        return row
      },
    })
  }

  return false
}

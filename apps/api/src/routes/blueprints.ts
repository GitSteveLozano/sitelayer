import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertKeyInCompany,
  buildBlueprintStorageKey,
  getBlueprintMimeType,
  StorageError,
  type BlueprintStorage,
} from '../storage.js'
import { isMultipartRequest, parseBlueprintMultipart, type BlueprintMultipartResult } from '../blueprint-upload.js'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { HttpError, parseExpectedVersion } from '../http-utils.js'

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

async function persistBlueprintFile(
  storage: BlueprintStorage,
  companyId: string,
  blueprintId: string,
  fileName: string,
  contentsBase64: string,
): Promise<string> {
  const key = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  const source = contentsBase64.includes(',') ? (contentsBase64.split(',', 2)[1] ?? '') : contentsBase64
  await storage.put(key, Buffer.from(source, 'base64'), getBlueprintMimeType(fileName))
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

async function listBlueprintDocuments(pool: Pool, companyId: string, projectId: string) {
  const result = await pool.query(
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
    const versionResult = await ctx.pool.query<{ version: number }>(
      'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
      [ctx.company.id, projectId],
    )
    const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
    const resolvedFileName = fileName || multipartResult?.fileName || 'blueprint.pdf'
    let resolvedStoragePath = multipartResult
      ? multipartResult.storagePath
      : resolveBlueprintStoragePath(ctx.company.id, blueprintId, resolvedFileName, requestedStoragePath)
    if (!multipartResult && fileContentsBase64) {
      resolvedStoragePath = await persistBlueprintFile(
        ctx.storage,
        ctx.company.id,
        blueprintId,
        resolvedFileName,
        fileContentsBase64,
      )
    }
    const blueprint = await withMutationTx(async (client) => {
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
          body.sheet_scale ?? null,
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
        fileContentsBase64,
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
    const sourceResult = await ctx.pool.query(
      `
      select id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at
      from blueprint_documents
      where company_id = $1 and id = $2 and deleted_at is null
      limit 1
      `,
      [ctx.company.id, sourceBlueprintId],
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
    const versionResult = await ctx.pool.query<{ version: number }>(
      'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
      [ctx.company.id, source.project_id],
    )
    const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
    const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
    let storagePath = multipartResult
      ? multipartResult.storagePath
      : requestedStoragePath
        ? resolveBlueprintStoragePath(ctx.company.id, blueprintId, fileName, requestedStoragePath)
        : ''
    if (!multipartResult && fileContentsBase64) {
      storagePath = await persistBlueprintFile(ctx.storage, ctx.company.id, blueprintId, fileName, fileContentsBase64)
    } else if (!multipartResult && source.storage_path) {
      try {
        storagePath = await copyBlueprintFile(ctx.storage, ctx.company.id, blueprintId, source.storage_path, fileName)
      } catch {
        storagePath = getBlueprintFilePath(ctx.company.id, blueprintId, fileName)
      }
    } else if (!storagePath) {
      storagePath = getBlueprintFilePath(ctx.company.id, blueprintId, fileName)
    }
    const newBlueprint = await withMutationTx(async (client) => {
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
      if (copyMeasurements) {
        const sourceMeasurements = await client.query(
          `
          select project_id, service_item_code, quantity, unit, notes, geometry, division_code
          from takeoff_measurements
          where company_id = $1 and blueprint_document_id = $2 and deleted_at is null
          order by created_at asc
          `,
          [ctx.company.id, source.id],
        )
        for (const measurement of sourceMeasurements.rows) {
          await client.query(
            `
            insert into takeoff_measurements (
              company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, division_code
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9)
            `,
            [
              ctx.company.id,
              measurement.project_id,
              row.id,
              measurement.service_item_code,
              measurement.quantity,
              measurement.unit,
              `${measurement.notes ?? ''}${measurement.notes ? ' · ' : ''}copied from blueprint v${source.version}`,
              JSON.stringify(measurement.geometry ?? {}),
              measurement.division_code ?? null,
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
    ctx.sendJson(201, newBlueprint)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/file$/)) {
    const blueprintId = url.pathname.split('/')[3] ?? ''
    if (!blueprintId) {
      ctx.sendJson(400, { error: 'blueprint id is required' })
      return true
    }
    const result = await ctx.pool.query(
      'select file_name, storage_path from blueprint_documents where company_id = $1 and id = $2 and deleted_at is null limit 1',
      [ctx.company.id, blueprintId],
    )
    const blueprint = result.rows[0]
    if (!blueprint) {
      ctx.sendJson(404, { error: 'blueprint not found' })
      return true
    }
    try {
      const storageKey = assertBlueprintFilePath(ctx.company.id, String(blueprint.storage_path))
      const fileName = String(blueprint.file_name)
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
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client) => {
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
      return row
    })
    if (!deleted) {
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
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

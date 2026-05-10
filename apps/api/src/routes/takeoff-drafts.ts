import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid, parseExpectedVersion } from '../http-utils.js'

export type TakeoffDraftRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  currentUserId?: string | null
}

const ALLOWED_STATUS = new Set(['active', 'archived'])
const RETURNING_COLUMNS = `id, company_id, project_id, name, type, status, version, deleted_at, created_at, updated_at`

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
    const result = await ctx.pool.query(
      `select ${RETURNING_COLUMNS}
         from takeoff_drafts
        where ${where}
        order by case when status = 'active' then 0 else 1 end, created_at asc`,
      [ctx.company.id, projectId],
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
    const projectCheck = await ctx.pool.query(
      `select id from projects
         where company_id = $1 and id = $2 and deleted_at is null`,
      [ctx.company.id, projectId],
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
            company_id, project_id, blueprint_document_id, service_item_code,
            quantity, unit, notes, geometry, version, division_code,
            elevation, image_thumbnail, draft_id
          )
          select company_id, project_id, blueprint_document_id, service_item_code,
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

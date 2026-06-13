import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseJsonBody } from '../http-utils.js'
import { resolveDefaultDraftId, validateDraftId } from './takeoff-drafts.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

// POST /api/projects/:id/takeoff/import wire-format. The endpoint accepts
// JSON-shaped rows (the client parses CSV in the browser). Only the
// top-level shape is typed here — each row object is validated/coerced
// per-field in the loop below (service_item_code required, quantity finite
// >= 0, etc.), so the items stay loose objects. The schema rejects e.g.
// `rows: "x"` (non-array) up front without tightening the row contract.
const StringOrNullSchema = z.union([z.string(), z.null()])

const TakeoffImportBodySchema = z
  .object({
    rows: z.array(z.object({}).loose()).optional(),
    source_label: StringOrNullSchema.optional(),
    page_id: StringOrNullSchema.optional(),
    draft_id: StringOrNullSchema.optional(),
  })
  .loose()

export type TakeoffImportRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

interface ImportRow {
  service_item_code: string
  quantity: number
  unit?: string
  rate?: number
  notes?: string
}

/**
 * External takeoff CSV import (Phase 3G).
 *
 * The integration play from the brief: Bluebeam / PlanSwift / OST users
 * keep their existing takeoff workflow; export to CSV; drop the file
 * into Sitelayer; structured measurements populate.
 *
 * The endpoint accepts JSON-shaped rows (the client parses CSV in the
 * browser before posting). This keeps the server stateless about CSV
 * dialects, encoding, and column mapping — UX rule from the brief:
 * "column mapping is unsexy but reliable."
 *
 *   POST /api/projects/:id/takeoff/import
 *     body: { rows: [{service_item_code, quantity, unit?, rate?, notes?}], page_id?, source_label? }
 *
 * Each row creates a takeoff_measurement with geometry_kind='count' (no
 * geometry — the row asserts an aggregate quantity) and a single tag
 * mirroring the row's service_item_code + quantity. Imported rows
 * are flagged via notes prefix "[imported:<source_label>]" so the UI
 * can distinguish them from drawn measurements.
 */
export async function handleTakeoffImportRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TakeoffImportRouteCtx,
): Promise<boolean> {
  const importMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takeoff\/import$/)
  if (req.method !== 'POST' || !importMatch) return false
  if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true

  const projectId = importMatch[1]!
  if (!isValidUuid(projectId)) {
    ctx.sendJson(400, { error: 'project id must be a valid uuid' })
    return true
  }

  const parsed = parseJsonBody(TakeoffImportBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return true
  }
  const body = parsed.value
  const rawRows = body.rows
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    ctx.sendJson(400, { error: 'rows[] is required and must be non-empty' })
    return true
  }
  if (rawRows.length > 1000) {
    ctx.sendJson(413, { error: 'imports capped at 1000 rows per request' })
    return true
  }
  const sourceLabel = typeof body.source_label === 'string' ? body.source_label.slice(0, 80) : 'csv'
  const pageId = typeof body.page_id === 'string' && body.page_id.trim() ? body.page_id.trim() : null
  if (pageId && !isValidUuid(pageId)) {
    ctx.sendJson(400, { error: 'page_id must be a valid uuid when supplied' })
    return true
  }
  let blueprintDocumentId: string | null = null

  const rows: ImportRow[] = []
  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i] as Record<string, unknown>
    const code = typeof r.service_item_code === 'string' ? r.service_item_code.trim() : ''
    const qty = Number(r.quantity)
    if (!code) {
      ctx.sendJson(400, { error: `rows[${i}].service_item_code is required` })
      return true
    }
    if (!Number.isFinite(qty) || qty < 0) {
      ctx.sendJson(400, { error: `rows[${i}].quantity must be a number >= 0` })
      return true
    }
    const unit = typeof r.unit === 'string' && r.unit.trim() ? r.unit.trim() : 'sqft'
    const rate = r.rate === undefined ? 0 : Number(r.rate)
    const notes = typeof r.notes === 'string' ? r.notes.slice(0, 1024) : ''
    rows.push({ service_item_code: code, quantity: qty, unit, rate: Number.isFinite(rate) ? rate : 0, notes })
  }

  // Project ownership check.
  const projectCheck = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ exists: boolean }>(
      `select exists(select 1 from projects where company_id = $1 and id = $2 and deleted_at is null) as exists`,
      [ctx.company.id, projectId],
    ),
  )
  if (!projectCheck.rows[0]?.exists) {
    ctx.sendJson(404, { error: 'project not found' })
    return true
  }

  // Resolve the target draft. `takeoff_measurements.draft_id` is NOT NULL
  // (migration #270), so imported rows must land in a draft just like drawn /
  // promoted measurements do. Explicit body.draft_id wins (validated against
  // project tenancy); otherwise fall back to the project's active default
  // draft. Mirrors the resolution in takeoff-write.ts.
  const explicitDraftId =
    typeof body.draft_id === 'string' && body.draft_id.trim().length > 0 ? body.draft_id.trim() : null
  let draftId: string | null
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

  // Page ownership check — without this, a caller could associate
  // imported measurements with a blueprint page from another company.
  if (pageId) {
    const pageCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ blueprint_document_id: string }>(
        `select p.blueprint_document_id
           from blueprint_pages p
           join blueprint_documents d on d.company_id = p.company_id and d.id = p.blueprint_document_id
          where p.company_id = $1
            and p.id = $2
            and d.project_id = $3
            and d.deleted_at is null
          limit 1`,
        [ctx.company.id, pageId, projectId],
      ),
    )
    blueprintDocumentId = pageCheck.rows[0]?.blueprint_document_id ?? null
    if (!blueprintDocumentId) {
      ctx.sendJson(404, { error: 'page not found' })
      return true
    }
  }

  const result = await withMutationTx(async (client: PoolClient) => {
    const created: { measurement_id: string; tag_id: string }[] = []
    for (const row of rows) {
      const importedNote = `[imported:${sourceLabel}]${row.notes ? ' ' + row.notes : ''}`
      // takeoff_measurements doesn't carry a rate — that lives on the
      // tag (Phase 3A). The single-scope columns here mirror the
      // tag's service_item_code / quantity / unit so v1 readers still
      // see the row sensibly.
      const measurement = await client.query<{ id: string }>(
        `insert into takeoff_measurements (
           company_id, project_id, blueprint_document_id, page_id, service_item_code, geometry_kind,
           geometry, quantity, unit, notes, draft_id
         )
         values ($1, $2, $3, $4, $5, 'count', '{}'::jsonb, $6, $7, $8, $9)
         returning id`,
        [
          ctx.company.id,
          projectId,
          blueprintDocumentId,
          pageId,
          row.service_item_code,
          row.quantity,
          row.unit,
          importedNote,
          draftId,
        ],
      )
      const measurementRow = measurement.rows[0]
      if (!measurementRow) throw new HttpError(500, 'takeoff measurement insert returned no row')
      const measurementId = measurementRow.id
      const tag = await client.query<{ id: string }>(
        `insert into takeoff_measurement_tags
           (company_id, measurement_id, service_item_code, quantity, unit, rate, sort_order)
         values ($1, $2, $3, $4, $5, $6, 0)
         returning id`,
        [ctx.company.id, measurementId, row.service_item_code, row.quantity, row.unit, row.rate ?? 0],
      )
      const tagRow = tag.rows[0]
      if (!tagRow) throw new HttpError(500, 'takeoff measurement tag insert returned no row')
      created.push({ measurement_id: measurementId, tag_id: tagRow.id })
    }
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'takeoff_import',
      entityId: projectId,
      action: 'import',
      actorUserId: ctx.currentUserId,
      row: { project_id: projectId, source_label: sourceLabel, count: created.length },
    })
    return created
  })

  ctx.sendJson(201, { imported: result.length, measurements: result, source_label: sourceLabel })
  return true
}

/**
 * Self-registered dispatch descriptor for the `takeoff-import` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const takeoffImportRouteDescriptor: DispatchRouteDescriptor = {
  name: 'takeoff-import',
  order: 380,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
    handleTakeoffImportRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
    }),
}

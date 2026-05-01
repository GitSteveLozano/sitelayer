import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'

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

  const body = await ctx.readBody()
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
  const projectCheck = await ctx.pool.query<{ exists: boolean }>(
    `select exists(select 1 from projects where company_id = $1 and id = $2 and deleted_at is null) as exists`,
    [ctx.company.id, projectId],
  )
  if (!projectCheck.rows[0]?.exists) {
    ctx.sendJson(404, { error: 'project not found' })
    return true
  }

  const result = await withMutationTx(async (client: PoolClient) => {
    const created: { measurement_id: string; tag_id: string }[] = []
    for (const row of rows) {
      const importedNote = `[imported:${sourceLabel}]${row.notes ? ' ' + row.notes : ''}`
      const measurement = await client.query<{ id: string }>(
        `insert into takeoff_measurements (
           company_id, project_id, page_id, service_item_code, geometry_kind,
           geometry, quantity, unit, rate, notes
         )
         values ($1, $2, $3, $4, 'count', '{}'::jsonb, $5, $6, $7, $8)
         returning id`,
        [ctx.company.id, projectId, pageId, row.service_item_code, row.quantity, row.unit, row.rate ?? 0, importedNote],
      )
      const measurementId = measurement.rows[0]!.id
      const tag = await client.query<{ id: string }>(
        `insert into takeoff_measurement_tags
           (company_id, measurement_id, service_item_code, quantity, unit, rate, sort_order)
         values ($1, $2, $3, $4, $5, $6, 0)
         returning id`,
        [ctx.company.id, measurementId, row.service_item_code, row.quantity, row.unit, row.rate ?? 0],
      )
      created.push({ measurement_id: measurementId, tag_id: tag.rows[0]!.id })
    }
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'takeoff_import',
      entityId: projectId,
      action: 'import',
      actorUserId: ctx.currentUserId,
      row: { project_id: projectId, source_label: sourceLabel, count: created.length } as Record<string, unknown>,
    })
    return created
  })

  ctx.sendJson(201, { imported: result.length, measurements: result, source_label: sourceLabel })
  return true
}

import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { isValidUuid } from '../http-utils.js'

export type QboCustomFieldRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const FIELD_COLUMNS = `id, company_id, entity_type, field_name, qbo_definition_id, qbo_label, notes, origin, created_at, updated_at`

const ALLOWED_ENTITIES = new Set(['Estimate', 'Invoice', 'Bill', 'PurchaseOrder'])

interface FieldRow {
  id: string
  company_id: string
  entity_type: string
  field_name: string
  qbo_definition_id: string
  qbo_label: string | null
  notes: string | null
  origin: string | null
  created_at: string
  updated_at: string
}

/**
 * QBO custom-field mapping CRUD (Phase 3H).
 *
 *   GET    /api/qbo/custom-fields                 list mappings
 *   PUT    /api/qbo/custom-fields                 upsert one mapping
 *   DELETE /api/qbo/custom-fields/:id             remove
 *
 * The worker's QBO push handlers (rental invoice / estimate push)
 * read these rows to know which custom field id to populate with the
 * sqft total. Without a mapping the worker silently skips the custom
 * field write — the design rule from the brief: "tolerates a missing
 * mapping (skips the field write rather than failing the push)".
 */
export async function handleQboCustomFieldRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: QboCustomFieldRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/qbo/custom-fields') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const result = await ctx.pool.query<FieldRow>(
      `select ${FIELD_COLUMNS}
       from qbo_custom_field_mappings
       where company_id = $1
       order by entity_type asc, field_name asc`,
      [ctx.company.id],
    )
    ctx.sendJson(200, { mappings: result.rows })
    return true
  }

  if (req.method === 'PUT' && url.pathname === '/api/qbo/custom-fields') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const entityType = typeof body.entity_type === 'string' ? body.entity_type.trim() : ''
    const fieldName = typeof body.field_name === 'string' ? body.field_name.trim() : ''
    const definitionId = typeof body.qbo_definition_id === 'string' ? body.qbo_definition_id.trim() : ''
    const label = typeof body.qbo_label === 'string' ? body.qbo_label.slice(0, 200) : null
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null

    if (!ALLOWED_ENTITIES.has(entityType)) {
      ctx.sendJson(400, { error: 'entity_type must be Estimate|Invoice|Bill|PurchaseOrder' })
      return true
    }
    if (!fieldName) {
      ctx.sendJson(400, { error: 'field_name is required' })
      return true
    }
    if (!definitionId) {
      ctx.sendJson(400, { error: 'qbo_definition_id is required' })
      return true
    }

    const result = await ctx.pool.query<FieldRow>(
      `insert into qbo_custom_field_mappings
         (company_id, entity_type, field_name, qbo_definition_id, qbo_label, notes)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (company_id, entity_type, field_name) do update
         set qbo_definition_id = excluded.qbo_definition_id,
             qbo_label = excluded.qbo_label,
             notes = excluded.notes,
             updated_at = now()
       returning ${FIELD_COLUMNS}`,
      [ctx.company.id, entityType, fieldName, definitionId, label, notes],
    )
    ctx.sendJson(200, { mapping: result.rows[0] })
    return true
  }

  const deleteMatch = url.pathname.match(/^\/api\/qbo\/custom-fields\/([^/]+)$/)
  if (req.method === 'DELETE' && deleteMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = deleteMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await ctx.pool.query(
      `delete from qbo_custom_field_mappings where company_id = $1 and id = $2 returning id`,
      [ctx.company.id, id],
    )
    if (result.rowCount === 0) {
      ctx.sendJson(404, { error: 'mapping not found' })
      return true
    }
    ctx.sendJson(200, { ok: true })
    return true
  }

  return false
}

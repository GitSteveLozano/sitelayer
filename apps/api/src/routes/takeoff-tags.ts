import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'

export type TakeoffTagRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const TAG_COLUMNS = `id, company_id, measurement_id, service_item_code, quantity, unit, rate, notes, sort_order, origin, created_at, updated_at`

interface TagRow {
  id: string
  company_id: string
  measurement_id: string
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  notes: string | null
  sort_order: number
  origin: string | null
  created_at: string
  updated_at: string
}

/**
 * Multi-condition takeoff tags (Phase 3A).
 *
 * Endpoints:
 *   GET  /api/takeoff/measurements/:id/tags
 *   POST /api/takeoff/measurements/:id/tags
 *   PATCH /api/takeoff/tags/:tagId
 *   DELETE /api/takeoff/tags/:tagId
 *
 * The 1:N relationship lets one polygon (e.g. an EIFS wall) carry
 * EPS + basecoat + finish coat + air barrier as separate billable
 * lines, each with its own quantity / unit / rate. The legacy
 * single-scope columns on takeoff_measurements remain in place so
 * v1 readers don't break — a follow-on phase removes them once
 * both clients write tags exclusively.
 */
export async function handleTakeoffTagRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TakeoffTagRouteCtx,
): Promise<boolean> {
  const tagsForMeasurementMatch = url.pathname.match(/^\/api\/takeoff\/measurements\/([^/]+)\/tags$/)

  if (req.method === 'GET' && tagsForMeasurementMatch) {
    const measurementId = tagsForMeasurementMatch[1]!
    if (!isValidUuid(measurementId)) {
      ctx.sendJson(400, { error: 'measurement id must be a valid uuid' })
      return true
    }
    // Confirm the measurement belongs to this company before exposing
    // tags. Defense in depth — the WHERE on the tags query also has
    // company_id but a 404 here is clearer than an empty list.
    const owner = await ctx.pool.query<{ exists: boolean }>(
      `select exists(select 1 from takeoff_measurements where company_id = $1 and id = $2) as exists`,
      [ctx.company.id, measurementId],
    )
    if (!owner.rows[0]?.exists) {
      ctx.sendJson(404, { error: 'measurement not found' })
      return true
    }
    const result = await ctx.pool.query<TagRow>(
      `select ${TAG_COLUMNS}
       from takeoff_measurement_tags
       where company_id = $1 and measurement_id = $2
       order by sort_order asc, created_at asc`,
      [ctx.company.id, measurementId],
    )
    ctx.sendJson(200, { tags: result.rows })
    return true
  }

  if (req.method === 'POST' && tagsForMeasurementMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const measurementId = tagsForMeasurementMatch[1]!
    if (!isValidUuid(measurementId)) {
      ctx.sendJson(400, { error: 'measurement id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const code = typeof body.service_item_code === 'string' ? body.service_item_code.trim() : ''
    if (!code) {
      ctx.sendJson(400, { error: 'service_item_code is required' })
      return true
    }
    const quantity = body.quantity === undefined ? 0 : Number(body.quantity)
    const rate = body.rate === undefined ? 0 : Number(body.rate)
    if (!Number.isFinite(quantity) || quantity < 0) {
      ctx.sendJson(400, { error: 'quantity must be >= 0' })
      return true
    }
    if (!Number.isFinite(rate) || rate < 0) {
      ctx.sendJson(400, { error: 'rate must be >= 0' })
      return true
    }
    const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : 'sqft'
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null

    const ownership = await ctx.pool.query<{ exists: boolean }>(
      `select exists(select 1 from takeoff_measurements where company_id = $1 and id = $2) as exists`,
      [ctx.company.id, measurementId],
    )
    if (!ownership.rows[0]?.exists) {
      ctx.sendJson(404, { error: 'measurement not found' })
      return true
    }

    // sort_order = max + 1 so new tags append. Lock the parent
    // measurement row so two concurrent appends don't observe the same
    // max(sort_order) and assign duplicate values. (Default isolation
    // is READ COMMITTED — without the lock, both txns can see the
    // pre-write max.)
    const created = await withMutationTx(async (client: PoolClient) => {
      await client.query(
        `select 1 from takeoff_measurements
         where company_id = $1 and id = $2 for update`,
        [ctx.company.id, measurementId],
      )
      const max = await client.query<{ max_sort: number | null }>(
        `select coalesce(max(sort_order), -1) as max_sort
         from takeoff_measurement_tags where company_id = $1 and measurement_id = $2`,
        [ctx.company.id, measurementId],
      )
      const nextSort = (max.rows[0]?.max_sort ?? -1) + 1
      const inserted = await client.query<TagRow>(
        `insert into takeoff_measurement_tags
           (company_id, measurement_id, service_item_code, quantity, unit, rate, notes, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${TAG_COLUMNS}`,
        [ctx.company.id, measurementId, code, quantity, unit, rate, notes, nextSort],
      )
      const row = inserted.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_measurement_tag',
        entityId: row.id,
        action: 'create',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    ctx.sendJson(201, { tag: created })
    return true
  }

  const tagDirectMatch = url.pathname.match(/^\/api\/takeoff\/tags\/([^/]+)$/)
  if (req.method === 'PATCH' && tagDirectMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const tagId = tagDirectMatch[1]!
    if (!isValidUuid(tagId)) {
      ctx.sendJson(400, { error: 'tag id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const sets: string[] = []
    const params: unknown[] = [ctx.company.id, tagId]
    const push = (col: string, raw: unknown, transform?: (v: unknown) => unknown) => {
      params.push(transform ? transform(raw) : raw)
      sets.push(`${col} = $${params.length}`)
    }
    if (typeof body.service_item_code === 'string' && body.service_item_code.trim()) {
      push('service_item_code', body.service_item_code.trim())
    }
    if (body.quantity !== undefined) {
      const q = Number(body.quantity)
      if (!Number.isFinite(q) || q < 0) {
        ctx.sendJson(400, { error: 'quantity must be >= 0' })
        return true
      }
      push('quantity', q)
    }
    if (body.rate !== undefined) {
      const r = Number(body.rate)
      if (!Number.isFinite(r) || r < 0) {
        ctx.sendJson(400, { error: 'rate must be >= 0' })
        return true
      }
      push('rate', r)
    }
    if (typeof body.unit === 'string') push('unit', body.unit.trim() || 'sqft')
    if (body.notes !== undefined)
      push('notes', typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null)
    if (typeof body.sort_order === 'number') push('sort_order', body.sort_order)

    if (sets.length === 0) {
      ctx.sendJson(400, { error: 'no editable fields supplied' })
      return true
    }

    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<TagRow>(
        `update takeoff_measurement_tags
           set ${sets.join(', ')}, updated_at = now()
         where company_id = $1 and id = $2
         returning ${TAG_COLUMNS}`,
        params,
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_measurement_tag',
        entityId: row.id,
        action: 'update',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'tag not found' })
      return true
    }
    ctx.sendJson(200, { tag: updated })
    return true
  }

  if (req.method === 'DELETE' && tagDirectMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const tagId = tagDirectMatch[1]!
    if (!isValidUuid(tagId)) {
      ctx.sendJson(400, { error: 'tag id must be a valid uuid' })
      return true
    }
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<TagRow>(
        `delete from takeoff_measurement_tags
         where company_id = $1 and id = $2
         returning ${TAG_COLUMNS}`,
        [ctx.company.id, tagId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_measurement_tag',
        entityId: row.id,
        action: 'delete',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'tag not found' })
      return true
    }
    ctx.sendJson(200, { tag: deleted })
    return true
  }

  return false
}

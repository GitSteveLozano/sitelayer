import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

export type InventoryRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

const ITEM_COLUMNS = `id, company_id, part_number, name, description, category, unit,
  rate_25day, rate_daily, rate_weekly, replacement_cost, total_stock,
  is_active, metadata, version, created_at, updated_at`

export async function handleInventoryRoutes(req: http.IncomingMessage, url: URL, ctx: InventoryRouteCtx): Promise<boolean> {
  // GET /api/inventory
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const category = url.searchParams.get('category')
    const withAvailability = url.searchParams.get('availability') === '1'

    if (withAvailability) {
      const result = await ctx.pool.query(
        `SELECT * FROM get_inventory_availability($1)`,
        [ctx.company.id],
      )
      ctx.sendJson(200, { items: result.rows })
      return true
    }

    const values: unknown[] = [ctx.company.id]
    let where = 'company_id = $1 AND deleted_at IS NULL AND is_active = true'
    if (category) {
      values.push(category)
      where += ` AND category = $${values.length}`
    }
    const result = await ctx.pool.query(
      `SELECT ${ITEM_COLUMNS} FROM inventory_items WHERE ${where} ORDER BY part_number`,
      values,
    )
    ctx.sendJson(200, { items: result.rows })
    return true
  }

  // POST /api/inventory
  if (req.method === 'POST' && url.pathname === '/api/inventory') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const { part_number, name, description, category, unit, rate_25day, rate_daily, rate_weekly, replacement_cost, total_stock } = body as Record<string, unknown>

    if (!part_number || !name) {
      ctx.sendJson(400, { error: 'part_number and name are required' })
      return true
    }

    const item = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `INSERT INTO inventory_items (company_id, part_number, name, description, category, unit,
          rate_25day, rate_daily, rate_weekly, replacement_cost, total_stock)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING ${ITEM_COLUMNS}`,
        [
          ctx.company.id, part_number, name, description || null, category || null, unit || 'ea',
          Number(rate_25day) || 0, Number(rate_daily) || 0, Number(rate_weekly) || 0,
          Number(replacement_cost) || 0, Number(total_stock) || 0,
        ],
      )
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_item',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, item)
    return true
  }

  // POST /api/inventory/import
  if (req.method === 'POST' && url.pathname === '/api/inventory/import') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const { items } = body as { items: Array<Record<string, unknown>> }

    if (!Array.isArray(items) || items.length === 0) {
      ctx.sendJson(400, { error: 'items array is required' })
      return true
    }
    if (items.length > 1000) {
      ctx.sendJson(400, { error: 'Maximum 1000 items per import' })
      return true
    }

    const imported = await withMutationTx(async (client: PoolClient) => {
      const results: unknown[] = []
      for (const item of items) {
        const result = await client.query(
          `INSERT INTO inventory_items (company_id, part_number, name, description, category, unit,
            rate_25day, rate_daily, rate_weekly, replacement_cost, total_stock)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (company_id, part_number) DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category,
            rate_25day = EXCLUDED.rate_25day, rate_daily = EXCLUDED.rate_daily, rate_weekly = EXCLUDED.rate_weekly,
            replacement_cost = EXCLUDED.replacement_cost, total_stock = EXCLUDED.total_stock,
            updated_at = now(), version = inventory_items.version + 1
          RETURNING id`,
          [
            ctx.company.id, item.part_number, item.name, item.description || null,
            item.category || null, item.unit || 'ea',
            Number(item.rate_25day) || 0, Number(item.rate_daily) || 0, Number(item.rate_weekly) || 0,
            Number(item.replacement_cost) || 0, Number(item.total_stock) || 0,
          ],
        )
        results.push(result.rows[0])
      }
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_item',
        entityId: 'batch-import',
        action: 'create',
        row: { count: results.length },
      })
      return results
    })
    ctx.sendJson(201, { imported: (imported as unknown[]).length })
    return true
  }

  // PATCH /api/inventory/:id
  const patchMatch = url.pathname.match(/^\/api\/inventory\/([0-9a-f-]{36})$/)
  if (req.method === 'PATCH' && patchMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = patchMatch[1]
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body)

    if (expectedVersion !== null) {
      const versionOk = await ctx.checkVersion('inventory_items', 'id = $1 AND company_id = $2', [id, ctx.company.id], expectedVersion)
      if (!versionOk) return true
    }

    const fields: string[] = []
    const values: unknown[] = []
    let idx = 1

    for (const key of ['name', 'description', 'category', 'unit', 'rate_25day', 'rate_daily', 'rate_weekly', 'replacement_cost', 'total_stock', 'is_active'] as const) {
      if (key in body) {
        fields.push(`${key} = $${idx}`)
        values.push(body[key])
        idx++
      }
    }

    if (fields.length === 0) {
      ctx.sendJson(400, { error: 'No fields to update' })
      return true
    }

    fields.push(`version = version + 1`, `updated_at = now()`)
    values.push(id, ctx.company.id)

    const result = await ctx.pool.query(
      `UPDATE inventory_items SET ${fields.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} AND deleted_at IS NULL RETURNING ${ITEM_COLUMNS}`,
      values,
    )

    if (result.rows.length === 0) {
      ctx.sendJson(404, { error: 'Item not found' })
      return true
    }
    ctx.sendJson(200, result.rows[0])
    return true
  }

  // DELETE /api/inventory/:id
  const deleteMatch = url.pathname.match(/^\/api\/inventory\/([0-9a-f-]{36})$/)
  if (req.method === 'DELETE' && deleteMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = deleteMatch[1]

    const result = await ctx.pool.query(
      `UPDATE inventory_items SET deleted_at = now(), version = version + 1
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, ctx.company.id],
    )

    if (result.rows.length === 0) {
      ctx.sendJson(404, { error: 'Item not found' })
      return true
    }
    ctx.sendJson(200, { deleted: true })
    return true
  }

  return false
}

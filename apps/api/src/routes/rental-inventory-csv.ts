import type http from 'node:http'
import type { PoolClient } from 'pg'
import { withMutationTx } from '../mutation-tx.js'
import {
  TRACKING_MODES,
  normalizeEnum,
  optionalString,
  parseNonNegativeNumber,
  type RentalInventoryRouteCtx,
} from './rental-inventory.types.js'

const INVENTORY_IMPORT_LIMIT = 1000

/**
 * Handle the inventory CSV import surface.
 *
 * `POST /api/inventory/items/import` — bulk upsert by code. Accepts up to
 * INVENTORY_IMPORT_LIMIT rows in one request; each row is upserted on
 * `(company_id, code)`. Used by the CSV import dialog in the inventory
 * catalog UI. Returns counts so the UI can summarize the run.
 */
export async function handleRentalInventoryCsvRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/inventory/items/import') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : null
    if (!items) {
      ctx.sendJson(400, { error: 'items must be an array' })
      return true
    }
    if (items.length === 0) {
      ctx.sendJson(400, { error: 'items must not be empty' })
      return true
    }
    if (items.length > INVENTORY_IMPORT_LIMIT) {
      ctx.sendJson(400, { error: `items length must be <= ${INVENTORY_IMPORT_LIMIT}` })
      return true
    }
    const result = await withMutationTx(async (client: PoolClient) => {
      let inserted = 0
      let updated = 0
      const errors: Array<{ index: number; code: string | null; error: string }> = []
      for (let i = 0; i < items.length; i += 1) {
        const row = items[i]!
        const code = String(row.code ?? '').trim()
        const description = String(row.description ?? '').trim()
        if (!code || !description) {
          errors.push({ index: i, code: code || null, error: 'code and description are required' })
          continue
        }
        const defaultRentalRate = parseNonNegativeNumber(row.default_rental_rate, 0)
        const replacementValue =
          row.replacement_value === undefined || row.replacement_value === null || row.replacement_value === ''
            ? null
            : parseNonNegativeNumber(row.replacement_value, 0)
        if (!Number.isFinite(defaultRentalRate) || (replacementValue !== null && !Number.isFinite(replacementValue))) {
          errors.push({ index: i, code, error: 'rates must be non-negative numbers' })
          continue
        }
        const upsert = await client.query<{ id: string; xmax: string }>(
          `
          insert into inventory_items (
            company_id, code, description, category, unit, default_rental_rate,
            replacement_value, tracking_mode, active, notes
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, true), $10)
          on conflict (company_id, code) do update set
            description = excluded.description,
            category = excluded.category,
            unit = excluded.unit,
            default_rental_rate = excluded.default_rental_rate,
            replacement_value = excluded.replacement_value,
            tracking_mode = excluded.tracking_mode,
            notes = excluded.notes,
            active = excluded.active,
            deleted_at = null,
            version = inventory_items.version + 1,
            updated_at = now()
          returning id, xmax::text
          `,
          [
            ctx.company.id,
            code,
            description,
            optionalString(row.category) ?? 'scaffold',
            optionalString(row.unit) ?? 'ea',
            defaultRentalRate,
            replacementValue,
            normalizeEnum(row.tracking_mode, TRACKING_MODES, 'quantity'),
            row.active ?? true,
            optionalString(row.notes),
          ],
        )
        const upserted = upsert.rows[0]!
        // xmax='0' on a fresh insert; non-zero on UPDATE conflict path.
        if (upserted.xmax === '0') inserted += 1
        else updated += 1
      }
      return { inserted, updated, errors }
    })
    ctx.sendJson(200, { ...result, total: items.length })
    return true
  }

  return false
}

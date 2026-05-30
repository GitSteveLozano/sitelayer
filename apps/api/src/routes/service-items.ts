import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'

// POST /api/service-items — code + name required (matches the existing
// 400). default_rate is numeric (DB column is numeric); accept
// string-or-number to match the historical loose binding without
// silently coercing arbitrary garbage to NaN.
const ServiceItemCreateBodySchema = z
  .object({
    code: z.string().optional(),
    name: z.string().optional(),
    category: z.string().optional(),
    unit: z.string().optional(),
    default_rate: z.union([z.number(), z.string()]).nullish(),
    source: z.string().optional(),
  })
  .loose()

const ServiceItemPatchBodySchema = z
  .object({
    name: z.string().nullish(),
    category: z.string().nullish(),
    unit: z.string().nullish(),
    default_rate: z.union([z.number(), z.string()]).nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

export type ServiceItemRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/service-items mutations. service_items rows are
 * code-keyed (not uuid-keyed); the path segment after `/service-items/`
 * is the code. There's no GET — the list is delivered via /api/bootstrap.
 */
export async function handleServiceItemRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ServiceItemRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/service-items') {
    // `divisions` is the curated service_item_divisions cross-reference for
    // each item. The takeoff canvas needs it so it can save a measurement with
    // the item's own division_code (e.g. "Air Barrier" → D5) instead of falling
    // back to the project division and tripping the 422 catalog guard.
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select si.code, si.name, si.category, si.unit, si.default_rate, si.source, si.version,
                coalesce(
                  array_agg(sid.division_code order by sid.division_code)
                    filter (where sid.division_code is not null),
                  '{}'
                ) as divisions
       from service_items si
       left join service_item_divisions sid
         on sid.company_id = si.company_id and sid.service_item_code = si.code
       where si.company_id = $1 and si.deleted_at is null
       group by si.code, si.name, si.category, si.unit, si.default_rate, si.source, si.version
       order by si.name asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { serviceItems: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/service-items') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(ServiceItemCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const code = (body.code ?? '').trim()
    const name = (body.name ?? '').trim()
    const category = (body.category ?? 'labor').trim()
    const unit = (body.unit ?? 'hr').trim()
    if (!code || !name) {
      ctx.sendJson(400, { error: 'code and name are required' })
      return true
    }
    // service_items_company_id_code_key is a plain UNIQUE (company_id,
    // code) — it does NOT exclude soft-deleted rows, so a soft-deleted
    // row still occupies the code's slot. A naive INSERT therefore throws
    // 23505 (→ 500) for both a live duplicate and a recreate-after-delete.
    // ON CONFLICT DO UPDATE … WHERE deleted_at IS NOT NULL restores the
    // soft-deleted row in place (clearing deleted_at, resetting fields,
    // bumping version monotonically); an INSERT returns the new row. A live
    // (not-deleted) duplicate matches the conflict target but fails the
    // WHERE predicate, so nothing is returned → 409 instead of 500.
    const result = await withMutationTx(async (client: PoolClient) => {
      const inserted = await client.query(
        `
        insert into service_items (company_id, code, name, category, unit, default_rate, source, version, created_at)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, 'manual'), 1, now())
        on conflict (company_id, code) do update set
          name = excluded.name,
          category = excluded.category,
          unit = excluded.unit,
          default_rate = excluded.default_rate,
          source = excluded.source,
          deleted_at = null,
          version = service_items.version + 1,
          updated_at = now()
        where service_items.deleted_at is not null
        returning code, name, category, unit, default_rate, source, version, created_at, (xmax = 0) as inserted
        `,
        [ctx.company.id, code, name, category, unit, body.default_rate ?? null, body.source ?? 'manual'],
      )
      const row = inserted.rows[0]
      // No row → the conflict target was a live (not soft-deleted) row, so
      // the WHERE predicate suppressed the UPDATE: this code already exists.
      if (!row) return { kind: 'conflict' as const }
      // xmax = 0 on a freshly INSERTed row; non-zero when the row was
      // updated (restored) via the DO UPDATE path.
      const wasInsert = (row as { inserted?: boolean }).inserted === true
      const { inserted: _inserted, ...item } = row as Record<string, unknown>
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item',
        entityId: code,
        action: wasInsert ? 'create' : 'restore',
        row: item,
      })
      // Auto-curate the new item against every division this company has so it
      // is immediately measurable on any project (the takeoff catalog guard in
      // takeoff-write.ts rejects items with no service_item_divisions row).
      // Idempotent; admins can prune the cross-reference afterwards. Mirrors the
      // backfill in migration 107.
      await client.query(
        `insert into service_item_divisions (company_id, service_item_code, division_code)
         select $1, $2, d.code from divisions d where d.company_id = $1
         on conflict (company_id, service_item_code, division_code) do nothing`,
        [ctx.company.id, code],
      )
      return { kind: 'ok' as const, item }
    })
    if (result.kind === 'conflict') {
      ctx.sendJson(409, { error: `service item code "${code}" already exists` })
      return true
    }
    ctx.sendJson(201, result.item)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/service-items\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const code = url.pathname.split('/')[3] ?? ''
    if (!code) {
      ctx.sendJson(400, { error: 'service item code is required' })
      return true
    }
    const parsedPatch = parseJsonBody(ServiceItemPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'service_item',
      entityName: 'service item',
      table: 'service_items',
      id: code,
      checkVersionWhere: 'company_id = $1 and code = $2',
      update: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update service_items
          set
            name = coalesce($3, name),
            category = coalesce($4, category),
            unit = coalesce($5, unit),
            default_rate = coalesce($6, default_rate),
            version = version + 1
          where company_id = $1 and code = $2 and ($7::int is null or version = $7)
          returning code, name, category, unit, default_rate, source, version, created_at
          `,
          [
            ctx.company.id,
            code,
            body.name ?? null,
            body.category ?? null,
            body.unit ?? null,
            body.default_rate ?? null,
            expectedVersion,
          ],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'service_item',
          entityId: code,
          action: 'update',
          row,
        })
        return row
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/service-items\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const code = url.pathname.split('/')[3] ?? ''
    if (!code) {
      ctx.sendJson(400, { error: 'service item code is required' })
      return true
    }
    const body = await ctx.readBody()
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'service_item',
      entityName: 'service item',
      table: 'service_items',
      id: code,
      checkVersionWhere: 'company_id = $1 and code = $2',
      delete: async (client, expectedVersion) => {
        const result = await client.query(
          `
          update service_items
          set deleted_at = now(), version = version + 1
          where company_id = $1 and code = $2 and deleted_at is null and ($3::int is null or version = $3)
          returning code, name, category, unit, default_rate, source, version, created_at
          `,
          [ctx.company.id, code, expectedVersion],
        )
        const row = result.rows[0]
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'service_item',
          entityId: code,
          action: 'delete',
          row,
        })
        return row
      },
    })
  }

  return false
}

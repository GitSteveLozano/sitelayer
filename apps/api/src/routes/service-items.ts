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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select code, name, category, unit, default_rate, source, version
       from service_items
       where company_id = $1 and deleted_at is null
       order by name asc`,
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
    const item = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into service_items (company_id, code, name, category, unit, default_rate, source, version, created_at)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, 'manual'), 1, now())
        returning code, name, category, unit, default_rate, source, version, created_at
        `,
        [ctx.company.id, code, name, category, unit, body.default_rate ?? null, body.source ?? 'manual'],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'service_item',
        entityId: code,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, item)
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

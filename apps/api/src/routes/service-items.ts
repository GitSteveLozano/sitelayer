import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

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
    const result = await ctx.pool.query(
      `select code, name, category, unit, default_rate, source, version
       from service_items
       where company_id = $1 and deleted_at is null
       order by name asc`,
      [ctx.company.id],
    )
    ctx.sendJson(200, { serviceItems: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/service-items') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const code = String(body.code ?? '').trim()
    const name = String(body.name ?? '').trim()
    const category = String(body.category ?? 'labor').trim()
    const unit = String(body.unit ?? 'hr').trim()
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
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
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
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'service_items',
          'company_id = $1 and code = $2',
          [ctx.company.id, code],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'service item not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/service-items\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const code = url.pathname.split('/')[3] ?? ''
    if (!code) {
      ctx.sendJson(400, { error: 'service item code is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
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
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'service_items',
          'company_id = $1 and code = $2',
          [ctx.company.id, code],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'service item not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

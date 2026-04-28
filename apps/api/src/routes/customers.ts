import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

/**
 * Cross-cutting helpers the customers route module needs from the rest of
 * server.ts. Passed in as a context object so this file doesn't have to
 * know about server.ts's module-level state. Same shape will work for the
 * other entity route modules; if more entities share this exact set, we
 * can promote it to route-context.ts as a stable contract.
 */
export type CustomerRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /**
   * Enforce role-based access. Returns true when allowed; on false the
   * helper has already sent the 403 response and the handler should return.
   */
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * Optimistic-concurrency check. Returns true when the version still
   * matches; on false the helper has already sent the 409 response and
   * the handler should return.
   */
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  /**
   * Backfill a QBO integration_mapping row for the given customer. Same
   * contract as server.ts's backfillCustomerMapping. Threaded through the
   * context so the customer handler can pass the active tx client.
   */
  backfillCustomerMapping: (
    companyId: string,
    customer: { id: string; external_id: string | null; name: string },
    executor: LedgerExecutor,
  ) => Promise<unknown>
}

/**
 * Handle /api/customers* requests. Returns true when the request matched
 * one of the routes in this module (regardless of response status); false
 * to let the parent dispatch fall through to the next handler.
 *
 * Mirrors the legacy inline handlers verbatim — same SQL, same payloads,
 * same role gates — just relocated. Tests rely on both the response shape
 * and the ledger row shape.
 */
export async function handleCustomerRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CustomerRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/customers') {
    const result = await ctx.pool.query(
      'select id, external_id, name, source, version, deleted_at, created_at from customers where company_id = $1 and deleted_at is null order by name asc',
      [ctx.company.id],
    )
    ctx.sendJson(200, { customers: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/customers') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const customer = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into customers (company_id, external_id, name, source, version)
        values ($1, $2, $3, $4, 1)
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
        [ctx.company.id, body.external_id ?? null, name, body.source ?? 'manual'],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'customer',
        entityId: row.id,
        action: 'create',
        row,
      })
      await ctx.backfillCustomerMapping(ctx.company.id, row, client)
      return row
    })
    ctx.sendJson(201, customer)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const customerId = url.pathname.split('/')[3] ?? ''
    if (!customerId) {
      ctx.sendJson(400, { error: 'customer id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update customers
        set
          external_id = coalesce($3, external_id),
          name = coalesce($4, name),
          source = coalesce($5, source),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($6::int is null or version = $6)
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
        [ctx.company.id, customerId, body.external_id ?? null, body.name ?? null, body.source ?? null, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'customer',
        entityId: customerId,
        action: 'update',
        row,
      })
      await ctx.backfillCustomerMapping(ctx.company.id, row, client)
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'customers',
          'company_id = $1 and id = $2 and deleted_at is null',
          [ctx.company.id, customerId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'customer not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const customerId = url.pathname.split('/')[3] ?? ''
    if (!customerId) {
      ctx.sendJson(400, { error: 'customer id is required' })
      return true
    }
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update customers
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
        [ctx.company.id, customerId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'customer',
        entityId: customerId,
        action: 'delete',
        row,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'customer not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

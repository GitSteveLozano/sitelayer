import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import { recordMutationLedger, withCompanyClient, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'

// POST /api/customers — `name` is required (the route already rejects an
// empty string with a specific message; we keep that path). external_id
// and source are optional + nullable so the existing payload shape stays
// valid. The schema's job is to reject `name: 42` / `external_id: {...}`
// upfront with a 400 instead of writing junk into customers.
const CustomerCreateBodySchema = z
  .object({
    name: z.string().optional(),
    external_id: z.string().nullish(),
    source: z.string().optional(),
  })
  .loose()

// PATCH /api/customers/:id — every column is optional (partial update).
// expected_version / version pass through for the versioned-update helper.
const CustomerPatchBodySchema = z
  .object({
    name: z.string().nullish(),
    external_id: z.string().nullish(),
    source: z.string().nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        'select id, external_id, name, source, version, deleted_at, created_at from customers where company_id = $1 and deleted_at is null order by name asc',
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { customers: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/customers') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const parsed = parseJsonBody(CustomerCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const name = (body.name ?? '').trim()
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
    const parsedPatch = parseJsonBody(CustomerPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: customerId,
      update: async (client, expectedVersion) => {
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
          [
            ctx.company.id,
            customerId,
            body.external_id ?? null,
            body.name ?? null,
            body.source ?? null,
            expectedVersion,
          ],
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
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const customerId = url.pathname.split('/')[3] ?? ''
    if (!customerId) {
      ctx.sendJson(400, { error: 'customer id is required' })
      return true
    }
    return deleteVersionedEntity({
      ctx,
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: customerId,
      delete: async (client) => {
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
      },
    })
  }

  return false
}

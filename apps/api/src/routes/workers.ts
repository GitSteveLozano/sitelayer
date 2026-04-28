import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

/**
 * Same context shape as customers.ts, minus the QBO mapping backfill —
 * workers don't sync to QBO. If we end up with a third entity that takes
 * the same trimmed-down ctx we can promote this to a shared route-context
 * variant.
 */
export type WorkerRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/workers* requests. Returns true when the request matched
 * one of the routes in this module (regardless of response status); false
 * to let the parent dispatch fall through to the next handler.
 */
export async function handleWorkerRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkerRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/workers') {
    const result = await ctx.pool.query(
      'select id, name, role, version, deleted_at, created_at from workers where company_id = $1 and deleted_at is null order by name asc',
      [ctx.company.id],
    )
    ctx.sendJson(200, { workers: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/workers') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const worker = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into workers (company_id, name, role)
        values ($1, $2, $3)
        returning id, name, role, version, deleted_at, created_at
        `,
        [ctx.company.id, name, body.role ?? 'crew'],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, worker)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const workerId = url.pathname.split('/')[3] ?? ''
    if (!workerId) {
      ctx.sendJson(400, { error: 'worker id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update workers
        set
          name = coalesce($3, name),
          role = coalesce($4, role),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($5::int is null or version = $5)
        returning id, name, role, version, deleted_at, created_at
        `,
        [ctx.company.id, workerId, body.name ?? null, body.role ?? null, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker',
        entityId: workerId,
        action: 'update',
        row,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'workers',
          'company_id = $1 and id = $2 and deleted_at is null',
          [ctx.company.id, workerId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'worker not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const workerId = url.pathname.split('/')[3] ?? ''
    if (!workerId) {
      ctx.sendJson(400, { error: 'worker id is required' })
      return true
    }
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update workers
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, name, role, version, deleted_at, created_at
        `,
        [ctx.company.id, workerId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker',
        entityId: workerId,
        action: 'delete',
        row,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'worker not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

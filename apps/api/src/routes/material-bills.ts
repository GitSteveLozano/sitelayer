import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { parseExpectedVersion } from '../http-utils.js'

export type MaterialBillRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle material_bills routes:
 * - GET    /api/projects/<id>/material-bills  — per-project list
 * - POST   /api/projects/<id>/material-bills  — admin/foreman/office;
 *                                                bumps the parent project's
 *                                                version inside the same tx
 * - PATCH  /api/material-bills/<id>           — versioned update; also
 *                                                bumps the parent project's
 *                                                version
 * - DELETE /api/material-bills/<id>           — versioned soft-delete
 */
export async function handleMaterialBillRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: MaterialBillRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const result = await ctx.pool.query(
      `
      select id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
      from material_bills
      where company_id = $1 and project_id = $2 and deleted_at is null
      order by occurred_on desc, created_at desc
      `,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { materialBills: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const body = await ctx.readBody()
    if (!body.vendor || body.amount === undefined || !body.bill_type) {
      ctx.sendJson(400, { error: 'vendor, amount, and bill_type are required' })
      return true
    }
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    if (expectedVersion !== null) {
      const projectVersionResult = await ctx.pool.query(
        'select version from projects where company_id = $1 and id = $2',
        [ctx.company.id, projectId],
      )
      const currentProject = projectVersionResult.rows[0]
      if (!currentProject) {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      if (Number(currentProject.version) !== expectedVersion) {
        ctx.sendJson(409, { error: 'version conflict', current_version: Number(currentProject.version) })
        return true
      }
    }
    const bill = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into material_bills (company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, now()::date))
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
        [
          ctx.company.id,
          projectId,
          body.vendor,
          body.amount,
          body.bill_type,
          body.description ?? null,
          body.occurred_on ?? null,
        ],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'material_bill',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', bill: row },
      })
      await client.query(
        'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
        [ctx.company.id, projectId],
      )
      return row
    })
    ctx.sendJson(201, bill)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const billId = url.pathname.split('/')[3] ?? ''
    if (!billId) {
      ctx.sendJson(400, { error: 'bill id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update material_bills
        set
          vendor_name = coalesce($3, vendor_name),
          amount = coalesce($4, amount),
          bill_type = coalesce($5, bill_type),
          description = coalesce($6, description),
          occurred_on = coalesce($7, occurred_on),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($8::int is null or version = $8)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
        [
          ctx.company.id,
          billId,
          body.vendor ?? null,
          body.amount ?? null,
          body.bill_type ?? null,
          body.description ?? null,
          body.occurred_on ?? null,
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'material_bill',
        entityId: billId,
        action: 'update',
        row,
        syncPayload: { action: 'update', bill: row },
      })
      await client.query(
        'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
        [ctx.company.id, row.project_id],
      )
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'material_bills',
          'company_id = $1 and id = $2',
          [ctx.company.id, billId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'bill not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const billId = url.pathname.split('/')[3] ?? ''
    if (!billId) {
      ctx.sendJson(400, { error: 'bill id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update material_bills
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
        [ctx.company.id, billId, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'material_bill',
        entityId: billId,
        action: 'delete',
        row,
        syncPayload: { action: 'delete', bill: row },
      })
      await client.query(
        'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
        [ctx.company.id, row.project_id],
      )
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'material_bills',
          'company_id = $1 and id = $2',
          [ctx.company.id, billId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'bill not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  return false
}

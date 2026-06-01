import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { buildPaginationMeta, parseExpectedVersion, parseJsonBody, parsePagination } from '../http-utils.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'
import type { PermissionAction } from '@sitelayer/domain'

/**
 * Coerce a bill `amount` (the schema accepts number-or-string dollars) into
 * integer cents for the auth_materials max_amount_cents constraint. Rounds to
 * the nearest cent; returns null for a non-finite/unparseable input so the
 * overlay falls back to an uncapped grant/deny check (the route's own amount
 * handling still owns shape validation downstream).
 */
function parseAmountToCents(amount: unknown): number | null {
  const dollars = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(dollars)) return null
  return Math.round(dollars * 100)
}

// POST /api/projects/:id/material-bills wire-format. The existing route
// only enforced presence of vendor/amount/bill_type; we tighten amount to
// a number (string-or-number to match the QBO mappings + existing client
// pattern that occasionally posts numeric-looking strings) and accept the
// optional occurred_on as YYYY-MM-DD when supplied. The 400 from the
// schema replaces the generic "vendor, amount, and bill_type are required"
// path for shape errors; the legacy missing-field 400 still wins because
// of the explicit required-fields check below the parse.
const DateInputSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be YYYY-MM-DD' })

const MaterialBillCreateBodySchema = z
  .object({
    vendor: z.string().optional(),
    amount: z.union([z.number(), z.string()]).optional(),
    bill_type: z.string().optional(),
    description: z.string().nullish(),
    occurred_on: DateInputSchema.nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

const MaterialBillPatchBodySchema = z
  .object({
    vendor: z.string().nullish(),
    amount: z.union([z.number(), z.string()]).nullish(),
    bill_type: z.string().nullish(),
    description: z.string().nullish(),
    occurred_on: DateInputSchema.nullish(),
    expected_version: z.union([z.number(), z.string()]).nullish(),
    version: z.union([z.number(), z.string()]).nullish(),
  })
  .loose()

export type MaterialBillRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  /** LAYER 2 named-action overlay; runs AFTER requireRole. See server.ts. */
  requirePermission: (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean
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
    const pagination = parsePagination(url.searchParams)
    if (!pagination.ok) {
      ctx.sendJson(400, { error: pagination.error })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `
      select id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
      from material_bills
      where company_id = $1 and project_id = $2 and deleted_at is null
      order by occurred_on desc, created_at desc
      limit $3 offset $4
      `,
        [ctx.company.id, projectId, pagination.value.limit, pagination.value.offset],
      ),
    )
    ctx.sendJson(200, {
      materialBills: result.rows,
      pagination: buildPaginationMeta(pagination.value, result.rowCount ?? result.rows.length),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const parsed = parseJsonBody(MaterialBillCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    if (!body.vendor || body.amount === undefined || !body.bill_type) {
      ctx.sendJson(400, { error: 'vendor, amount, and bill_type are required' })
      return true
    }
    // LAYER 2: auth_materials — Owner-only by default in the matrix (the
    // existing requireRole above also lets foreman/office through, so the
    // overlay is the place the office→estimator + foreman demotion is realized:
    // a plain foreman/office member passes requireRole but is denied here).
    // This is also the ONE live constraint: parse the dollar amount to integer
    // cents and pass it so checkConstraint can enforce a custom role's $-cap.
    const amountCents = parseAmountToCents(body.amount)
    if (!ctx.requirePermission('auth_materials', amountCents !== null ? { amountCents } : undefined)) return true
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    if (expectedVersion !== null) {
      const projectVersionResult = await withCompanyClient(ctx.company.id, (c) =>
        c.query('select version from projects where company_id = $1 and id = $2', [ctx.company.id, projectId]),
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
    const parsedPatch = parseJsonBody(MaterialBillPatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'material_bill',
      entityName: 'bill',
      table: 'material_bills',
      id: billId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      update: async (client, expectedVersion) => {
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
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const billId = url.pathname.split('/')[3] ?? ''
    if (!billId) {
      ctx.sendJson(400, { error: 'bill id is required' })
      return true
    }
    const body = await ctx.readBody()
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'material_bill',
      entityName: 'bill',
      table: 'material_bills',
      id: billId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
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
      },
    })
  }

  return false
}

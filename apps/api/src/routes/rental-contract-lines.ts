import type http from 'node:http'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidDateInput, parseJsonBody } from '../http-utils.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'
import {
  JOB_RENTAL_CONTRACT_COLUMNS,
  JOB_RENTAL_LINE_COLUMNS,
  RATE_UNITS,
  existsInCompany,
  normalizeEnum,
  optionalString,
  parseNonNegativeNumber,
  parsePositiveNumber,
  selectJobRentalLineById,
  type JobRentalContractRow,
  type JobRentalLineRow,
  type RentalInventoryRouteCtx,
} from './rental-inventory.types.js'

// Permissive wire-format schemas — fields stay optional/nullish to match the
// existing defensive coercion downstream (optionalString / parseNumber etc.);
// the schema only rejects clearly-malformed shapes (e.g. `quantity: {}`) up
// front. Numerics accept string-or-number because the parse helpers already
// coerce both. No `.strict()` — unknown keys pass through (`.loose()`).
const NumericInputSchema = z.union([z.number(), z.string()])

const RentalContractLineCreateBodySchema = z
  .object({
    inventory_item_id: z.string().nullish(),
    quantity: NumericInputSchema.nullish(),
    agreed_rate: NumericInputSchema.nullish(),
    rate_unit: z.string().nullish(),
    on_rent_date: z.string().nullish(),
    off_rent_date: z.string().nullish(),
    billable: z.boolean().nullish(),
    taxable: z.boolean().nullish(),
    status: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const RentalContractLinePatchBodySchema = z
  .object({
    quantity: NumericInputSchema.nullish(),
    agreed_rate: NumericInputSchema.nullish(),
    rate_unit: z.string().nullish(),
    on_rent_date: z.string().nullish(),
    off_rent_date: z.string().nullish(),
    billable: z.boolean().nullish(),
    taxable: z.boolean().nullish(),
    status: z.string().nullish(),
    notes: z.string().nullish(),
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
  })
  .loose()

const RentalContractLineDeleteBodySchema = z
  .object({
    expected_version: NumericInputSchema.nullish(),
    version: NumericInputSchema.nullish(),
  })
  .loose()

const RentalRateTierCreateBodySchema = z
  .object({
    rate_unit: z.string().nullish(),
    min_days: NumericInputSchema.nullish(),
    max_days: NumericInputSchema.nullish(),
    rate: NumericInputSchema.nullish(),
    sort_order: NumericInputSchema.nullish(),
  })
  .loose()

/**
 * Handle the rental contract line-item CRUD surface — lines under a contract
 * plus the per-line rental rate tiers used by `pickRentalTier` during billing-run
 * calculation. The contract CRUD (contracts + billing-run create/preview) lives in
 * `rental-contracts.ts`; the billing run workflow surface
 * (`approve`, `post_requested`, `void`, etc.) lives in `rental-billing-state.ts`.
 *
 * Routes:
 * - GET    /api/rental-contracts/:id/lines                              — list contract lines
 * - POST   /api/rental-contracts/:id/lines                              — add line
 * - PATCH  /api/rental-contract-lines/:id                               — versioned update
 * - DELETE /api/rental-contract-lines/:id                               — versioned soft-delete
 * - GET    /api/rental-contract-lines/:id/rate-tiers                    — list tiers
 * - POST   /api/rental-contract-lines/:id/rate-tiers                    — create tier
 * - DELETE /api/rental-contract-lines/:id/rate-tiers/:tierId            — delete tier
 */
export async function handleRentalContractLinesRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/lines$/)) {
    const contractId = url.pathname.split('/')[3] ?? ''
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<JobRentalLineRow>(
        `
      select ${JOB_RENTAL_LINE_COLUMNS}
      from job_rental_lines l
      join inventory_items i on i.company_id = l.company_id and i.id = l.inventory_item_id
      where l.company_id = $1 and l.contract_id = $2 and l.deleted_at is null
      order by l.created_at asc
      `,
        [ctx.company.id, contractId],
      ),
    )
    ctx.sendJson(200, { rentalLines: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/lines$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const contractId = url.pathname.split('/')[3] ?? ''
    const parsedBody = parseJsonBody(RentalContractLineCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const itemId = optionalString(body.inventory_item_id)
    const quantity = parsePositiveNumber(body.quantity)
    if (!itemId || quantity === null) {
      ctx.sendJson(400, { error: 'inventory_item_id and positive quantity are required' })
      return true
    }
    if (!(await existsInCompany(ctx.pool, 'inventory_items', ctx.company.id, itemId))) {
      ctx.sendJson(404, { error: 'inventory_item_id not found for company' })
      return true
    }
    const contractResult = await withCompanyClient(ctx.company.id, (c) =>
      c.query<JobRentalContractRow>(
        `select ${JOB_RENTAL_CONTRACT_COLUMNS} from job_rental_contracts where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, contractId],
      ),
    )
    const contract = contractResult.rows[0]
    if (!contract) {
      ctx.sendJson(404, { error: 'rental contract not found' })
      return true
    }
    const agreedRate = parseNonNegativeNumber(body.agreed_rate, 0)
    if (!Number.isFinite(agreedRate)) {
      ctx.sendJson(400, { error: 'agreed_rate must be a non-negative number' })
      return true
    }
    const onRentDate = optionalString(body.on_rent_date) ?? contract.billing_start_date
    if (!isValidDateInput(onRentDate)) {
      ctx.sendJson(400, { error: 'on_rent_date must be YYYY-MM-DD' })
      return true
    }
    if (body.off_rent_date && !isValidDateInput(body.off_rent_date)) {
      ctx.sendJson(400, { error: 'off_rent_date must be YYYY-MM-DD' })
      return true
    }
    const line = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `
        insert into job_rental_lines (
          company_id, contract_id, inventory_item_id, quantity, agreed_rate,
          rate_unit, on_rent_date, off_rent_date, billable, taxable, status, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, coalesce($9, true), coalesce($10, true), $11, $12)
        returning id
        `,
        [
          ctx.company.id,
          contractId,
          itemId,
          quantity,
          agreedRate,
          normalizeEnum(body.rate_unit, RATE_UNITS, 'cycle'),
          onRentDate,
          body.off_rent_date ?? null,
          body.billable ?? true,
          body.taxable ?? true,
          optionalString(body.status) ?? 'active',
          optionalString(body.notes),
        ],
      )
      const insertedRow = result.rows[0]
      if (!insertedRow) throw new HttpError(500, 'rental line insert returned no row')
      const rowId = insertedRow.id
      const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
      if (!row) throw new Error('inserted rental line not found')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_line',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, line)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/rental-contract-lines\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = url.pathname.split('/')[3] ?? ''
    const parsedBody = parseJsonBody(RentalContractLinePatchBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'job_rental_line',
      entityName: 'rental line',
      table: 'job_rental_lines',
      id: lineId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      update: async (client, expectedVersion) => {
        const result = await client.query<{ id: string }>(
          `
          update job_rental_lines
          set
            quantity = coalesce($3, quantity),
            agreed_rate = coalesce($4, agreed_rate),
            rate_unit = coalesce($5, rate_unit),
            on_rent_date = coalesce($6::date, on_rent_date),
            off_rent_date = case when $7::text = '__clear__' then null
                                 when $7::text is null then off_rent_date
                                 else $7::date end,
            billable = coalesce($8, billable),
            taxable = coalesce($9, taxable),
            status = coalesce($10, status),
            notes = coalesce($11, notes),
            version = version + 1,
            updated_at = now()
          where company_id = $1 and id = $2 and deleted_at is null
            and ($12::int is null or version = $12)
          returning id
          `,
          [
            ctx.company.id,
            lineId,
            body.quantity ?? null,
            body.agreed_rate ?? null,
            body.rate_unit ? normalizeEnum(body.rate_unit, RATE_UNITS, 'cycle') : null,
            body.on_rent_date ?? null,
            body.off_rent_date === null ? '__clear__' : (body.off_rent_date ?? null),
            body.billable ?? null,
            body.taxable ?? null,
            optionalString(body.status),
            optionalString(body.notes),
            expectedVersion,
          ],
        )
        const rowId = result.rows[0]?.id
        if (!rowId) return null
        const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'job_rental_line',
          entityId: lineId,
          action: 'update',
          row,
          idempotencyKey: `job_rental_line:update:${lineId}:${row.version}`,
        })
        return row
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/rental-contract-lines\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = url.pathname.split('/')[3] ?? ''
    const parsedBody = parseJsonBody(RentalContractLineDeleteBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'job_rental_line',
      entityName: 'rental line',
      table: 'job_rental_lines',
      id: lineId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
        const result = await client.query<{ id: string }>(
          `
          update job_rental_lines
          set deleted_at = now(), status = 'deleted', version = version + 1, updated_at = now()
          where company_id = $1 and id = $2 and deleted_at is null
            and ($3::int is null or version = $3)
          returning id
          `,
          [ctx.company.id, lineId, expectedVersion],
        )
        const rowId = result.rows[0]?.id
        if (!rowId) return null
        const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
        if (!row) return null
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'job_rental_line',
          entityId: lineId,
          action: 'delete',
          row,
        })
        return row
      },
    })
  }

  // Rental rate tiers (migration 067). Per-line tiered pricing windows
  // referenced by `pickRentalTier` during billing-run calculation. Tiers
  // are append/remove (no PATCH) — callers rebuild rather than mutate to
  // keep audit trail simple.
  const tierBaseMatch = url.pathname.match(/^\/api\/rental-contract-lines\/([^/]+)\/rate-tiers$/)
  if (req.method === 'GET' && tierBaseMatch) {
    const lineId = tierBaseMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{
        id: string
        job_rental_line_id: string
        rate_unit: string
        min_days: number
        max_days: number | null
        rate: string
        sort_order: number
      }>(
        `select id, job_rental_line_id, rate_unit, min_days, max_days, rate, sort_order
       from rental_rate_tiers
       where company_id = $1 and job_rental_line_id = $2
       order by sort_order asc, min_days asc`,
        [ctx.company.id, lineId],
      ),
    )
    ctx.sendJson(200, { rateTiers: result.rows })
    return true
  }

  if (req.method === 'POST' && tierBaseMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = tierBaseMatch[1]!
    const parsedBody = parseJsonBody(RentalRateTierCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const rateUnit = String(body.rate_unit ?? '').trim()
    const minDays = Number(body.min_days)
    const maxDaysRaw = body.max_days
    const maxDays = maxDaysRaw === null || maxDaysRaw === undefined || maxDaysRaw === '' ? null : Number(maxDaysRaw)
    const rate = Number(body.rate)
    const sortOrder = Number(body.sort_order ?? 0)

    if (!['day', 'week', 'month', 'cycle', 'each'].includes(rateUnit)) {
      ctx.sendJson(400, { error: 'rate_unit must be one of day, week, month, cycle, each' })
      return true
    }
    if (!Number.isFinite(minDays) || minDays < 1) {
      ctx.sendJson(400, { error: 'min_days must be a positive integer' })
      return true
    }
    if (maxDays !== null && (!Number.isFinite(maxDays) || maxDays < minDays)) {
      ctx.sendJson(400, { error: 'max_days must be >= min_days or null' })
      return true
    }
    if (!Number.isFinite(rate) || rate < 0) {
      ctx.sendJson(400, { error: 'rate must be a non-negative number' })
      return true
    }

    // Confirm the line belongs to the company before opening the tx.
    const lineCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string }>(
        `select id from job_rental_lines where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [ctx.company.id, lineId],
      ),
    )
    if (!lineCheck.rows[0]) {
      ctx.sendJson(404, { error: 'rental line not found' })
      return true
    }

    const created = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{
        id: string
        job_rental_line_id: string
        rate_unit: string
        min_days: number
        max_days: number | null
        rate: string
        sort_order: number
      }>(
        `insert into rental_rate_tiers
           (company_id, job_rental_line_id, rate_unit, min_days, max_days, rate, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, job_rental_line_id, rate_unit, min_days, max_days, rate, sort_order`,
        [ctx.company.id, lineId, rateUnit, minDays, maxDays, rate, sortOrder],
      )
      const row = result.rows[0]
      if (!row) throw new HttpError(500, 'rental rate tier insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_rate_tier',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, created)
    return true
  }

  const tierDeleteMatch = url.pathname.match(/^\/api\/rental-contract-lines\/([^/]+)\/rate-tiers\/([^/]+)$/)
  if (req.method === 'DELETE' && tierDeleteMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = tierDeleteMatch[1]!
    const tierId = tierDeleteMatch[2]!
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `delete from rental_rate_tiers
         where company_id = $1 and job_rental_line_id = $2 and id = $3
         returning id`,
        [ctx.company.id, lineId, tierId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_rate_tier',
        entityId: tierId,
        action: 'delete',
        row: { id: tierId, job_rental_line_id: lineId },
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'rental rate tier not found' })
      return true
    }
    ctx.sendJson(200, { id: tierId })
    return true
  }

  return false
}

import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { initialRentalNextInvoiceAt } from '@sitelayer/domain'
import { processRentalInvoice, RENTAL_SELECT_COLUMNS, type RentalRow } from '@sitelayer/queue'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, parseExpectedVersion } from '../http-utils.js'

export type RentalRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle /api/rentals* requests:
 * - GET    /api/rentals               — list rentals (filterable by status)
 * - POST   /api/rentals               — create rental (admin/office)
 * - PATCH  /api/rentals/<id>          — versioned update; returned_on
 *                                       triggers status='returned'; null
 *                                       string '__clear__' clears the
 *                                       returned_on/project_id/customer_id
 * - DELETE /api/rentals/<id>          — versioned soft-delete
 * - POST   /api/rentals/<id>/invoice  — manual invoice run via the
 *                                       shared @sitelayer/queue worker
 */
export async function handleRentalRoutes(req: http.IncomingMessage, url: URL, ctx: RentalRouteCtx): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/rentals') {
    const statusFilter = (url.searchParams.get('status') ?? 'active').toLowerCase()
    const values: unknown[] = [ctx.company.id]
    let statusClause = ''
    if (statusFilter === 'active') {
      statusClause = " and status = 'active'"
    } else if (statusFilter === 'returned') {
      statusClause = " and status in ('returned', 'invoiced_pending')"
    } else if (statusFilter === 'closed') {
      statusClause = " and status = 'closed'"
    } else if (statusFilter !== 'all') {
      ctx.sendJson(400, { error: 'status must be one of active, returned, closed, all' })
      return true
    }
    const result = await ctx.pool.query<RentalRow>(
      `
      select ${RENTAL_SELECT_COLUMNS}
      from rentals
      where company_id = $1 and deleted_at is null${statusClause}
      order by delivered_on desc, created_at desc
      `,
      values,
    )
    ctx.sendJson(200, { rentals: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/rentals') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const itemDescription = String(body.item_description ?? '').trim()
    if (!itemDescription) {
      ctx.sendJson(400, { error: 'item_description is required' })
      return true
    }
    if (!body.delivered_on || !isValidDateInput(body.delivered_on)) {
      ctx.sendJson(400, { error: 'delivered_on must be YYYY-MM-DD' })
      return true
    }
    if (body.returned_on && !isValidDateInput(body.returned_on)) {
      ctx.sendJson(400, { error: 'returned_on must be YYYY-MM-DD when provided' })
      return true
    }
    const dailyRate = Number(body.daily_rate ?? 0)
    if (!Number.isFinite(dailyRate) || dailyRate < 0) {
      ctx.sendJson(400, { error: 'daily_rate must be a non-negative number' })
      return true
    }
    const cadence = Math.max(1, Math.floor(Number(body.invoice_cadence_days ?? 7)))
    const nextInvoiceAt = initialRentalNextInvoiceAt(String(body.delivered_on), cadence)
    const projectId = body.project_id ? String(body.project_id) : null
    const customerId = body.customer_id ? String(body.customer_id) : null
    if (projectId) {
      const existing = await ctx.pool.query('select 1 from projects where company_id = $1 and id = $2', [
        ctx.company.id,
        projectId,
      ])
      if (!existing.rows[0]) {
        ctx.sendJson(400, { error: 'project_id not found for company' })
        return true
      }
    }
    if (customerId) {
      const existing = await ctx.pool.query('select 1 from customers where company_id = $1 and id = $2', [
        ctx.company.id,
        customerId,
      ])
      if (!existing.rows[0]) {
        ctx.sendJson(400, { error: 'customer_id not found for company' })
        return true
      }
    }
    const rental = await withMutationTx(async (client: PoolClient) => {
      const inserted = await client.query<RentalRow>(
        `
        insert into rentals (
          company_id, project_id, customer_id, item_description, daily_rate,
          delivered_on, returned_on, invoice_cadence_days, next_invoice_at, status, notes
        )
        values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, 'active', $10)
        returning ${RENTAL_SELECT_COLUMNS}
        `,
        [
          ctx.company.id,
          projectId,
          customerId,
          itemDescription,
          dailyRate,
          body.delivered_on,
          body.returned_on ?? null,
          cadence,
          nextInvoiceAt,
          body.notes ? String(body.notes) : null,
        ],
      )
      const row = inserted.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, rental)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/rentals\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const rentalId = url.pathname.split('/')[3] ?? ''
    if (!rentalId) {
      ctx.sendJson(400, { error: 'rental id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    if (body.delivered_on !== undefined && body.delivered_on !== null && !isValidDateInput(body.delivered_on)) {
      ctx.sendJson(400, { error: 'delivered_on must be YYYY-MM-DD' })
      return true
    }
    if (body.returned_on !== undefined && body.returned_on !== null && !isValidDateInput(body.returned_on)) {
      ctx.sendJson(400, { error: 'returned_on must be YYYY-MM-DD' })
      return true
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<RentalRow>(
        `
        update rentals
        set
          item_description = coalesce($3, item_description),
          daily_rate = coalesce($4, daily_rate),
          delivered_on = coalesce($5::date, delivered_on),
          returned_on = case when $6::text = '__clear__' then null
                             when $6::text is null then returned_on
                             else $6::date end,
          invoice_cadence_days = coalesce($7, invoice_cadence_days),
          status = coalesce($8, status),
          notes = coalesce($9, notes),
          project_id = case when $10::text = '__clear__' then null
                            when $10::text is null then project_id
                            else $10::uuid end,
          customer_id = case when $11::text = '__clear__' then null
                             when $11::text is null then customer_id
                             else $11::uuid end,
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($12::int is null or version = $12)
        returning ${RENTAL_SELECT_COLUMNS}
        `,
        [
          ctx.company.id,
          rentalId,
          body.item_description ?? null,
          body.daily_rate ?? null,
          body.delivered_on ?? null,
          body.returned_on === null ? '__clear__' : (body.returned_on ?? null),
          body.invoice_cadence_days ?? null,
          body.status ?? (body.returned_on ? 'returned' : null),
          body.notes ?? null,
          body.project_id === null ? '__clear__' : (body.project_id ?? null),
          body.customer_id === null ? '__clear__' : (body.customer_id ?? null),
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: rentalId,
        action: 'update',
        row,
        idempotencyKey: `rental:update:${rentalId}:${row.version}`,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion('rentals', 'company_id = $1 and id = $2', [ctx.company.id, rentalId], expectedVersion))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/rentals\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const rentalId = url.pathname.split('/')[3] ?? ''
    if (!rentalId) {
      ctx.sendJson(400, { error: 'rental id is required' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<RentalRow>(
        `
        update rentals
        set deleted_at = now(), version = version + 1, updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($3::int is null or version = $3)
        returning ${RENTAL_SELECT_COLUMNS}
        `,
        [ctx.company.id, rentalId, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: rentalId,
        action: 'delete',
        row,
      })
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion('rentals', 'company_id = $1 and id = $2', [ctx.company.id, rentalId], expectedVersion))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rentals\/[^/]+\/invoice$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const rentalId = url.pathname.split('/')[3] ?? ''
    if (!rentalId) {
      ctx.sendJson(400, { error: 'rental id is required' })
      return true
    }
    const existing = await ctx.pool.query<RentalRow>(
      `select ${RENTAL_SELECT_COLUMNS} from rentals where company_id = $1 and id = $2 and deleted_at is null`,
      [ctx.company.id, rentalId],
    )
    const rental = existing.rows[0]
    if (!rental) {
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    if (!rental.project_id) {
      ctx.sendJson(400, { error: 'rental must be linked to a project to invoice' })
      return true
    }
    const processed = await withMutationTx(async (client: PoolClient) => {
      const result = await processRentalInvoice(client, rental)
      if (result.bill) {
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'material_bill',
          entityId: result.bill.id,
          action: 'create',
          row: result.bill,
          syncPayload: {
            action: 'create',
            bill: result.bill,
            source: 'rental_invoice',
            rental_id: rentalId,
          },
          outboxPayload: { ...result.bill, source: 'rental_invoice', rental_id: rentalId },
        })
      }
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: rentalId,
        action: 'invoice',
        row: result.rental,
        syncPayload: {
          action: 'invoice',
          rental: result.rental,
          days: result.days,
          amount: result.amount,
          invoiced_through: result.invoiced_through,
        },
        outboxPayload: {
          rental: result.rental,
          bill_id: result.bill?.id ?? null,
          days: result.days,
          amount: result.amount,
        },
        idempotencyKey: `rental:invoice:${rentalId}:${result.rental.version}`,
      })
      return result
    })
    ctx.sendJson(200, {
      rental: processed.rental,
      bill: processed.bill,
      days: processed.days,
      amount: processed.amount,
      invoiced_through: processed.invoiced_through,
    })
    return true
  }

  return false
}

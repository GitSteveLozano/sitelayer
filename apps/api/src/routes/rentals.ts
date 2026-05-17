import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { initialRentalNextInvoiceAt } from '@sitelayer/domain'
import { processRentalInvoice, RENTAL_SELECT_COLUMNS, type RentalRow } from '@sitelayer/queue'
import {
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalWorkflow,
  type RentalWorkflowEvent,
  type RentalWorkflowSnapshot,
  type RentalWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidDateInput } from '../http-utils.js'
import { deleteVersionedEntity, patchVersionedEntity } from '../versioned-update.js'

export type RentalRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Dispatch a rental workflow event in the same tx as the row mutation:
 *   1. Read the locked rental row.
 *   2. Run the pure reducer against the persisted snapshot.
 *   3. UPDATE rentals with the reducer output, including state_version.
 *   4. Append a workflow_event_log row keyed on (entity_id, state_version).
 *
 * This is the Phase 2 wiring (CLAUDE.md "rental" workflow). Replaces the
 * direct `status='returned'` / `status='closed'` writes that previously
 * bypassed the reducer.
 */
async function applyRentalWorkflowTransition(
  client: PoolClient,
  args: {
    companyId: string
    rentalId: string
    event: RentalWorkflowEvent
    eventType: string
    actorUserId: string
  },
): Promise<
  | { kind: 'ok'; row: RentalRow & { state_version: number }; nextSnapshot: RentalWorkflowSnapshot }
  | { kind: 'not_found' }
  | { kind: 'illegal_transition'; message: string; row: RentalRow & { state_version: number } }
> {
  const lockedResult = await client.query<
    RentalRow & {
      state_version: number
      returned_at: string | null
      returned_by: string | null
      closed_at: string | null
      closed_by: string | null
    }
  >(
    `select ${RENTAL_SELECT_COLUMNS}, state_version, returned_at, returned_by, closed_at, closed_by
     from rentals
     where company_id = $1 and id = $2 and deleted_at is null
     for update`,
    [args.companyId, args.rentalId],
  )
  const current = lockedResult.rows[0]
  if (!current) return { kind: 'not_found' as const }

  const currentSnapshot: RentalWorkflowSnapshot = {
    state: (current.status as RentalWorkflowState) ?? 'active',
    state_version: current.state_version ?? 1,
    returned_at: current.returned_at ?? null,
    returned_by: current.returned_by ?? null,
    closed_at: current.closed_at ?? null,
    closed_by: current.closed_by ?? null,
  }

  let nextSnapshot: RentalWorkflowSnapshot
  try {
    nextSnapshot = transitionRentalWorkflow(currentSnapshot, args.event)
  } catch (err) {
    return {
      kind: 'illegal_transition' as const,
      message: err instanceof Error ? err.message : String(err),
      row: current,
    }
  }

  const updated = await client.query<RentalRow & { state_version: number }>(
    `update rentals
       set status = $3,
           state_version = $4,
           returned_on = case when $3 = 'returned' then coalesce(returned_on, now()::date) else returned_on end,
           returned_at = $5,
           returned_by = $6,
           closed_at = $7,
           closed_by = $8,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning ${RENTAL_SELECT_COLUMNS}, state_version`,
    [
      args.companyId,
      args.rentalId,
      nextSnapshot.state,
      nextSnapshot.state_version,
      nextSnapshot.returned_at ?? null,
      nextSnapshot.returned_by ?? null,
      nextSnapshot.closed_at ?? null,
      nextSnapshot.closed_by ?? null,
    ],
  )

  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: RENTAL_WORKFLOW_NAME,
    schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
    entityType: 'rental',
    entityId: args.rentalId,
    stateVersion: currentSnapshot.state_version,
    eventType: args.eventType,
    eventPayload: args.event,
    snapshotAfter: nextSnapshot,
    actorUserId: args.actorUserId,
  })
  const outcome = workflowEventOutcome(args.eventType)
  if (outcome) observeWorkflowEvent(RENTAL_WORKFLOW_NAME, outcome)

  const updatedRow = updated.rows[0]
  if (!updatedRow) throw new HttpError(500, 'rental update returned no row')
  return { kind: 'ok' as const, row: updatedRow, nextSnapshot }
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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalRow>(
        `
      select ${RENTAL_SELECT_COLUMNS}
      from rentals
      where company_id = $1 and deleted_at is null${statusClause}
      order by delivered_on desc, created_at desc
      `,
        values,
      ),
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
      const existing = await withCompanyClient(ctx.company.id, (c) =>
        c.query('select 1 from projects where company_id = $1 and id = $2', [ctx.company.id, projectId]),
      )
      if (!existing.rows[0]) {
        ctx.sendJson(400, { error: 'project_id not found for company' })
        return true
      }
    }
    if (customerId) {
      const existing = await withCompanyClient(ctx.company.id, (c) =>
        c.query('select 1 from customers where company_id = $1 and id = $2', [ctx.company.id, customerId]),
      )
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
      const row = inserted.rows[0]
      if (!row) throw new HttpError(500, 'rental insert returned no row')
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
    if (body.delivered_on !== undefined && body.delivered_on !== null && !isValidDateInput(body.delivered_on)) {
      ctx.sendJson(400, { error: 'delivered_on must be YYYY-MM-DD' })
      return true
    }
    if (body.returned_on !== undefined && body.returned_on !== null && !isValidDateInput(body.returned_on)) {
      ctx.sendJson(400, { error: 'returned_on must be YYYY-MM-DD' })
      return true
    }
    // The rental workflow owns status transitions. PATCH may NOT set
    // status directly; callers wanting to mark a rental returned must
    // POST /api/rentals/:id/return, and CLOSE must come through the
    // workflow events surface. We also reject the implicit
    // "PATCH returned_on=YYYY-MM-DD triggers status='returned'" path
    // that the legacy PATCH supported — clients should hit /return.
    if (body.status !== undefined && body.status !== null) {
      ctx.sendJson(409, {
        error:
          'rental status is owned by the rental workflow — use POST /api/rentals/:id/return or /transfer instead of PATCH status',
      })
      return true
    }
    if (body.returned_on !== undefined && body.returned_on !== null && body.returned_on !== '__clear__') {
      ctx.sendJson(409, {
        error: 'rental returned_on is owned by the rental workflow — use POST /api/rentals/:id/return instead',
      })
      return true
    }
    return patchVersionedEntity({
      ctx,
      body,
      entityType: 'rental',
      entityName: 'rental',
      table: 'rentals',
      id: rentalId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      update: async (client, expectedVersion) => {
        const result = await client.query<RentalRow>(
          `
          update rentals
          set
            item_description = coalesce($3, item_description),
            daily_rate = coalesce($4, daily_rate),
            delivered_on = coalesce($5::date, delivered_on),
            returned_on = case when $6::text = '__clear__' then null
                               else returned_on end,
            invoice_cadence_days = coalesce($7, invoice_cadence_days),
            notes = coalesce($8, notes),
            project_id = case when $9::text = '__clear__' then null
                              when $9::text is null then project_id
                              else $9::uuid end,
            customer_id = case when $10::text = '__clear__' then null
                               when $10::text is null then customer_id
                               else $10::uuid end,
            version = version + 1,
            updated_at = now()
          where company_id = $1 and id = $2 and deleted_at is null
            and ($11::int is null or version = $11)
          returning ${RENTAL_SELECT_COLUMNS}
          `,
          [
            ctx.company.id,
            rentalId,
            body.item_description ?? null,
            body.daily_rate ?? null,
            body.delivered_on ?? null,
            body.returned_on === null ? '__clear__' : null,
            body.invoice_cadence_days ?? null,
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
      },
    })
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/rentals\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const rentalId = url.pathname.split('/')[3] ?? ''
    if (!rentalId) {
      ctx.sendJson(400, { error: 'rental id is required' })
      return true
    }
    const body = await ctx.readBody()
    return deleteVersionedEntity({
      ctx,
      body,
      entityType: 'rental',
      entityName: 'rental',
      table: 'rentals',
      id: rentalId,
      checkVersionWhere: 'company_id = $1 and id = $2',
      delete: async (client, expectedVersion) => {
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
      },
    })
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rentals\/[^/]+\/invoice$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const rentalId = url.pathname.split('/')[3] ?? ''
    if (!rentalId) {
      ctx.sendJson(400, { error: 'rental id is required' })
      return true
    }
    const existing = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalRow>(
        `select ${RENTAL_SELECT_COLUMNS} from rentals where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, rentalId],
      ),
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

  // POST /api/rentals/:id/return — returns reconciliation (good/damaged/lost)
  // Body: { qty_good, qty_damaged, qty_lost, damage_photos?: string[],
  //         damage_charges_cents?: number, original_qty?: number }
  // Marks the rental returned_on=now() + status='returned' and records the
  // damage breakdown on the row. Damage charges are recorded but NOT pushed
  // to billing in this slice; that's the job of the rental-billing workflow.
  const returnMatch = url.pathname.match(/^\/api\/rentals\/([^/]+)\/return$/)
  if (req.method === 'POST' && returnMatch) {
    if (!ctx.requireRole(['admin', 'office'])) {
      ctx.sendJson(403, { error: 'admin/office only' })
      return true
    }
    const rentalId = returnMatch[1]!
    const body = await ctx.readBody()
    const qtyGood = Number(body.qty_good ?? 0)
    const qtyDamaged = Number(body.qty_damaged ?? 0)
    const qtyLost = Number(body.qty_lost ?? 0)
    if (![qtyGood, qtyDamaged, qtyLost].every((n) => Number.isFinite(n) && n >= 0)) {
      ctx.sendJson(400, { error: 'qty_good/qty_damaged/qty_lost must be non-negative numbers' })
      return true
    }
    const originalQty = Number(body.original_qty ?? NaN)
    if (Number.isFinite(originalQty) && qtyGood + qtyDamaged + qtyLost !== originalQty) {
      ctx.sendJson(400, { error: 'qty_good + qty_damaged + qty_lost must equal original_qty' })
      return true
    }
    const damagePhotos = Array.isArray(body.damage_photos)
      ? (body.damage_photos as unknown[]).filter((p): p is string => typeof p === 'string')
      : null
    const damageChargesCents = Number(body.damage_charges_cents ?? 0)
    if (!Number.isFinite(damageChargesCents) || damageChargesCents < 0) {
      ctx.sendJson(400, { error: 'damage_charges_cents must be a non-negative number' })
      return true
    }
    const result = await withMutationTx(async (client: PoolClient) => {
      // Dispatch the RETURN workflow event in the same tx. The reducer
      // is the single source of truth for the active → returned
      // transition; the additional return-reconciliation columns
      // (qty_good/qty_damaged/qty_lost/damage_photos/damage_charges_cents)
      // are written as part of the same UPDATE so a crash between
      // reducer dispatch and reconciliation persistence is impossible.
      const nowIso = new Date().toISOString()
      const event: RentalWorkflowEvent = {
        type: 'RETURN',
        returned_at: nowIso,
        returned_by: ctx.currentUserId,
      }
      const transition = await applyRentalWorkflowTransition(client, {
        companyId: ctx.company.id,
        rentalId,
        event,
        eventType: 'RETURN',
        actorUserId: ctx.currentUserId,
      })
      if (transition.kind === 'not_found') return { kind: 'not_found' as const }
      if (transition.kind === 'illegal_transition') {
        return { kind: 'illegal_transition' as const, message: transition.message }
      }
      // Apply return-reconciliation columns on the same row. These are
      // additive to what the workflow transition already wrote; they
      // are not part of the reducer because they're business data, not
      // state-machine data.
      const reconciled = await client.query<RentalRow>(
        `update rentals set
           qty_good = $1,
           qty_damaged = $2,
           qty_lost = $3,
           damage_photos = $4,
           damage_charges_cents = $5,
           updated_at = now()
         where id = $6 and company_id = $7
         returning ${RENTAL_SELECT_COLUMNS}`,
        [qtyGood, qtyDamaged, qtyLost, damagePhotos, damageChargesCents, rentalId, ctx.company.id],
      )
      const row = reconciled.rows[0] ?? transition.row
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: rentalId,
        action: 'return',
        row,
        syncPayload: {
          action: 'return',
          rental_id: rentalId,
          qty_good: qtyGood,
          qty_damaged: qtyDamaged,
          qty_lost: qtyLost,
          damage_charges_cents: damageChargesCents,
        },
        outboxPayload: { rental_id: rentalId, qty_good: qtyGood, qty_damaged: qtyDamaged, qty_lost: qtyLost },
        idempotencyKey: `rental:return:${rentalId}:${row.version}`,
      })
      return { kind: 'ok' as const, row }
    })
    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: result.message })
      return true
    }
    ctx.sendJson(200, { rental: result.row })
    return true
  }

  // POST /api/rentals/:id/transfer — transfer dispatch to another project.
  // Body: { to_project_id, transferred_at?: ISO date }
  // Closes the source rental (status='closed', returned_on=transferred_at)
  // and creates a new rental row referencing the original via
  // transferred_from_rental_id. Conserves the rental_billing accumulator
  // (each side bills against its own project).
  const transferMatch = url.pathname.match(/^\/api\/rentals\/([^/]+)\/transfer$/)
  if (req.method === 'POST' && transferMatch) {
    if (!ctx.requireRole(['admin', 'office'])) {
      ctx.sendJson(403, { error: 'admin/office only' })
      return true
    }
    const rentalId = transferMatch[1]!
    const body = await ctx.readBody()
    const toProjectId = typeof body.to_project_id === 'string' ? body.to_project_id : null
    if (!toProjectId) {
      ctx.sendJson(400, { error: 'to_project_id required' })
      return true
    }
    const transferredAtRaw = body.transferred_at
    const transferredAt = isValidDateInput(transferredAtRaw)
      ? (transferredAtRaw as string)
      : new Date().toISOString().slice(0, 10)
    const result = await withMutationTx(async (client: PoolClient) => {
      const existing = await client.query<RentalRow>(
        `select ${RENTAL_SELECT_COLUMNS} from rentals where id = $1 and company_id = $2 limit 1`,
        [rentalId, ctx.company.id],
      )
      const source = existing.rows[0]
      if (!source) return null
      // Verify the target project exists and belongs to this company.
      const proj = await client.query<{ id: string }>(
        `select id from projects where id = $1 and company_id = $2 limit 1`,
        [toProjectId, ctx.company.id],
      )
      if (!proj.rows[0]) return { error: 'target project not found' as const }
      // Dispatch the source rental's CLOSE through the workflow before
      // applying the transfer-specific returned_on date. The reducer is
      // the single source of truth for the closed status flip; the
      // returned_on is additive bookkeeping.
      const nowIso = new Date().toISOString()
      const closeEvent: RentalWorkflowEvent = {
        type: 'CLOSE',
        closed_at: nowIso,
        closed_by: ctx.currentUserId,
      }
      const closeTransition = await applyRentalWorkflowTransition(client, {
        companyId: ctx.company.id,
        rentalId,
        event: closeEvent,
        eventType: 'CLOSE',
        actorUserId: ctx.currentUserId,
      })
      if (closeTransition.kind === 'not_found') return null
      if (closeTransition.kind === 'illegal_transition') {
        return { error: closeTransition.message as string }
      }
      const closed = await client.query<RentalRow>(
        `update rentals set
           returned_on = $1,
           updated_at = now()
         where id = $2 and company_id = $3
         returning ${RENTAL_SELECT_COLUMNS}`,
        [transferredAt, rentalId, ctx.company.id],
      )
      const newRental = await client.query<RentalRow>(
        `insert into rentals (
           company_id, project_id, customer_id, sku, description, daily_rate_cents,
           delivered_on, status, invoice_cadence_days, next_invoice_at,
           transferred_from_rental_id
         )
         select company_id, $1, customer_id, sku, description, daily_rate_cents,
                $2, 'active', invoice_cadence_days, $3, id
           from rentals where id = $4 and company_id = $5
         returning ${RENTAL_SELECT_COLUMNS}`,
        [
          toProjectId,
          transferredAt,
          initialRentalNextInvoiceAt(transferredAt, source.invoice_cadence_days ?? 30),
          rentalId,
          ctx.company.id,
        ],
      )
      const closedRow = closed.rows[0]
      if (!closedRow) throw new HttpError(500, 'rental close returned no row')
      const newRow = newRental.rows[0]
      if (!newRow) throw new HttpError(500, 'rental transfer returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental',
        entityId: rentalId,
        action: 'transfer',
        row: closedRow,
        syncPayload: {
          action: 'transfer',
          source_rental_id: rentalId,
          new_rental_id: newRow.id,
          to_project_id: toProjectId,
        },
        outboxPayload: { source_rental_id: rentalId, new_rental_id: newRow.id, to_project_id: toProjectId },
        idempotencyKey: `rental:transfer:${rentalId}:${closedRow.version}`,
      })
      return { closed: closedRow, created: newRow }
    })
    if (!result) {
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    if ('error' in result) {
      ctx.sendJson(400, { error: result.error })
      return true
    }
    ctx.sendJson(200, { closed_rental: result.closed, new_rental: result.created })
    return true
  }

  return false
}

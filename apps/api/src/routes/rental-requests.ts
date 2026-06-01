import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { initialRentalNextInvoiceAt } from '@sitelayer/domain'
import { RENTAL_SELECT_COLUMNS, type RentalRow } from '@sitelayer/queue'
import {
  nextRentalRequestApprovalEvents,
  parseRentalRequestApprovalEventRequest,
  RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
  RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalRequestApprovalWorkflow,
  type RentalRequestApprovalWorkflowEvent,
  type RentalRequestApprovalWorkflowSnapshot,
  type RentalRequestApprovalWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { HttpError, isValidUuid } from '../http-utils.js'
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import {
  recordMutationLedger,
  recordMutationOutbox,
  recordWorkflowEvent,
  withCompanyClient,
  withMutationTx,
} from '../mutation-tx.js'

/**
 * Operator-side approval queue for rental requests submitted by customers
 * via the public portal (`POST /api/portal/rentals/:share_token/reserve`,
 * see routes/portal-rentals.ts). Customer submissions land in
 * `rental_requests` with status='pending'; this module is the office /
 * admin surface that lists them and converts approved entries into real
 * `rentals` rows.
 *
 * Surfaces:
 *   GET  /api/rental-requests?status=pending&limit=20
 *        Admin/office only. Lists rental_requests with optional customer
 *        join (when `customer_id` was populated from the share-link).
 *   POST /api/rental-requests/:id/approve
 *        Admin/office only. Idempotent: if a row was already approved we
 *        return the existing converted_rental_id instead of creating a
 *        second rentals row. The conversion mirrors the POST /api/rentals
 *        path: one rental per request line, all linked back via
 *        `converted_rental_id` on the request row (we point at the first
 *        line's rental for backwards compatibility with single-line
 *        flows).
 *   POST /api/rental-requests/:id/decline
 *        Admin/office only. Idempotent: re-declining a declined row
 *        returns the existing decline reason without overwriting.
 *
 * The columns this module reads/writes are split between migration 053
 * (table shape, `approved_at`, `approved_by`, `converted_rental_id`) and
 * the additive 055 migration (`approved_by_user_id`, `declined_at`,
 * `decline_reason`). See those files for the full DDL contract.
 */

export type RentalRequestRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type RentalRequestItem = {
  inventory_item_id: string | null
  qty: number
  start: string | null
  end: string | null
  delivery: string
  // Optional override fields the operator can pass when approving so
  // we don't refuse to convert when the catalog row is missing.
  description?: string | null
  daily_rate?: number | null
}

// Wire-format shape for an item entry on approve. The body fields are all
// optional / nullable because the route already defensively coerces in
// downstream code (description.toString(), Number(daily_rate)), but a
// non-object entry would crash that loop with a less-clear error, so we
// require an object shape upfront.
const RentalRequestItemBodySchema = z
  .object({
    inventory_item_id: z.string().nullish(),
    qty: z.number().nullish(),
    start: z.string().nullish(),
    end: z.string().nullish(),
    delivery: z.string().nullish(),
    description: z.string().nullish(),
    daily_rate: z.number().nullish(),
  })
  .loose()

const ApproveBodySchema = z
  .object({
    items: z.array(RentalRequestItemBodySchema).optional(),
  })
  .loose()

const DeclineBodySchema = z
  .object({
    decline_reason: z.string().nullish(),
  })
  .loose()

type RentalRequestRow = {
  id: string
  company_id: string
  share_link_id: string | null
  customer_id: string | null
  items: RentalRequestItem[] | string
  requested_start: string | null
  requested_end: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  status: string
  state_version: number
  approved_at: string | null
  approved_by: string | null
  approved_by_user_id: string | null
  rejected_at: string | null
  declined_at: string | null
  decline_reason: string | null
  converted_rental_id: string | null
  created_at: string
  updated_at: string
  // Joined customer fields (when customer_id is populated).
  customer_name?: string | null
  customer_external_id?: string | null
}

const MAX_LIMIT = 100

function normalizeItems(raw: RentalRequestItem[] | string | null | undefined): RentalRequestItem[] {
  if (!raw) return []
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as RentalRequestItem[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(raw) ? raw : []
}

function shapeRow(row: RentalRequestRow): RentalRequestRow {
  return { ...row, items: normalizeItems(row.items) }
}

function rowToSnapshot(row: RentalRequestRow): RentalRequestApprovalWorkflowSnapshot {
  return {
    state: (row.status as RentalRequestApprovalWorkflowState) ?? 'pending',
    state_version: row.state_version ?? 1,
    approved_at: row.approved_at ?? null,
    approved_by: row.approved_by ?? null,
    declined_at: row.declined_at ?? null,
    declined_by: null,
    decline_reason: row.decline_reason ?? null,
  }
}

/**
 * Canonical WorkflowSnapshot envelope { state, state_version, context,
 * next_events }. `context` carries the full row (incl. `status` for SPA
 * back-compat); `next_events` is always computed from the registered
 * reducer so the UI can only render transitions the reducer allows.
 */
function snapshotResponse(row: RentalRequestRow): {
  state: RentalRequestApprovalWorkflowState
  state_version: number
  context: RentalRequestRow
  next_events: ReturnType<typeof nextRentalRequestApprovalEvents>
} {
  const state = (row.status as RentalRequestApprovalWorkflowState) ?? 'pending'
  return {
    state,
    state_version: row.state_version ?? 1,
    context: row,
    next_events: nextRentalRequestApprovalEvents(state),
  }
}

const RENTAL_REQUEST_SELECT_COLUMNS = `id, company_id, share_link_id, customer_id, items,
               requested_start, requested_end,
               contact_name, contact_email, contact_phone, notes,
               status, state_version,
               approved_at, approved_by, approved_by_user_id,
               rejected_at, declined_at, decline_reason,
               converted_rental_id, created_at, updated_at`

/**
 * Create one `rentals` row per convertible request line in the same tx.
 * Shared by the legacy `/approve` route and the canonical `/events`
 * APPROVE path so both produce identical rentals + ledger rows.
 * Returns the created rows (may be empty if no line resolves to a
 * description + non-negative daily rate).
 */
async function createRentalsForRequest(
  client: PoolClient,
  ctx: RentalRequestRouteCtx,
  row: RentalRequestRow,
  items: RentalRequestItem[],
): Promise<RentalRow[]> {
  const inventoryIds = items
    .map((i) => i.inventory_item_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const catalog = inventoryIds.length
    ? await client.query<{ id: string; description: string; default_rental_rate: string }>(
        `
            select id, description, default_rental_rate
            from inventory_items
            where company_id = $1 and id = any($2::uuid[])
            `,
        [ctx.company.id, inventoryIds],
      )
    : { rows: [] }
  const catalogById = new Map(catalog.rows.map((r) => [r.id, r] as const))

  const today = new Date().toISOString().slice(0, 10)
  const createdRentals: RentalRow[] = []

  for (const item of items) {
    const catalogRow = item.inventory_item_id ? catalogById.get(item.inventory_item_id) : undefined
    const description = (item.description ?? catalogRow?.description ?? '').toString().trim()
    if (!description) continue
    const dailyRate = Number(item.daily_rate ?? catalogRow?.default_rental_rate ?? 0)
    if (!Number.isFinite(dailyRate) || dailyRate < 0) continue
    const deliveredOn = (item.start ?? row.requested_start ?? today).toString()
    const cadence = 7
    const nextInvoiceAt = initialRentalNextInvoiceAt(deliveredOn, cadence)
    const inserted = await client.query<RentalRow>(
      `
          insert into rentals (
            company_id, project_id, customer_id, item_description, daily_rate,
            delivered_on, returned_on, invoice_cadence_days, next_invoice_at, status, notes
          )
          values ($1, null, $2, $3, $4, $5::date, null, $6, $7, 'active', $8)
          returning ${RENTAL_SELECT_COLUMNS}
          `,
      [ctx.company.id, row.customer_id, description, dailyRate, deliveredOn, cadence, nextInvoiceAt, row.notes],
    )
    const rentalRow = inserted.rows[0]
    if (!rentalRow) throw new HttpError(500, 'rental insert returned no row')
    await recordMutationLedger(client, {
      companyId: ctx.company.id,
      entityType: 'rental',
      entityId: rentalRow.id,
      action: 'create',
      row: rentalRow,
      syncPayload: {
        action: 'create',
        rental: rentalRow,
        source: 'rental_request',
        rental_request_id: row.id,
      },
      actorUserId: ctx.currentUserId,
      idempotencyKey: `rental_request:approve:${row.id}:${rentalRow.id}`,
    })
    createdRentals.push(rentalRow)
  }
  return createdRentals
}

export async function handleRentalRequestRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalRequestRouteCtx,
): Promise<boolean> {
  // POST /api/rental-requests/:id/events — canonical versioned dispatch.
  // Wired before the legacy /approve + /decline routes. Applies the
  // rental_request_approval reducer with post-lock optimistic
  // state_version concurrency (409 on stale version / illegal
  // transition). On APPROVE it creates the same rentals + outbox row the
  // legacy /approve route does. Mirrors apps/api/src/routes/rental-events.ts.
  const eventsMatch = url.pathname.match(/^\/api\/rental-requests\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventsMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const requestId = eventsMatch[1]!
    if (!isValidUuid(requestId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const rawBody = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    const parsed = parseRentalRequestApprovalEventRequest(rawBody)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion, decline_reason: declineReason } = parsed.value

    const result = await withMutationTx(async (client: PoolClient) => {
      const fetched = await client.query<RentalRequestRow>(
        `
        select ${RENTAL_REQUEST_SELECT_COLUMNS}
        from rental_requests
        where id = $1 and company_id = $2
        for update
        `,
        [requestId, ctx.company.id],
      )
      const row = fetched.rows[0]
      if (!row) return { kind: 'not_found' as const }
      // Post-lock optimistic version check.
      if ((row.state_version ?? 1) !== stateVersion) {
        return { kind: 'version_conflict' as const, row: shapeRow(row) }
      }

      const currentSnapshot = rowToSnapshot(row)
      const nowIso = new Date().toISOString()
      const reducerEvent: RentalRequestApprovalWorkflowEvent =
        eventType === 'APPROVE'
          ? { type: 'APPROVE', approved_at: nowIso, approved_by: ctx.currentUserId }
          : {
              type: 'DECLINE',
              declined_at: nowIso,
              declined_by: ctx.currentUserId,
              decline_reason: declineReason ?? null,
            }
      let nextSnapshot: RentalRequestApprovalWorkflowSnapshot
      try {
        nextSnapshot = transitionRentalRequestApprovalWorkflow(currentSnapshot, reducerEvent)
      } catch (err) {
        return {
          kind: 'illegal_transition' as const,
          row: shapeRow(row),
          message: err instanceof Error ? err.message : String(err),
        }
      }

      if (reducerEvent.type === 'APPROVE') {
        const items = normalizeItems(row.items)
        if (items.length === 0) return { kind: 'no_items' as const }
        const createdRentals = await createRentalsForRequest(client, ctx, row, items)
        if (createdRentals.length === 0) return { kind: 'no_items' as const }
        const primaryRentalId = createdRentals[0]!.id
        const updated = await client.query<RentalRequestRow>(
          `
          update rental_requests
          set status = $5,
              state_version = $6,
              approved_at = $7,
              approved_by = $3,
              approved_by_user_id = $3,
              converted_rental_id = $4,
              updated_at = now()
          where id = $1 and company_id = $2
          returning ${RENTAL_REQUEST_SELECT_COLUMNS}
          `,
          [
            requestId,
            ctx.company.id,
            ctx.currentUserId,
            primaryRentalId,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.approved_at ?? nowIso,
          ],
        )
        const updatedRow = updated.rows[0]
        if (!updatedRow) throw new HttpError(500, 'rental request approve update returned no row')
        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
          schemaVersion: RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
          entityType: 'rental_request',
          entityId: requestId,
          stateVersion: currentSnapshot.state_version,
          eventType: 'APPROVE',
          eventPayload: reducerEvent,
          snapshotAfter: nextSnapshot,
          actorUserId: ctx.currentUserId,
        })
        const approveOutcome = workflowEventOutcome('APPROVE')
        if (approveOutcome) observeWorkflowEvent(RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME, approveOutcome)
        await recordMutationOutbox(
          ctx.company.id,
          'rental_request',
          requestId,
          'create_rental_from_request',
          { rental_request_id: requestId, rental_ids: createdRentals.map((r) => r.id) },
          `rental_request:create_rental_from_request:${requestId}`,
          'server',
          ctx.currentUserId,
          client,
        )
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'rental_request',
          entityId: requestId,
          action: 'approve',
          row: updatedRow,
          syncPayload: {
            action: 'approve',
            rental_request_id: requestId,
            rental_ids: createdRentals.map((r) => r.id),
          },
          outboxPayload: {
            rental_request_id: requestId,
            rental_ids: createdRentals.map((r) => r.id),
          },
          actorUserId: ctx.currentUserId,
          idempotencyKey: `rental_request:approve:${requestId}`,
        })
        return {
          kind: 'ok' as const,
          row: shapeRow(updatedRow),
          created: createdRentals,
          eventType: 'APPROVE' as const,
        }
      }

      // DECLINE
      const reason = reducerEvent.decline_reason ?? null
      const updated = await client.query<RentalRequestRow>(
        `
        update rental_requests
        set status = $4,
            state_version = $5,
            declined_at = $6,
            decline_reason = $3,
            updated_at = now()
        where id = $1 and company_id = $2
        returning ${RENTAL_REQUEST_SELECT_COLUMNS}
        `,
        [
          requestId,
          ctx.company.id,
          reason,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.declined_at ?? nowIso,
        ],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) throw new HttpError(500, 'rental request decline update returned no row')
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
        schemaVersion: RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
        entityType: 'rental_request',
        entityId: requestId,
        stateVersion: currentSnapshot.state_version,
        eventType: 'DECLINE',
        eventPayload: reducerEvent,
        snapshotAfter: nextSnapshot,
        actorUserId: ctx.currentUserId,
      })
      const declineOutcome = workflowEventOutcome('DECLINE')
      if (declineOutcome) observeWorkflowEvent(RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME, declineOutcome)
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_request',
        entityId: requestId,
        action: 'decline',
        row: updatedRow,
        syncPayload: { action: 'decline', rental_request_id: requestId, decline_reason: reason },
        actorUserId: ctx.currentUserId,
        idempotencyKey: `rental_request:decline:${requestId}`,
      })
      return {
        kind: 'ok' as const,
        row: shapeRow(updatedRow),
        created: [] as RentalRow[],
        eventType: 'DECLINE' as const,
      }
    })

    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'rental request not found' })
      return true
    }
    if (result.kind === 'no_items') {
      ctx.sendJson(400, { error: 'no convertible line items on the request' })
      return true
    }
    if (result.kind === 'version_conflict') {
      ctx.sendJson(409, {
        error: 'state_version mismatch — reload and retry',
        snapshot: snapshotResponse(result.row),
      })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: result.message, snapshot: snapshotResponse(result.row) })
      return true
    }
    ctx.sendJson(200, snapshotResponse(result.row))
    return true
  }

  // GET /api/rental-requests/:id — workflow snapshot. Matched before the
  // bare list route (which is path-equality guarded above this is the
  // segment form). The list path GET /api/rental-requests has no trailing
  // id segment so it is matched by the equality check below.
  const detailMatch = url.pathname.match(/^\/api\/rental-requests\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const requestId = detailMatch[1]!
    if (!isValidUuid(requestId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const fetched = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalRequestRow>(
        `
        select ${RENTAL_REQUEST_SELECT_COLUMNS}
        from rental_requests
        where id = $1 and company_id = $2
        limit 1
        `,
        [requestId, ctx.company.id],
      ),
    )
    const row = fetched.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'rental request not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(shapeRow(row)))
    return true
  }

  // GET /api/rental-requests
  if (req.method === 'GET' && url.pathname === '/api/rental-requests') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const statusParam = (url.searchParams.get('status') ?? 'pending').toLowerCase()
    const allowedStatuses = ['pending', 'approved', 'declined', 'all'] as const
    if (!allowedStatuses.includes(statusParam as (typeof allowedStatuses)[number])) {
      ctx.sendJson(400, { error: `status must be one of ${allowedStatuses.join(', ')}` })
      return true
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? 20)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : 20

    const values: unknown[] = [ctx.company.id]
    let statusClause = ''
    if (statusParam !== 'all') {
      values.push(statusParam)
      statusClause = ` and rr.status = $${values.length}`
    }
    values.push(limit)
    const limitParam = `$${values.length}`
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalRequestRow>(
        `
      select
        rr.id, rr.company_id, rr.share_link_id, rr.customer_id, rr.items,
        rr.requested_start, rr.requested_end,
        rr.contact_name, rr.contact_email, rr.contact_phone, rr.notes,
        rr.status, rr.state_version,
        rr.approved_at, rr.approved_by, rr.approved_by_user_id,
        rr.rejected_at, rr.declined_at, rr.decline_reason,
        rr.converted_rental_id, rr.created_at, rr.updated_at,
        c.name as customer_name, c.external_id as customer_external_id
      from rental_requests rr
      left join customers c on c.id = rr.customer_id and c.company_id = rr.company_id
      where rr.company_id = $1${statusClause}
      order by rr.created_at desc
      limit ${limitParam}
      `,
        values,
      ),
    )
    ctx.sendJson(200, { rentalRequests: result.rows.map(shapeRow) })
    return true
  }

  // POST /api/rental-requests/:id/approve
  const approveMatch = url.pathname.match(/^\/api\/rental-requests\/([^/]+)\/approve$/)
  if (req.method === 'POST' && approveMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const requestId = approveMatch[1]!
    const rawBody = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    const parsed = ApproveBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const path = issue?.path.length ? issue.path.map((p) => String(p)).join('.') : '(root)'
      ctx.sendJson(400, { error: `${path}: ${issue?.message ?? 'invalid body'}` })
      return true
    }
    // Operators can override defaults at approval time when the portal
    // submission lacked a catalog id — keeps the route useful even when
    // the customer typo'd a description. Cast back to the route's
    // domain type — the schema is a superset that allows the field
    // shapes the loop downstream actually consumes.
    const overrides =
      parsed.data.items && parsed.data.items.length > 0 ? (parsed.data.items as RentalRequestItem[]) : null

    const result = await withMutationTx(async (client: PoolClient) => {
      // Lock the request row so concurrent approve/decline don't race.
      const fetched = await client.query<RentalRequestRow>(
        `
        select id, company_id, share_link_id, customer_id, items,
               requested_start, requested_end,
               contact_name, contact_email, contact_phone, notes,
               status, state_version,
               approved_at, approved_by, approved_by_user_id,
               rejected_at, declined_at, decline_reason,
               converted_rental_id, created_at, updated_at
        from rental_requests
        where id = $1 and company_id = $2
        for update
        `,
        [requestId, ctx.company.id],
      )
      const row = fetched.rows[0]
      if (!row) return { error: 'not_found' as const }
      if (row.status === 'declined') {
        return { error: 'already_declined' as const, row: shapeRow(row) }
      }
      // Idempotent re-approve: don't create another rental.
      if (row.status === 'approved' && row.converted_rental_id) {
        return { idempotent: true as const, row: shapeRow(row) }
      }
      // Dispatch APPROVE through the rental_request_approval reducer.
      // Reducer asserts pending → approved; the idempotent short-
      // circuit above already handled the re-approve case, and any
      // other terminal state (declined) was handled above. Replaces
      // the direct status='approved' UPDATE the original #325 left
      // untouched (caught in the 2026-05-16 verification audit).
      const currentSnapshot: RentalRequestApprovalWorkflowSnapshot = {
        state: (row.status as RentalRequestApprovalWorkflowState) ?? 'pending',
        state_version: row.state_version ?? 1,
        approved_at: row.approved_at ?? null,
        approved_by: row.approved_by ?? null,
        declined_at: row.declined_at ?? null,
        declined_by: null,
        decline_reason: row.decline_reason ?? null,
      }
      const nowIso = new Date().toISOString()
      const approveEvent: RentalRequestApprovalWorkflowEvent = {
        type: 'APPROVE',
        approved_at: nowIso,
        approved_by: ctx.currentUserId,
      }
      let nextSnapshot: RentalRequestApprovalWorkflowSnapshot
      try {
        nextSnapshot = transitionRentalRequestApprovalWorkflow(currentSnapshot, approveEvent)
      } catch (err) {
        return {
          error: 'illegal_transition' as const,
          message: err instanceof Error ? err.message : String(err),
        }
      }

      const items = overrides && overrides.length > 0 ? overrides : normalizeItems(row.items)
      if (items.length === 0) {
        return { error: 'no_items' as const }
      }

      // Resolve catalog rows for inventory_item_ids the customer picked
      // so we can pull description + daily_rate when the operator didn't
      // override them. Anything outside this company is dropped.
      const inventoryIds = items
        .map((i) => i.inventory_item_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      const catalog = inventoryIds.length
        ? await client.query<{ id: string; description: string; default_rental_rate: string }>(
            `
            select id, description, default_rental_rate
            from inventory_items
            where company_id = $1 and id = any($2::uuid[])
            `,
            [ctx.company.id, inventoryIds],
          )
        : { rows: [] }
      const catalogById = new Map(catalog.rows.map((r) => [r.id, r] as const))

      const today = new Date().toISOString().slice(0, 10)
      const createdRentals: RentalRow[] = []

      for (const item of items) {
        const catalogRow = item.inventory_item_id ? catalogById.get(item.inventory_item_id) : undefined
        const description = (item.description ?? catalogRow?.description ?? '').toString().trim()
        if (!description) {
          // Skip lines we can't describe — operator override or catalog
          // lookup is required. The remaining lines still convert.
          continue
        }
        const dailyRate = Number(item.daily_rate ?? catalogRow?.default_rental_rate ?? 0)
        if (!Number.isFinite(dailyRate) || dailyRate < 0) continue
        const deliveredOn = (item.start ?? row.requested_start ?? today).toString()
        const cadence = 7
        const nextInvoiceAt = initialRentalNextInvoiceAt(deliveredOn, cadence)
        const inserted = await client.query<RentalRow>(
          `
          insert into rentals (
            company_id, project_id, customer_id, item_description, daily_rate,
            delivered_on, returned_on, invoice_cadence_days, next_invoice_at, status, notes
          )
          values ($1, null, $2, $3, $4, $5::date, null, $6, $7, 'active', $8)
          returning ${RENTAL_SELECT_COLUMNS}
          `,
          [ctx.company.id, row.customer_id, description, dailyRate, deliveredOn, cadence, nextInvoiceAt, row.notes],
        )
        const rentalRow = inserted.rows[0]
        if (!rentalRow) throw new HttpError(500, 'rental insert returned no row')
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'rental',
          entityId: rentalRow.id,
          action: 'create',
          row: rentalRow,
          syncPayload: {
            action: 'create',
            rental: rentalRow,
            source: 'rental_request',
            rental_request_id: requestId,
          },
          actorUserId: ctx.currentUserId,
          idempotencyKey: `rental_request:approve:${requestId}:${rentalRow.id}`,
        })
        createdRentals.push(rentalRow)
      }

      if (createdRentals.length === 0) {
        return { error: 'no_convertible_items' as const }
      }

      const primaryRentalId = createdRentals[0]!.id
      const updated = await client.query<RentalRequestRow>(
        `
        update rental_requests
        set status = $5,
            state_version = $6,
            approved_at = $7,
            approved_by = $3,
            approved_by_user_id = $3,
            converted_rental_id = $4,
            updated_at = now()
        where id = $1 and company_id = $2
        returning id, company_id, share_link_id, customer_id, items,
                  requested_start, requested_end,
                  contact_name, contact_email, contact_phone, notes,
                  status, state_version,
                  approved_at, approved_by, approved_by_user_id,
                  rejected_at, declined_at, decline_reason,
                  converted_rental_id, created_at, updated_at
        `,
        [
          requestId,
          ctx.company.id,
          ctx.currentUserId,
          primaryRentalId,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.approved_at ?? nowIso,
        ],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) throw new HttpError(500, 'rental request approve update returned no row')
      // Append workflow_event_log row keyed on the PRIOR state_version
      // so the unique (entity_id, state_version) constraint naturally
      // rejects duplicate writes for the same transition.
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
        schemaVersion: RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
        entityType: 'rental_request',
        entityId: requestId,
        stateVersion: currentSnapshot.state_version,
        eventType: 'APPROVE',
        eventPayload: approveEvent,
        snapshotAfter: nextSnapshot,
        actorUserId: ctx.currentUserId,
      })
      const approveOutcome = workflowEventOutcome('APPROVE')
      if (approveOutcome) observeWorkflowEvent(RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME, approveOutcome)
      // Emit the create_rental_from_request side-effect outbox row as
      // declared by the reducer's sideEffectTypes — provides the audit
      // anchor "this APPROVE → these rentals" even though the route
      // already created them inline.
      await recordMutationOutbox(
        ctx.company.id,
        'rental_request',
        requestId,
        'create_rental_from_request',
        { rental_request_id: requestId, rental_ids: createdRentals.map((r) => r.id) },
        `rental_request:create_rental_from_request:${requestId}`,
        'server',
        ctx.currentUserId,
        client,
      )
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_request',
        entityId: requestId,
        action: 'approve',
        row: updatedRow,
        syncPayload: {
          action: 'approve',
          rental_request_id: requestId,
          rental_ids: createdRentals.map((r) => r.id),
        },
        outboxPayload: {
          rental_request_id: requestId,
          rental_ids: createdRentals.map((r) => r.id),
        },
        actorUserId: ctx.currentUserId,
        idempotencyKey: `rental_request:approve:${requestId}`,
      })
      return { created: createdRentals, row: shapeRow(updatedRow) }
    })

    if ('error' in result) {
      if (result.error === 'not_found') {
        ctx.sendJson(404, { error: 'rental request not found' })
        return true
      }
      if (result.error === 'already_declined') {
        ctx.sendJson(409, { error: 'rental request already declined', rentalRequest: result.row })
        return true
      }
      if (result.error === 'illegal_transition') {
        ctx.sendJson(409, { error: result.message })
        return true
      }
      if (result.error === 'no_items' || result.error === 'no_convertible_items') {
        ctx.sendJson(400, { error: 'no convertible line items on the request' })
        return true
      }
    }
    if ('idempotent' in result) {
      ctx.sendJson(200, {
        rentalRequest: result.row,
        rental_id: result.row.converted_rental_id,
        idempotent: true,
      })
      return true
    }
    ctx.sendJson(200, {
      rentalRequest: result.row,
      rental_id: result.row.converted_rental_id,
      rentals: result.created,
    })
    return true
  }

  // POST /api/rental-requests/:id/decline
  const declineMatch = url.pathname.match(/^\/api\/rental-requests\/([^/]+)\/decline$/)
  if (req.method === 'POST' && declineMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const requestId = declineMatch[1]!
    const rawBody = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    const parsedDecline = DeclineBodySchema.safeParse(rawBody)
    if (!parsedDecline.success) {
      const issue = parsedDecline.error.issues[0]
      const path = issue?.path.length ? issue.path.map((p) => String(p)).join('.') : '(root)'
      ctx.sendJson(400, { error: `${path}: ${issue?.message ?? 'invalid body'}` })
      return true
    }
    const reason =
      typeof parsedDecline.data.decline_reason === 'string' ? parsedDecline.data.decline_reason.trim() : null

    const result = await withMutationTx(async (client: PoolClient) => {
      const fetched = await client.query<RentalRequestRow>(
        `
        select id, company_id, share_link_id, customer_id, items,
               requested_start, requested_end,
               contact_name, contact_email, contact_phone, notes,
               status, state_version,
               approved_at, approved_by, approved_by_user_id,
               rejected_at, declined_at, decline_reason,
               converted_rental_id, created_at, updated_at
        from rental_requests
        where id = $1 and company_id = $2
        for update
        `,
        [requestId, ctx.company.id],
      )
      const row = fetched.rows[0]
      if (!row) return { error: 'not_found' as const }
      if (row.status === 'approved') {
        return { error: 'already_approved' as const, row: shapeRow(row) }
      }
      if (row.status === 'declined') {
        // Idempotent: keep the original reason + timestamp.
        return { idempotent: true as const, row: shapeRow(row) }
      }
      // Dispatch DECLINE through the rental_request_approval reducer.
      const currentSnapshot: RentalRequestApprovalWorkflowSnapshot = {
        state: (row.status as RentalRequestApprovalWorkflowState) ?? 'pending',
        state_version: row.state_version ?? 1,
        approved_at: row.approved_at ?? null,
        approved_by: row.approved_by ?? null,
        declined_at: row.declined_at ?? null,
        declined_by: null,
        decline_reason: row.decline_reason ?? null,
      }
      const nowIso = new Date().toISOString()
      const declineEvent: RentalRequestApprovalWorkflowEvent = {
        type: 'DECLINE',
        declined_at: nowIso,
        declined_by: ctx.currentUserId,
        decline_reason: reason,
      }
      let nextSnapshot: RentalRequestApprovalWorkflowSnapshot
      try {
        nextSnapshot = transitionRentalRequestApprovalWorkflow(currentSnapshot, declineEvent)
      } catch (err) {
        return {
          error: 'illegal_transition' as const,
          message: err instanceof Error ? err.message : String(err),
        }
      }
      const updated = await client.query<RentalRequestRow>(
        `
        update rental_requests
        set status = $4,
            state_version = $5,
            declined_at = $6,
            decline_reason = $3,
            updated_at = now()
        where id = $1 and company_id = $2
        returning id, company_id, share_link_id, customer_id, items,
                  requested_start, requested_end,
                  contact_name, contact_email, contact_phone, notes,
                  status, state_version,
                  approved_at, approved_by, approved_by_user_id,
                  rejected_at, declined_at, decline_reason,
                  converted_rental_id, created_at, updated_at
        `,
        [
          requestId,
          ctx.company.id,
          reason,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.declined_at ?? nowIso,
        ],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) throw new HttpError(500, 'rental request decline update returned no row')
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME,
        schemaVersion: RENTAL_REQUEST_APPROVAL_WORKFLOW_SCHEMA_VERSION,
        entityType: 'rental_request',
        entityId: requestId,
        stateVersion: currentSnapshot.state_version,
        eventType: 'DECLINE',
        eventPayload: declineEvent,
        snapshotAfter: nextSnapshot,
        actorUserId: ctx.currentUserId,
      })
      const declineOutcome = workflowEventOutcome('DECLINE')
      if (declineOutcome) observeWorkflowEvent(RENTAL_REQUEST_APPROVAL_WORKFLOW_NAME, declineOutcome)
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_request',
        entityId: requestId,
        action: 'decline',
        row: updatedRow,
        syncPayload: {
          action: 'decline',
          rental_request_id: requestId,
          decline_reason: reason,
        },
        actorUserId: ctx.currentUserId,
        idempotencyKey: `rental_request:decline:${requestId}`,
      })
      return { row: shapeRow(updatedRow) }
    })

    if ('error' in result) {
      if (result.error === 'not_found') {
        ctx.sendJson(404, { error: 'rental request not found' })
        return true
      }
      if (result.error === 'already_approved') {
        ctx.sendJson(409, { error: 'rental request already approved', rentalRequest: result.row })
        return true
      }
      if (result.error === 'illegal_transition') {
        ctx.sendJson(409, { error: result.message })
        return true
      }
    }
    if ('idempotent' in result) {
      ctx.sendJson(200, { rentalRequest: result.row, idempotent: true })
      return true
    }
    ctx.sendJson(200, { rentalRequest: result.row })
    return true
  }

  return false
}

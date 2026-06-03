import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid, parseJsonBody } from '../http-utils.js'

export type InventoryServiceTicketRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const TICKET_COLUMNS = `
  id, company_id, inventory_item_id, status, opened_at, opened_by,
  completed_at, notes, tier_origin, created_at, updated_at
`

// Linear lifecycle: open → in_service → done. Each status names the set of
// statuses it may advance to (terminal states map to an empty set). The PATCH
// handler rejects any transition not listed here with a 422.
const TICKET_STATUSES = ['open', 'in_service', 'done'] as const
type TicketStatus = (typeof TICKET_STATUSES)[number]

const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_service', 'done'],
  in_service: ['done'],
  done: [],
}

function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value)
}

// POST /api/inventory/service-tickets wire-format. Permissive: the route still
// enforces the uuid shape on inventory_item_id and trims notes; the schema only
// rejects malformed field types up front.
const ServiceTicketCreateBodySchema = z
  .object({
    inventory_item_id: z.string().optional(),
    notes: z.string().nullish(),
  })
  .loose()

// PATCH /api/inventory/service-tickets/:id wire-format. `status` is validated
// against the lifecycle enum by isTicketStatus downstream; the schema only
// rejects a non-string status shape early.
const ServiceTicketPatchBodySchema = z
  .object({
    status: z.string().optional(),
  })
  .loose()

type ServiceTicketRow = {
  id: string
  company_id: string
  inventory_item_id: string
  status: TicketStatus
  opened_at: string
  opened_by: string | null
  completed_at: string | null
  notes: string | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

function rowToTicket(row: ServiceTicketRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    inventory_item_id: row.inventory_item_id,
    status: row.status,
    opened_at: row.opened_at,
    opened_by: row.opened_by,
    completed_at: row.completed_at,
    notes: row.notes,
    tier_origin: row.tier_origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Inventory service tickets (103_inventory_service_tickets.sql):
 *   GET   /api/inventory/service-tickets                list (filter ?item_id= / ?status=)
 *   POST  /api/inventory/service-tickets                open a ticket { inventory_item_id, notes? }
 *   PATCH /api/inventory/service-tickets/:id            { status } advance open→in_service→done
 *
 * Company-scoped via withCompanyClient / withMutationTx (SET LOCAL
 * app.company_id) with parameterized SQL throughout. Mutations are
 * role-gated (admin/office) and audited via the `inventory_service_ticket`
 * allowlist entry. Mirrors apps/api/src/routes/change-orders.ts.
 */
export async function handleInventoryServiceTicketRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: InventoryServiceTicketRouteCtx,
): Promise<boolean> {
  // --- list ----------------------------------------------------------------
  if (url.pathname === '/api/inventory/service-tickets' && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true

    const itemId = url.searchParams.get('item_id')
    if (itemId !== null && !isValidUuid(itemId)) {
      ctx.sendJson(400, { error: 'item_id must be a valid uuid' })
      return true
    }
    const statusFilter = url.searchParams.get('status')
    if (statusFilter !== null && !isTicketStatus(statusFilter)) {
      ctx.sendJson(400, { error: `status must be one of ${TICKET_STATUSES.join(', ')}` })
      return true
    }

    // Build a parameterized WHERE with optional item_id / status filters.
    const params: unknown[] = [ctx.company.id]
    const conditions = ['company_id = $1']
    if (itemId !== null) {
      params.push(itemId)
      conditions.push(`inventory_item_id = $${params.length}`)
    }
    if (statusFilter !== null) {
      params.push(statusFilter)
      conditions.push(`status = $${params.length}`)
    }

    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ServiceTicketRow>(
        `select ${TICKET_COLUMNS} from inventory_service_tickets
         where ${conditions.join(' and ')}
         order by opened_at desc`,
        params,
      ),
    )
    ctx.sendJson(200, { service_tickets: rows.rows.map(rowToTicket) })
    return true
  }

  // --- open a ticket -------------------------------------------------------
  if (url.pathname === '/api/inventory/service-tickets' && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true

    const parsedBody = parseJsonBody(ServiceTicketCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const inventoryItemId = typeof body.inventory_item_id === 'string' ? body.inventory_item_id : ''
    if (!isValidUuid(inventoryItemId)) {
      ctx.sendJson(400, { error: 'inventory_item_id must be a valid uuid' })
      return true
    }
    const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null

    try {
      const created = await withMutationTx(async (client: PoolClient) => {
        const item = await client.query<{ id: string }>(
          `select id from inventory_items where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, inventoryItemId],
        )
        if (!item.rows[0]) return { kind: 'not_found' as const }
        const inserted = await client.query<ServiceTicketRow>(
          `insert into inventory_service_tickets
             (company_id, inventory_item_id, opened_by, notes)
           values ($1, $2, $3, $4)
           returning ${TICKET_COLUMNS}`,
          [ctx.company.id, inventoryItemId, ctx.currentUserId, notes],
        )
        const row = inserted.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: 'inventory_service_ticket.opened',
          entityType: 'inventory_service_ticket',
          entityId: row.id,
          after: { inventory_item_id: row.inventory_item_id, status: row.status },
        })
        return { kind: 'ok' as const, row }
      })
      if (created.kind === 'not_found') {
        ctx.sendJson(404, { error: 'inventory item not found' })
        return true
      }
      ctx.sendJson(201, { service_ticket: rowToTicket(created.row) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to open service ticket' })
    }
    return true
  }

  // --- advance status (open → in_service → done) ---------------------------
  const patchMatch = url.pathname.match(/^\/api\/inventory\/service-tickets\/([^/]+)$/)
  if (patchMatch && req.method === 'PATCH') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = patchMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const parsedBody = parseJsonBody(ServiceTicketPatchBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    if (!isTicketStatus(body.status)) {
      ctx.sendJson(400, { error: `status must be one of ${TICKET_STATUSES.join(', ')}` })
      return true
    }
    const nextStatus = body.status

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const locked = await client.query<ServiceTicketRow>(
          `select ${TICKET_COLUMNS} from inventory_service_tickets
           where company_id = $1 and id = $2 for update`,
          [ctx.company.id, id],
        )
        const current = locked.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.status === nextStatus) {
          // No-op advance — return the unchanged row rather than error.
          return { kind: 'ok' as const, row: current }
        }
        if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
          return {
            kind: 'illegal' as const,
            message: `cannot move service ticket from ${current.status} to ${nextStatus}`,
          }
        }
        // `done` stamps completed_at; advancing back is not possible (linear),
        // so completed_at is only ever set on the done transition.
        const completedAt = nextStatus === 'done' ? new Date().toISOString() : current.completed_at
        const updated = await client.query<ServiceTicketRow>(
          `update inventory_service_tickets set
             status = $3, completed_at = $4, updated_at = now()
           where company_id = $1 and id = $2
           returning ${TICKET_COLUMNS}`,
          [ctx.company.id, id, nextStatus, completedAt],
        )
        const row = updated.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: `inventory_service_ticket.${nextStatus}`,
          entityType: 'inventory_service_ticket',
          entityId: id,
          before: { status: current.status },
          after: { status: row.status },
        })
        return { kind: 'ok' as const, row }
      })
      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'service ticket not found' })
        return true
      }
      if (result.kind === 'illegal') {
        ctx.sendJson(422, { error: result.message })
        return true
      }
      ctx.sendJson(200, { service_ticket: rowToTicket(result.row) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to update service ticket' })
    }
    return true
  }

  return false
}

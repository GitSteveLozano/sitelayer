import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import {
  parseShipmentEventRequest,
  transitionShipmentWorkflow,
  nextShipmentEvents,
  type ShipmentWorkflowEvent,
  type ShipmentWorkflowState,
  type ShipmentWorkflowSnapshot,
} from '@sitelayer/workflows'

/**
 * Shipments — basic CRUD + event-log endpoints. The full reducer (planned
 * → picking → shipped → delivered → returning → closed) will mirror the
 * rental-billing workflow in packages/workflows; this file ships the
 * underlying data surface so the UI and worker can start consuming it.
 *
 * Events are appended to shipment_events whenever status changes via
 * POST /api/shipments/:id/transition. state_version is bumped per event
 * for optimistic concurrency.
 */
export type ShipmentRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const SHIPMENT_COLUMNS = `
  id, company_id, project_id, bom_id, source_branch_id, destination_location_id,
  direction, status, state_version,
  to_char(scheduled_for, 'YYYY-MM-DD') as scheduled_for,
  shipped_at, delivered_at, confirmed_by, driver, ticket_number, notes,
  workflow_engine, workflow_run_id, version, deleted_at, created_at, updated_at
`
const LINE_COLUMNS = `
  id, company_id, shipment_id, inventory_item_id, catalog_part_id, bom_line_id,
  quantity_planned, quantity_shipped, quantity_delivered, quantity_returned,
  quantity_damaged, quantity_lost, notes, created_at, updated_at
`
const EVENT_COLUMNS = `id, company_id, shipment_id, event_type, payload, state_before, state_after, state_version, produced_by, created_at`

function s(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t ? t : null
}
function num(v: unknown): number {
  if (v == null || v === '') return 0
  const p = Number(v)
  return Number.isFinite(p) ? p : 0
}

export async function handleShipmentRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ShipmentRouteCtx,
): Promise<boolean> {
  const projectShipmentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/shipments$/)
  if (req.method === 'GET' && projectShipmentsMatch) {
    const projectId = projectShipmentsMatch[1]!
    const result = await ctx.pool.query(
      `select ${SHIPMENT_COLUMNS} from shipments
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by coalesce(scheduled_for, created_at::date) desc, created_at desc`,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { shipments: result.rows })
    return true
  }
  if (req.method === 'POST' && projectShipmentsMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const projectId = projectShipmentsMatch[1]!
    const body = await ctx.readBody()
    const result = await ctx.pool.query(
      `insert into shipments (
        company_id, project_id, bom_id, source_branch_id, destination_location_id,
        direction, scheduled_for, driver, ticket_number, notes
      ) values ($1, $2, $3, $4, $5, coalesce($6, 'outbound'), $7, $8, $9, $10)
      returning ${SHIPMENT_COLUMNS}`,
      [
        ctx.company.id,
        projectId,
        s(body.bom_id),
        s(body.source_branch_id),
        s(body.destination_location_id),
        s(body.direction),
        s(body.scheduled_for),
        s(body.driver),
        s(body.ticket_number),
        s(body.notes),
      ],
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  const shipmentIdMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)$/)
  if (req.method === 'GET' && shipmentIdMatch) {
    const id = shipmentIdMatch[1]!
    const shipment = await ctx.pool.query(
      `select ${SHIPMENT_COLUMNS} from shipments where company_id = $1 and id = $2 and deleted_at is null`,
      [ctx.company.id, id],
    )
    if (!shipment.rows[0]) {
      ctx.sendJson(404, { error: 'shipment not found' })
      return true
    }
    const lines = await ctx.pool.query(
      `select ${LINE_COLUMNS} from shipment_lines where company_id = $1 and shipment_id = $2 order by created_at asc`,
      [ctx.company.id, id],
    )
    const events = await ctx.pool.query(
      `select ${EVENT_COLUMNS} from shipment_events where company_id = $1 and shipment_id = $2 order by created_at asc`,
      [ctx.company.id, id],
    )
    ctx.sendJson(200, { ...shipment.rows[0], lines: lines.rows, events: events.rows })
    return true
  }

  const linesMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)\/lines$/)
  if (req.method === 'POST' && linesMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const id = linesMatch[1]!
    const body = await ctx.readBody()
    const lines = Array.isArray(body.lines) ? (body.lines as Array<Record<string, unknown>>) : null
    if (!lines || lines.length === 0) {
      ctx.sendJson(400, { error: 'lines[] required' })
      return true
    }
    const inserted = await withMutationTx(async (client: PoolClient) => {
      const rows: unknown[] = []
      for (const line of lines) {
        const inventoryItemId = s(line.inventory_item_id)
        const catalogPartId = s(line.catalog_part_id)
        if ((inventoryItemId && catalogPartId) || (!inventoryItemId && !catalogPartId)) continue
        const quantityPlanned = num(line.quantity_planned)
        if (quantityPlanned <= 0) continue
        const result = await client.query(
          `insert into shipment_lines (
            company_id, shipment_id, inventory_item_id, catalog_part_id, bom_line_id,
            quantity_planned, notes
          ) values ($1, $2, $3, $4, $5, $6, $7) returning ${LINE_COLUMNS}`,
          [ctx.company.id, id, inventoryItemId, catalogPartId, s(line.bom_line_id), quantityPlanned, s(line.notes)],
        )
        rows.push(result.rows[0])
      }
      return rows
    })
    ctx.sendJson(201, { lines: inserted })
    return true
  }

  // Workflow transition routed through the packages/workflows reducer.
  // Endpoint shape mirrors rental-billing: { event, state_version, payload? }.
  // 409 on stale state_version; 400 on illegal transition.
  const transitionMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)\/transition$/)
  if (req.method === 'POST' && transitionMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const id = transitionMatch[1]!
    const body = await ctx.readBody()
    const parsed = parseShipmentEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const result = await withMutationTx(async (client: PoolClient) => {
      const current = await client.query<{
        status: ShipmentWorkflowState
        state_version: number
        scheduled_for: string | null
        shipped_at: string | null
        delivered_at: string | null
        confirmed_by: string | null
        driver: string | null
        ticket_number: string | null
      }>(
        `select status, state_version,
                to_char(scheduled_for, 'YYYY-MM-DD') as scheduled_for,
                shipped_at, delivered_at, confirmed_by, driver, ticket_number
           from shipments
          where company_id = $1 and id = $2 and deleted_at is null
          for update`,
        [ctx.company.id, id],
      )
      if (!current.rows[0]) {
        return { error: 'shipment not found' as const, code: 404 }
      }
      if (current.rows[0].state_version !== parsed.value.state_version) {
        return { error: 'state_version mismatch' as const, code: 409 }
      }
      const snapshot: ShipmentWorkflowSnapshot = {
        state: current.rows[0].status,
        state_version: current.rows[0].state_version,
        scheduled_for: current.rows[0].scheduled_for,
        shipped_at: current.rows[0].shipped_at,
        delivered_at: current.rows[0].delivered_at,
        confirmed_by: current.rows[0].confirmed_by,
        driver: current.rows[0].driver,
        ticket_number: current.rows[0].ticket_number,
      }
      // Synthesize the event variant from the parsed type — the reducer
      // wants fully-typed events, the wire format only carries `event`
      // + optional payload.
      const now = new Date().toISOString()
      const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {}
      let event: ShipmentWorkflowEvent
      switch (parsed.value.event) {
        case 'START_PICKING':
          event = { type: 'START_PICKING' }
          break
        case 'SHIP':
          event = {
            type: 'SHIP',
            shipped_at: typeof payload.shipped_at === 'string' ? payload.shipped_at : now,
            ...(typeof payload.driver === 'string' ? { driver: payload.driver } : {}),
            ...(typeof payload.ticket_number === 'string' ? { ticket_number: payload.ticket_number } : {}),
          }
          break
        case 'CONFIRM_DELIVERY':
          event = {
            type: 'CONFIRM_DELIVERY',
            delivered_at: typeof payload.delivered_at === 'string' ? payload.delivered_at : now,
            confirmed_by: typeof payload.confirmed_by === 'string' ? payload.confirmed_by : ctx.currentUserId,
          }
          break
        case 'OPEN_RETURN':
          event = { type: 'OPEN_RETURN' }
          break
        case 'CLOSE':
          event = {
            type: 'CLOSE',
            confirmed_by: typeof payload.confirmed_by === 'string' ? payload.confirmed_by : ctx.currentUserId,
          }
          break
        case 'VOID':
          event = { type: 'VOID' }
          break
      }
      let nextSnapshot: ShipmentWorkflowSnapshot
      try {
        nextSnapshot = transitionShipmentWorkflow(snapshot, event)
      } catch (err) {
        return { error: err instanceof Error ? err.message : ('illegal transition' as const), code: 400 }
      }
      const updated = await client.query(
        `update shipments
           set status = $3, state_version = $4,
               shipped_at = $5, delivered_at = $6, confirmed_by = $7,
               driver = $8, ticket_number = $9,
               version = version + 1, updated_at = now()
         where company_id = $1 and id = $2
         returning ${SHIPMENT_COLUMNS}`,
        [
          ctx.company.id,
          id,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.shipped_at ?? null,
          nextSnapshot.delivered_at ?? null,
          nextSnapshot.confirmed_by ?? null,
          nextSnapshot.driver ?? null,
          nextSnapshot.ticket_number ?? null,
        ],
      )
      await client.query(
        `insert into shipment_events (
          company_id, shipment_id, event_type, payload, state_before, state_after, state_version, produced_by
        ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          ctx.company.id,
          id,
          parsed.value.event,
          JSON.stringify(payload),
          snapshot.state,
          nextSnapshot.state,
          nextSnapshot.state_version,
          ctx.currentUserId,
        ],
      )
      return { shipment: updated.rows[0], snapshot: nextSnapshot }
    })
    if ('error' in result) {
      ctx.sendJson(result.code ?? 400, { error: result.error })
      return true
    }
    ctx.sendJson(200, {
      ...result.shipment,
      next_events: nextShipmentEvents(result.snapshot.state),
    })
    return true
  }

  return false
}

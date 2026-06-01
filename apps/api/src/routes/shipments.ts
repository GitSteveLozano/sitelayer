import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { observeAudit, observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordAudit } from '../audit.js'
import { recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import {
  parseShipmentEventRequest,
  transitionShipmentWorkflow,
  nextShipmentEvents,
  SHIPMENT_WORKFLOW_NAME,
  SHIPMENT_WORKFLOW_SCHEMA_VERSION,
  type ShipmentHumanEventType,
  type ShipmentWorkflowEvent,
  type ShipmentWorkflowState,
  type ShipmentWorkflowSnapshot,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'

/**
 * Shipments — CRUD + deterministic-workflow surface. The reducer
 * (planned → picking → shipped → delivered → returning → closed | voided)
 * lives in packages/workflows/src/shipment.ts; this file is the thin
 * transactional + HTTP shell around it, mirroring
 * apps/api/src/routes/rental-billing-state.ts:
 *
 *   GET  /api/projects/:id/shipments          → list (company-scoped)
 *   GET  /api/shipments/:id                   → WorkflowSnapshot
 *                                               { state, state_version,
 *                                                 context, next_events }
 *   POST /api/shipments/:id/events            → { event, state_version }
 *                                               applies the reducer in one
 *                                               tx; 409 on stale version or
 *                                               illegal transition.
 *   POST /api/shipments/:id/transition        → legacy alias kept for
 *                                               backward compatibility.
 *
 * Every transition appends to shipment_events (human-readable per-shipment
 * trail) and workflow_event_log (cross-workflow replay corpus) inside the
 * same tx as the state update. state_version is bumped per event for
 * optimistic concurrency.
 */
export type ShipmentRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * Shape of a shipment row selected with SHIPMENT_COLUMNS. Kept local to
 * this module because shipments are not part of the rental-inventory
 * split that owns rental-inventory.types.ts.
 */
type ShipmentRow = {
  id: string
  company_id: string
  project_id: string
  bom_id: string | null
  source_branch_id: string | null
  destination_location_id: string | null
  direction: string
  status: ShipmentWorkflowState
  state_version: number
  scheduled_for: string | null
  shipped_at: string | null
  delivered_at: string | null
  confirmed_by: string | null
  driver: string | null
  ticket_number: string | null
  notes: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type ShipmentLineRow = Record<string, unknown>
type ShipmentEventRow = Record<string, unknown>

/**
 * WorkflowSnapshot context for a shipment. Carries the full shipment row
 * plus its lines and event log so the headless UI can render state +
 * trail + next_events straight from the snapshot, mirroring
 * billingRunWorkflowSnapshotResponse.
 */
type ShipmentWorkflowContext = ShipmentRow & {
  lines: ShipmentLineRow[]
  events: ShipmentEventRow[]
}

function shipmentRowToSnapshot(row: ShipmentRow): ShipmentWorkflowSnapshot {
  return {
    state: row.status,
    state_version: row.state_version,
    scheduled_for: row.scheduled_for,
    shipped_at: row.shipped_at,
    delivered_at: row.delivered_at,
    confirmed_by: row.confirmed_by,
    driver: row.driver,
    ticket_number: row.ticket_number,
  }
}

function shipmentWorkflowSnapshotResponse(
  row: ShipmentRow,
  lines: ShipmentLineRow[],
  events: ShipmentEventRow[],
): WorkflowSnapshot<ShipmentWorkflowState, ShipmentHumanEventType, ShipmentWorkflowContext> {
  return {
    state: row.status,
    state_version: row.state_version,
    context: { ...row, lines, events },
    next_events: nextShipmentEvents(row.status),
  }
}

/**
 * Build a fully-typed reducer event from the human-issued event type +
 * optional wire payload. Centralized so the route stays focused on
 * transactional persistence and the reducer stays the only place where
 * event semantics live (mirrors buildReducerEvent in rental-billing-state).
 */
function buildShipmentReducerEvent(
  eventType: ShipmentHumanEventType,
  payload: Record<string, unknown>,
  actorUserId: string,
): ShipmentWorkflowEvent {
  const now = new Date().toISOString()
  switch (eventType) {
    case 'START_PICKING':
      return { type: 'START_PICKING' }
    case 'SHIP':
      return {
        type: 'SHIP',
        shipped_at: typeof payload.shipped_at === 'string' ? payload.shipped_at : now,
        ...(typeof payload.driver === 'string' ? { driver: payload.driver } : {}),
        ...(typeof payload.ticket_number === 'string' ? { ticket_number: payload.ticket_number } : {}),
      }
    case 'CONFIRM_DELIVERY':
      return {
        type: 'CONFIRM_DELIVERY',
        delivered_at: typeof payload.delivered_at === 'string' ? payload.delivered_at : now,
        confirmed_by: typeof payload.confirmed_by === 'string' ? payload.confirmed_by : actorUserId,
      }
    case 'OPEN_RETURN':
      return { type: 'OPEN_RETURN' }
    case 'CLOSE':
      return {
        type: 'CLOSE',
        confirmed_by: typeof payload.confirmed_by === 'string' ? payload.confirmed_by : actorUserId,
      }
    case 'VOID':
      return { type: 'VOID' }
  }
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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${SHIPMENT_COLUMNS} from shipments
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by coalesce(scheduled_for, created_at::date) desc, created_at desc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { shipments: result.rows })
    return true
  }
  if (req.method === 'POST' && projectShipmentsMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const projectId = projectShipmentsMatch[1]!
    const body = await ctx.readBody()
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
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
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  const shipmentIdMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)$/)
  if (req.method === 'GET' && shipmentIdMatch) {
    const id = shipmentIdMatch[1]!
    const shipment = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ShipmentRow>(
        `select ${SHIPMENT_COLUMNS} from shipments where company_id = $1 and id = $2 and deleted_at is null`,
        [ctx.company.id, id],
      ),
    )
    const row = shipment.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'shipment not found' })
      return true
    }
    const lines = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ShipmentLineRow>(
        `select ${LINE_COLUMNS} from shipment_lines where company_id = $1 and shipment_id = $2 order by created_at asc`,
        [ctx.company.id, id],
      ),
    )
    const events = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ShipmentEventRow>(
        `select ${EVENT_COLUMNS} from shipment_events where company_id = $1 and shipment_id = $2 order by created_at asc`,
        [ctx.company.id, id],
      ),
    )
    // WorkflowSnapshot envelope { state, state_version, context, next_events }
    // — see rental-billing-state.ts / docs/DETERMINISTIC_WORKFLOWS.md. The
    // context carries the full shipment row + lines + events so the headless
    // UI renders everything straight from the snapshot.
    ctx.sendJson(200, shipmentWorkflowSnapshotResponse(row, lines.rows, events.rows))
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

  // Canonical deterministic-workflow event surface. Mirrors
  // POST /api/rental-billing-runs/:id/events exactly: one tx, lock the row,
  // post-lock optimistic version check (409 on stale), run the pure reducer
  // (409 on illegal transition), persist state_version + 1, append the
  // human-readable shipment_events row AND the workflow_event_log replay
  // row, then audit + metrics outside the tx. Returns the fresh
  // WorkflowSnapshot so the client doesn't need a follow-up GET.
  const eventsMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventsMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const id = eventsMatch[1]!
    const body = await ctx.readBody()
    const parsed = parseShipmentEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const eventType = parsed.value.event
    const stateVersion = parsed.value.state_version
    const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {}

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<ShipmentRow>(
          `select ${SHIPMENT_COLUMNS} from shipments
            where company_id = $1 and id = $2 and deleted_at is null
            for update`,
          [ctx.company.id, id],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        // Post-lock version check: two concurrent POSTs with the same
        // stateVersion serialize on the row lock above; the second arrival
        // sees the bumped state_version and returns 409 instead of
        // re-running the reducer. Same pattern as rental-billing-state.
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, row: current }
        }

        const reducerEvent = buildShipmentReducerEvent(eventType, payload, ctx.currentUserId)
        let nextSnapshot: ShipmentWorkflowSnapshot
        try {
          nextSnapshot = transitionShipmentWorkflow(shipmentRowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            row: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<ShipmentRow>(
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
        const updated = updateResult.rows[0]
        if (!updated) throw new Error('shipment update returned no row')

        // shipment_events keeps the human-readable per-shipment audit
        // trail (state_before/state_after); workflow_event_log is the
        // cross-workflow replay corpus. Both write inside the same tx as
        // the state update so a crash between them is impossible.
        await client.query(
          `insert into shipment_events (
            company_id, shipment_id, event_type, payload, state_before, state_after, state_version, produced_by
          ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
          [
            ctx.company.id,
            id,
            eventType,
            JSON.stringify(payload),
            current.status,
            nextSnapshot.state,
            nextSnapshot.state_version,
            ctx.currentUserId,
          ],
        )
        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: SHIPMENT_WORKFLOW_NAME,
          schemaVersion: SHIPMENT_WORKFLOW_SCHEMA_VERSION,
          entityType: 'shipment',
          entityId: id,
          // state_version BEFORE the transition — matches the unique
          // (entity_id, state_version) convention enforced on
          // workflow_event_log (see 020_workflow_event_log).
          stateVersion: stateVersion,
          eventType,
          eventPayload: reducerEvent,
          snapshotAfter: nextSnapshot,
          actorUserId: ctx.currentUserId,
        })

        const lines = await client.query<ShipmentLineRow>(
          `select ${LINE_COLUMNS} from shipment_lines where company_id = $1 and shipment_id = $2 order by created_at asc`,
          [ctx.company.id, id],
        )
        const eventsRows = await client.query<ShipmentEventRow>(
          `select ${EVENT_COLUMNS} from shipment_events where company_id = $1 and shipment_id = $2 order by created_at asc`,
          [ctx.company.id, id],
        )
        return { kind: 'ok' as const, row: updated, lines: lines.rows, events: eventsRows.rows }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'shipment not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: shipmentWorkflowSnapshotResponse(result.row, [], []),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: result.message,
          snapshot: shipmentWorkflowSnapshotResponse(result.row, [], []),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'shipment',
        entityId: result.row.id,
        action: `event:${eventType.toLowerCase()}`,
        after: result.row,
      })
      observeAudit('shipment', `event:${eventType.toLowerCase()}`)
      const outcome = workflowEventOutcome(eventType)
      if (outcome) observeWorkflowEvent(SHIPMENT_WORKFLOW_NAME, outcome)
      ctx.sendJson(200, shipmentWorkflowSnapshotResponse(result.row, result.lines, result.events))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
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
      if (current.rows[0].state_version !== parsed.value.state_version) {
        return {
          error: 'state_version mismatch — reload and retry' as const,
          code: 409,
          snapshot,
        }
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
      // shipment_events keeps the human-readable per-shipment audit
      // trail (state_before/state_after); workflow_event_log is the
      // cross-workflow replay corpus consumed by scripts/replay-workflow.ts
      // and the periodic sweep. Both write inside the same tx as the
      // state update, so a crash between them is impossible.
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
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: SHIPMENT_WORKFLOW_NAME,
        schemaVersion: SHIPMENT_WORKFLOW_SCHEMA_VERSION,
        entityType: 'shipment',
        entityId: id,
        // state_version BEFORE the transition — matches the convention
        // used by rental_billing_state (see comment on the unique
        // (entity_id, workflow_name, state_version) constraint — added in
        // 020_workflow_event_log, widened in 106).
        stateVersion: snapshot.state_version,
        eventType: parsed.value.event,
        eventPayload: event,
        snapshotAfter: nextSnapshot,
        actorUserId: ctx.currentUserId,
      })
      const outcome = workflowEventOutcome(parsed.value.event)
      if (outcome) observeWorkflowEvent(SHIPMENT_WORKFLOW_NAME, outcome)
      return { shipment: updated.rows[0], snapshot: nextSnapshot }
    })
    if ('error' in result) {
      const body: Record<string, unknown> = { error: result.error }
      if ('snapshot' in result && result.snapshot) {
        body.snapshot = result.snapshot
      }
      ctx.sendJson(result.code ?? 400, body)
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

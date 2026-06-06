import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { RENTAL_SELECT_COLUMNS, type RentalRow } from '@sitelayer/queue'
import {
  nextRentalEvents,
  parseRentalEventRequest,
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalWorkflow,
  type RentalHumanEventType,
  type RentalWorkflowEvent,
  type RentalWorkflowSnapshot,
  type RentalWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { recordAudit } from '../audit.js'
import { HttpError, isValidUuid } from '../http-utils.js'
import { observeAudit, observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'

// ---------------------------------------------------------------------------
// Rental workflow event-API surface — completes Phase 2 of the rental
// deterministic workflow. The reducer + replay sweep were registered in
// Phase 1 (see packages/workflows/src/rental.ts). This module adds the
// canonical event-API routes that mirror rental-billing-state.ts,
// crew-schedule-events.ts, time-review-runs.ts, etc.:
//
//   GET  /api/rentals/:id          → WorkflowSnapshot
//                                    { state, state_version, context, next_events }
//   POST /api/rentals/:id/events   → { event, state_version }
//                                    applies the reducer in one tx and
//                                    persists the new snapshot.
//
// The pre-existing POST /api/rentals/:id/return route (in routes/rentals.ts)
// stays as-is for back-compat: it dispatches the RETURN reducer event AND
// writes the damage-reconciliation columns (qty_good/qty_damaged/qty_lost/
// damage_photos/damage_charges_cents) in the same tx. New "manual close
// rental" UI surfaces should use POST /api/rentals/:id/events with
// `{ event: 'CLOSE' }`.
//
// Worker-only events (INVOICE_QUEUED, INVOICE_POSTED) remain rejected by
// parseRentalEventRequest. They continue to flow through the worker's
// rental-invoice runner. A later cycle can lift these into the event-API
// surface once a worker-only dispatch token exists.
// ---------------------------------------------------------------------------

export type RentalEventRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type RentalRowWithState = RentalRow & {
  state_version: number
  returned_at: string | null
  returned_by: string | null
  closed_at: string | null
  closed_by: string | null
}

const RENTAL_EVENT_COLUMNS = `${RENTAL_SELECT_COLUMNS}, state_version, returned_at, returned_by, closed_at, closed_by`

function rowToSnapshot(row: RentalRowWithState): RentalWorkflowSnapshot {
  return {
    state: (row.status as RentalWorkflowState) ?? 'active',
    state_version: row.state_version ?? 1,
    returned_at: row.returned_at ?? null,
    returned_by: row.returned_by ?? null,
    closed_at: row.closed_at ?? null,
    closed_by: row.closed_by ?? null,
  }
}

function snapshotResponse(row: RentalRowWithState): {
  state: RentalWorkflowState
  state_version: number
  context: Omit<RentalRowWithState, 'status' | 'state_version'>
  next_events: ReturnType<typeof nextRentalEvents>
} {
  const { status, state_version, ...rest } = row
  // Preserve `status` in context for SPA back-compat — same convention as
  // crew-schedule-events.ts. The reducer-canonical view is `state`, but
  // existing rental UI reads `context.status`.
  const context = { ...rest, status } as Omit<RentalRowWithState, 'status' | 'state_version'>
  return {
    state: status as RentalWorkflowState,
    state_version,
    context,
    next_events: nextRentalEvents(status as RentalWorkflowState),
  }
}

function buildReducerEvent(eventType: RentalHumanEventType, actorUserId: string): RentalWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'RETURN') {
    return { type: 'RETURN', returned_at: nowIso, returned_by: actorUserId }
  }
  return { type: 'CLOSE', closed_at: nowIso, closed_by: actorUserId }
}

/**
 * Handle rental workflow event-API routes. Returns true when the route was
 * matched and the response sent; false to let downstream dispatchers try.
 *
 * Wire this BEFORE handleRentalRoutes in dispatch.ts so the workflow
 * surface short-circuits the generic PATCH/DELETE routes for the
 * snapshot/events paths.
 */
export async function handleRentalEventRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalEventRouteCtx,
): Promise<boolean> {
  // GET /api/rentals/:id — workflow snapshot. The list path
  // (GET /api/rentals) is handled in routes/rentals.ts.
  const detailMatch = url.pathname.match(/^\/api\/rentals\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalRowWithState>(
        `select ${RENTAL_EVENT_COLUMNS}
         from rentals
         where company_id = $1 and id = $2 and deleted_at is null
         limit 1`,
        [ctx.company.id, id],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'rental not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(row))
    return true
  }

  // POST /api/rentals/:id/events — apply a workflow event.
  const eventMatch = url.pathname.match(/^\/api\/rentals\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseRentalEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion } = parsed.value

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<RentalRowWithState>(
          `select ${RENTAL_EVENT_COLUMNS}
           from rentals
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, id],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        // Post-lock version check — see rental-billing-state.ts comment.
        // The workflow_event_log UNIQUE (entity_id, workflow_name, state_version)
        // (migration 106) is a belt-and-braces backstop if a future caller
        // forgets it.
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, row: current }
        }

        const reducerEvent = buildReducerEvent(eventType as RentalHumanEventType, ctx.currentUserId)
        let nextSnapshot: RentalWorkflowSnapshot
        try {
          nextSnapshot = transitionRentalWorkflow(rowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            row: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<RentalRowWithState>(
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
           returning ${RENTAL_EVENT_COLUMNS}`,
          [
            ctx.company.id,
            id,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.returned_at ?? null,
            nextSnapshot.returned_by ?? null,
            nextSnapshot.closed_at ?? null,
            nextSnapshot.closed_by ?? null,
          ],
        )
        const updated = updateResult.rows[0]
        if (!updated) throw new HttpError(500, 'rental update returned no row')

        // Append-only workflow_event_log row in the same tx. Replay corpus
        // for regression testing — feeding the event log back through the
        // reducer must reproduce the persisted snapshot. UNIQUE
        // (entity_id, state_version) prevents duplicate writes if a retry
        // replays this transition.
        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: RENTAL_WORKFLOW_NAME,
          schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
          entityType: 'rental',
          entityId: updated.id,
          stateVersion,
          eventType,
          eventPayload: reducerEvent,
          snapshotAfter: nextSnapshot,
          actorUserId: ctx.currentUserId,
        })
        // Audit/event ledger row keyed on state_version so each transition
        // produces a distinct row (history-friendly).
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'rental',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          idempotencyKey: `rental:event:${updated.id}:${updated.state_version}`,
        })
        return { kind: 'ok' as const, row: updated, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'rental not found' })
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
        ctx.sendJson(409, {
          error: result.message,
          snapshot: snapshotResponse(result.row),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'rental',
        entityId: result.row.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.row,
      })
      observeAudit('rental', `event:${result.eventType.toLowerCase()}`)
      const outcome = workflowEventOutcome(result.eventType)
      if (outcome) observeWorkflowEvent(RENTAL_WORKFLOW_NAME, outcome)
      ctx.sendJson(200, snapshotResponse(result.row))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}

import type http from 'node:http'
import type { PoolClient } from 'pg'
import {
  parseRentalBillingEventRequest,
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  transitionRentalBillingWorkflow,
  type RentalBillingHumanEventType,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
} from '@sitelayer/workflows'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'
import {
  RENTAL_BILLING_RUN_COLUMNS,
  RENTAL_BILLING_RUN_LINE_COLUMNS,
  billingRunRowToSnapshot,
  billingRunWorkflowSnapshotResponse,
  type RentalBillingRunLineRow,
  type RentalBillingRunRow,
  type RentalInventoryRouteCtx,
} from './rental-inventory.types.js'

// ---------------------------------------------------------------------------
// Rental billing run workflow surface — see docs/DETERMINISTIC_WORKFLOWS.md.
//
// GET  /api/rental-billing-runs                 → list (company-scoped),
//                                                 optional ?state=...
// GET  /api/rental-billing-runs/:id             → WorkflowSnapshot
// POST /api/rental-billing-runs/:id/events      → { event, stateVersion }
//                                                 applies the reducer in
//                                                 one tx.
// ---------------------------------------------------------------------------

/**
 * Build a reducer-ready event from a human-issued event type. Centralized so
 * the route can stay focused on transactional persistence and the reducer
 * stays the only place where event semantics live.
 */
function buildReducerEvent(eventType: RentalBillingHumanEventType, actorUserId: string): RentalBillingWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'APPROVE') {
    return { type: 'APPROVE', approved_at: nowIso, approved_by: actorUserId }
  }
  if (eventType === 'POST_REQUESTED') {
    return { type: 'POST_REQUESTED' }
  }
  if (eventType === 'RETRY_POST') {
    return { type: 'RETRY_POST' }
  }
  return { type: 'VOID' }
}

/**
 * Handle the rental billing workflow surface — list, snapshot, and event
 * application. Wired into the queue indirectly: the `POST_REQUESTED`
 * transition enqueues a stable-keyed `mutation_outbox` row that the worker's
 * QBO-push handler claims.
 */
export async function handleRentalBillingStateRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/rental-billing-runs') {
    const stateFilter = url.searchParams.get('state')
    const allowedStates = ['generated', 'approved', 'posting', 'posted', 'failed', 'voided']
    const params: unknown[] = [ctx.company.id]
    let where = `company_id = $1 and deleted_at is null`
    if (stateFilter && allowedStates.includes(stateFilter)) {
      params.push(stateFilter)
      where += ` and status = $${params.length}`
    }
    const runs = await ctx.pool.query<RentalBillingRunRow>(
      `select ${RENTAL_BILLING_RUN_COLUMNS}
       from rental_billing_runs
       where ${where}
       order by period_end desc, created_at desc
       limit 200`,
      params,
    )
    ctx.sendJson(200, { billingRuns: runs.rows })
    return true
  }

  const billingRunSnapshotMatch = url.pathname.match(/^\/api\/rental-billing-runs\/([^/]+)$/)
  if (req.method === 'GET' && billingRunSnapshotMatch) {
    const runId = billingRunSnapshotMatch[1]!
    const runResult = await ctx.pool.query<RentalBillingRunRow>(
      `select ${RENTAL_BILLING_RUN_COLUMNS}
       from rental_billing_runs
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, runId],
    )
    const run = runResult.rows[0]
    if (!run) {
      ctx.sendJson(404, { error: 'rental billing run not found' })
      return true
    }
    const linesResult = await ctx.pool.query<RentalBillingRunLineRow>(
      `select ${RENTAL_BILLING_RUN_LINE_COLUMNS}
       from rental_billing_run_lines
       where company_id = $1 and billing_run_id = $2
       order by created_at asc`,
      [ctx.company.id, runId],
    )
    ctx.sendJson(200, billingRunWorkflowSnapshotResponse(run, linesResult.rows))
    return true
  }

  const billingRunEventMatch = url.pathname.match(/^\/api\/rental-billing-runs\/([^/]+)\/events$/)
  if (req.method === 'POST' && billingRunEventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const runId = billingRunEventMatch[1]!
    const body = await ctx.readBody()
    const parsed = parseRentalBillingEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion } = parsed.value

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<RentalBillingRunRow>(
          `select ${RENTAL_BILLING_RUN_COLUMNS}
           from rental_billing_runs
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, runId],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, run: current }
        }

        const reducerEvent = buildReducerEvent(eventType as RentalBillingHumanEventType, ctx.currentUserId)
        let nextSnapshot: RentalBillingWorkflowSnapshot
        try {
          nextSnapshot = transitionRentalBillingWorkflow(billingRunRowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            run: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<RentalBillingRunRow>(
          `update rental_billing_runs
             set status = $3,
                 state_version = $4,
                 approved_at = $5,
                 approved_by = $6,
                 posted_at = $7,
                 failed_at = $8,
                 error = $9,
                 qbo_invoice_id = $10,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${RENTAL_BILLING_RUN_COLUMNS}`,
          [
            ctx.company.id,
            runId,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.approved_at ?? null,
            nextSnapshot.approved_by ?? null,
            nextSnapshot.posted_at ?? null,
            nextSnapshot.failed_at ?? null,
            nextSnapshot.error ?? null,
            nextSnapshot.qbo_invoice_id ?? null,
          ],
        )
        const updated = updateResult.rows[0]!
        const linesResult = await client.query<RentalBillingRunLineRow>(
          `select ${RENTAL_BILLING_RUN_LINE_COLUMNS}
           from rental_billing_run_lines
           where company_id = $1 and billing_run_id = $2
           order by created_at asc`,
          [ctx.company.id, runId],
        )
        // Append-only workflow event log row in the same tx as the state
        // update. Replay corpus for regression testing — feeding the
        // event log back through the reducer must reproduce the persisted
        // snapshot. Unique (entity_id, state_version) prevents duplicate
        // writes if a retry replays this transition.
        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: RENTAL_BILLING_WORKFLOW_NAME,
          schemaVersion: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
          entityType: 'rental_billing_run',
          entityId: updated.id,
          stateVersion: stateVersion,
          eventType,
          eventPayload: reducerEvent as unknown as Record<string, unknown>,
          snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
          actorUserId: ctx.currentUserId,
        })
        // Audit/event ledger row keyed on state_version so each transition
        // produces a distinct row (history-friendly).
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'rental_billing_run',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          idempotencyKey: `rental_billing_run:event:${updated.id}:${updated.state_version}`,
        })
        // POST_REQUESTED additionally enqueues a stable-keyed outbox row that
        // the worker QBO-push handler claims. The key is per-run (NOT per
        // state_version) so RETRY_POST → POST_REQUESTED replays the same key
        // and the row's `on conflict do update` resets it to pending without
        // creating duplicate work.
        if (eventType === 'POST_REQUESTED') {
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'rental_billing_run',
            entityId: updated.id,
            action: 'post_qbo_invoice',
            mutationType: 'post_qbo_invoice',
            row: updated,
            outboxPayload: {
              billing_run_id: updated.id,
              contract_id: updated.contract_id,
              project_id: updated.project_id,
              customer_id: updated.customer_id,
              period_start: updated.period_start,
              period_end: updated.period_end,
              subtotal: updated.subtotal,
              lines: linesResult.rows,
            },
            idempotencyKey: `rental_billing_run:post:${updated.id}`,
          })
        }
        return { kind: 'ok' as const, run: updated, lines: linesResult.rows, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'rental billing run not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: billingRunWorkflowSnapshotResponse(result.run, []),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: result.message,
          snapshot: billingRunWorkflowSnapshotResponse(result.run, []),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'rental_billing_run',
        entityId: result.run.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.run,
      })
      observeAudit('rental_billing_run', `event:${result.eventType.toLowerCase()}`)
      ctx.sendJson(200, billingRunWorkflowSnapshotResponse(result.run, result.lines))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}

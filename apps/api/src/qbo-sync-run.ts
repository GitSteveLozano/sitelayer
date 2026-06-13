/**
 * `qbo_sync_runs` workflow plumbing. The route is currently acting as
 * the worker (sync work runs inline on the request path), so the route
 * dispatches the same START_SYNC / SYNC_SUCCEEDED / SYNC_FAILED events
 * the worker would. The reducer in `@sitelayer/workflows` is the
 * authoritative state machine; `integration_connections.status` is a
 * derived cache.
 */
import type { PoolClient } from 'pg'
import {
  QBO_SYNC_RUN_WORKFLOW_NAME,
  QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
  nextQboSyncRunEvents,
  transitionQboSyncRunWorkflow,
  type QboSyncRunHumanEventType,
  type QboSyncRunWorkflowEvent,
  type QboSyncRunWorkflowSnapshot,
  type QboSyncRunWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'
import { HttpError } from './http-utils.js'
import { observeWorkflowEvent } from './metrics.js'
import { recordMutationOutbox, recordWorkflowEvent } from './mutation-tx.js'
import { dispatchWorkflowEvent } from './workflow-dispatch.js'

export type QboSyncRunRow = {
  id: string
  company_id: string
  integration_connection_id: string
  status: QboSyncRunWorkflowState
  state_version: number
  started_at: string | null
  succeeded_at: string | null
  failed_at: string | null
  retried_at: string | null
  error: string | null
  snapshot: Record<string, unknown> | null
  triggered_by: string | null
  created_at?: string | null
}

/** Columns selected for every snapshot/list read so the response shape
 *  matches `rowToQboSyncRunSnapshot`. */
export const QBO_SYNC_RUN_COLUMNS = `id, company_id, integration_connection_id, status, state_version,
  started_at, succeeded_at, failed_at, retried_at, error, snapshot, triggered_by, created_at`

/**
 * Map a persisted `qbo_sync_runs` row to the pure reducer snapshot. The
 * row's `status` column IS the workflow state; the timestamp/error/snapshot
 * columns are the workflow context. Defined once so the GET snapshot route
 * and the POST events route agree on the shape.
 */
export function rowToQboSyncRunSnapshot(row: QboSyncRunRow): QboSyncRunWorkflowSnapshot {
  return {
    state: row.status,
    state_version: row.state_version,
    started_at: row.started_at,
    succeeded_at: row.succeeded_at,
    failed_at: row.failed_at,
    retried_at: row.retried_at,
    error: row.error,
    snapshot: row.snapshot,
    triggered_by: row.triggered_by,
  }
}

/**
 * Build the canonical `{ state, state_version, context, next_events }`
 * envelope for a `qbo_sync_runs` row. `next_events` is ALWAYS computed
 * from the registered reducer's `nextQboSyncRunEvents(state)` so the UI
 * cannot invent a transition the machine doesn't allow.
 */
export function qboSyncRunSnapshotResponse(
  row: QboSyncRunRow,
): WorkflowSnapshot<QboSyncRunWorkflowState, QboSyncRunHumanEventType, QboSyncRunRow> {
  return {
    state: row.status,
    state_version: row.state_version,
    context: row,
    next_events: nextQboSyncRunEvents(row.status),
  }
}

/**
 * Create a `qbo_sync_runs` row in state='pending' and immediately
 * dispatch START_SYNC through the reducer (pending → syncing). Both
 * happen in the same tx so the workflow_event_log audit anchor lands
 * with the row.
 *
 * Mirrors the rentals.ts pattern: read locked snapshot, run pure
 * reducer, UPDATE row + state_version, append workflow_event_log,
 * keyed on the prior state_version.
 */
export async function startQboSyncRun(
  client: PoolClient,
  args: {
    companyId: string
    integrationConnectionId: string
    triggeredBy: string
  },
): Promise<{ run: QboSyncRunRow; snapshot: QboSyncRunWorkflowSnapshot }> {
  const created = await client.query<QboSyncRunRow>(
    `insert into qbo_sync_runs (
       company_id, integration_connection_id, status, state_version, triggered_by
     ) values ($1, $2, 'pending', 1, $3)
     returning id, company_id, integration_connection_id, status, state_version,
               started_at, succeeded_at, failed_at, retried_at,
               error, snapshot, triggered_by`,
    [args.companyId, args.integrationConnectionId, args.triggeredBy],
  )
  const pendingRow = created.rows[0]
  if (!pendingRow) throw new HttpError(500, 'qbo sync run insert returned no row')
  const currentSnapshot: QboSyncRunWorkflowSnapshot = {
    state: 'pending',
    state_version: pendingRow.state_version,
    started_at: null,
    succeeded_at: null,
    failed_at: null,
    retried_at: null,
    error: null,
    snapshot: null,
    triggered_by: pendingRow.triggered_by,
  }
  const nowIso = new Date().toISOString()
  const startEvent: QboSyncRunWorkflowEvent = {
    type: 'START_SYNC',
    started_at: nowIso,
    triggered_by: args.triggeredBy,
  }
  const nextSnapshot = transitionQboSyncRunWorkflow(currentSnapshot, startEvent)
  const updated = await client.query<QboSyncRunRow>(
    `update qbo_sync_runs
       set status = $3,
           state_version = $4,
           started_at = $5,
           error = null,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning id, company_id, integration_connection_id, status, state_version,
               started_at, succeeded_at, failed_at, retried_at,
               error, snapshot, triggered_by`,
    [args.companyId, pendingRow.id, nextSnapshot.state, nextSnapshot.state_version, nextSnapshot.started_at],
  )
  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: QBO_SYNC_RUN_WORKFLOW_NAME,
    schemaVersion: QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
    entityType: 'qbo_sync_run',
    entityId: pendingRow.id,
    stateVersion: currentSnapshot.state_version,
    eventType: 'START_SYNC',
    eventPayload: startEvent,
    snapshotAfter: nextSnapshot,
    actorUserId: args.triggeredBy,
  })
  // Side effect anchor: this START_SYNC triggered an actual sync attempt.
  await recordMutationOutbox(
    args.companyId,
    'qbo_sync_run',
    pendingRow.id,
    'run_qbo_sync',
    { qbo_sync_run_id: pendingRow.id, integration_connection_id: args.integrationConnectionId },
    `qbo_sync_run:run:${pendingRow.id}`,
    'server',
    args.triggeredBy,
    client,
  )
  observeWorkflowEvent(QBO_SYNC_RUN_WORKFLOW_NAME, 'requested')
  const updatedRow = updated.rows[0]
  if (!updatedRow) throw new HttpError(500, 'qbo sync run update returned no row')
  return { run: updatedRow, snapshot: nextSnapshot }
}

/**
 * Dispatch SYNC_SUCCEEDED on a syncing qbo_sync_runs row in the same
 * tx as the integration_connections status flip. Reducer asserts
 * syncing → succeeded. SYNC_SUCCEEDED is worker-only at the event
 * endpoint; here we're emitting it INSIDE the inline-sync route so the
 * route is effectively acting as the worker until we move the actual
 * sync work off the request path.
 */
export async function completeQboSyncRunSuccess(
  client: PoolClient,
  args: {
    companyId: string
    runId: string
    snapshot: Record<string, unknown>
    triggeredBy: string
  },
): Promise<void> {
  const locked = await client.query<QboSyncRunRow>(
    `select id, company_id, integration_connection_id, status, state_version,
            started_at, succeeded_at, failed_at, retried_at,
            error, snapshot, triggered_by
       from qbo_sync_runs
       where company_id = $1 and id = $2
       for update`,
    [args.companyId, args.runId],
  )
  const current = locked.rows[0]
  if (!current) return
  const currentSnapshot: QboSyncRunWorkflowSnapshot = {
    state: current.status,
    state_version: current.state_version,
    started_at: current.started_at,
    succeeded_at: current.succeeded_at,
    failed_at: current.failed_at,
    retried_at: current.retried_at,
    error: current.error,
    snapshot: current.snapshot,
    triggered_by: current.triggered_by,
  }
  const nowIso = new Date().toISOString()
  const event: QboSyncRunWorkflowEvent = {
    type: 'SYNC_SUCCEEDED',
    succeeded_at: nowIso,
    snapshot: args.snapshot,
  }
  const nextSnapshot = transitionQboSyncRunWorkflow(currentSnapshot, event)
  await client.query(
    `update qbo_sync_runs
       set status = $3,
           state_version = $4,
           succeeded_at = $5,
           snapshot = $6::jsonb,
           error = null,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2`,
    [
      args.companyId,
      args.runId,
      nextSnapshot.state,
      nextSnapshot.state_version,
      nextSnapshot.succeeded_at,
      JSON.stringify(nextSnapshot.snapshot ?? {}),
    ],
  )
  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: QBO_SYNC_RUN_WORKFLOW_NAME,
    schemaVersion: QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
    entityType: 'qbo_sync_run',
    entityId: args.runId,
    stateVersion: currentSnapshot.state_version,
    eventType: 'SYNC_SUCCEEDED',
    eventPayload: event,
    snapshotAfter: nextSnapshot,
    actorUserId: args.triggeredBy,
  })
  observeWorkflowEvent(QBO_SYNC_RUN_WORKFLOW_NAME, 'succeeded')
}

/**
 * Dispatch SYNC_FAILED on a syncing qbo_sync_runs row in the same tx
 * as the integration_connections status flip. Reducer asserts
 * syncing → failed (and `failed` is non-terminal — a future RETRY
 * brings it back).
 */
export async function completeQboSyncRunFailure(
  client: PoolClient,
  args: {
    companyId: string
    runId: string
    error: string
    triggeredBy: string
  },
): Promise<void> {
  const locked = await client.query<QboSyncRunRow>(
    `select id, company_id, integration_connection_id, status, state_version,
            started_at, succeeded_at, failed_at, retried_at,
            error, snapshot, triggered_by
       from qbo_sync_runs
       where company_id = $1 and id = $2
       for update`,
    [args.companyId, args.runId],
  )
  const current = locked.rows[0]
  if (!current) return
  const currentSnapshot: QboSyncRunWorkflowSnapshot = {
    state: current.status,
    state_version: current.state_version,
    started_at: current.started_at,
    succeeded_at: current.succeeded_at,
    failed_at: current.failed_at,
    retried_at: current.retried_at,
    error: current.error,
    snapshot: current.snapshot,
    triggered_by: current.triggered_by,
  }
  const nowIso = new Date().toISOString()
  const event: QboSyncRunWorkflowEvent = {
    type: 'SYNC_FAILED',
    failed_at: nowIso,
    error: args.error,
  }
  const nextSnapshot = transitionQboSyncRunWorkflow(currentSnapshot, event)
  await client.query(
    `update qbo_sync_runs
       set status = $3,
           state_version = $4,
           failed_at = $5,
           error = $6,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2`,
    [
      args.companyId,
      args.runId,
      nextSnapshot.state,
      nextSnapshot.state_version,
      nextSnapshot.failed_at,
      nextSnapshot.error,
    ],
  )
  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: QBO_SYNC_RUN_WORKFLOW_NAME,
    schemaVersion: QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
    entityType: 'qbo_sync_run',
    entityId: args.runId,
    stateVersion: currentSnapshot.state_version,
    eventType: 'SYNC_FAILED',
    eventPayload: event,
    snapshotAfter: nextSnapshot,
    actorUserId: args.triggeredBy,
  })
  observeWorkflowEvent(QBO_SYNC_RUN_WORKFLOW_NAME, 'failed')
}

export type QboSyncRunDispatchResult =
  | { kind: 'ok'; row: QboSyncRunRow; snapshot: QboSyncRunWorkflowSnapshot }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; row: QboSyncRunRow; snapshot: QboSyncRunWorkflowSnapshot }
  | { kind: 'illegal_transition'; row: QboSyncRunRow; snapshot: QboSyncRunWorkflowSnapshot; message: string }

/**
 * Apply one human-issued event (`RETRY` | `START_SYNC`) to a
 * `qbo_sync_runs` row inside `client`'s transaction. Mirrors the
 * rental-billing `/events` route: lock the row, post-lock optimistic
 * `state_version` check (409), run the pure reducer (409 on illegal),
 * persist `status/state_version/version+1` + the transition columns,
 * append the `workflow_event_log` row keyed on the prior version.
 *
 * `RETRY` (failed → retrying) and the subsequent `START_SYNC`
 * (retrying → syncing) BOTH re-emit the `run_qbo_sync` outbox row keyed
 * `qbo_sync_run:run:<id>` so the worker drain re-attempts the sync
 * against the SAME run row instead of minting a fresh one. The stable
 * per-run key means the outbox `on conflict` resets the row to pending
 * without duplicating work.
 *
 * Worker-only events (`SYNC_SUCCEEDED` / `SYNC_FAILED`) are rejected at
 * the route boundary by `parseQboSyncRunEventRequest`, so only the two
 * human events reach here.
 */
export async function dispatchQboSyncRunHumanEvent(
  client: PoolClient,
  args: {
    companyId: string
    runId: string
    eventType: QboSyncRunHumanEventType
    expectedStateVersion: number
    actorUserId: string
  },
): Promise<QboSyncRunDispatchResult> {
  // Routed through the SAME dispatch primitive the human workflow-event routes
  // use (this used to hand-roll the lock → version-check → reduce → persist →
  // recordWorkflowEvent → outbox pipeline inline). The primitive owns the
  // event-log append the replay harness regression-tests, so this human
  // dispatcher can't silently forget it. The route-as-worker system events
  // (START_SYNC genesis, SYNC_SUCCEEDED/FAILED) below still append directly —
  // they are not human-event dispatches.
  const nowIso = new Date().toISOString()
  const result = await dispatchWorkflowEvent<QboSyncRunRow, QboSyncRunWorkflowSnapshot, QboSyncRunWorkflowEvent>(
    client,
    {
      definition: {
        name: QBO_SYNC_RUN_WORKFLOW_NAME,
        schemaVersion: QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
        reduce: transitionQboSyncRunWorkflow,
      },
      companyId: args.companyId,
      entityType: 'qbo_sync_run',
      entityId: args.runId,
      expectedStateVersion: args.expectedStateVersion,
      actorUserId: args.actorUserId,
      loadSnapshot: async (c) => {
        const locked = await c.query<QboSyncRunRow>(
          `select ${QBO_SYNC_RUN_COLUMNS}
             from qbo_sync_runs
             where company_id = $1 and id = $2 and deleted_at is null
             for update`,
          [args.companyId, args.runId],
        )
        const current = locked.rows[0]
        if (!current) return null
        return { row: current, snapshot: rowToQboSyncRunSnapshot(current) }
      },
      buildEvent: () =>
        args.eventType === 'RETRY'
          ? { type: 'RETRY', retried_at: nowIso, triggered_by: args.actorUserId }
          : { type: 'START_SYNC', started_at: nowIso, triggered_by: args.actorUserId },
      persist: async (c, nextSnapshot) => {
        const updated = await c.query<QboSyncRunRow>(
          `update qbo_sync_runs
             set status = $3,
                 state_version = $4,
                 started_at = coalesce($5, started_at),
                 retried_at = coalesce($6, retried_at),
                 error = $7,
                 triggered_by = $8,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${QBO_SYNC_RUN_COLUMNS}`,
          [
            args.companyId,
            args.runId,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.started_at ?? null,
            nextSnapshot.retried_at ?? null,
            nextSnapshot.error ?? null,
            nextSnapshot.triggered_by ?? null,
          ],
        )
        const updatedRow = updated.rows[0]
        if (!updatedRow) throw new HttpError(500, 'qbo sync run update returned no row')
        return updatedRow
      },
      // Re-emit the per-run outbox anchor so the worker drain re-attempts the
      // sync against this same run. Stable key → on conflict resets to
      // pending, no duplicate work.
      sideEffects: async (c, _next, updatedRow) => {
        await recordMutationOutbox(
          args.companyId,
          'qbo_sync_run',
          args.runId,
          'run_qbo_sync',
          { qbo_sync_run_id: args.runId, integration_connection_id: updatedRow.integration_connection_id },
          `qbo_sync_run:run:${args.runId}`,
          'server',
          args.actorUserId,
          c,
        )
      },
    },
  )
  if (result.kind === 'ok') observeWorkflowEvent(QBO_SYNC_RUN_WORKFLOW_NAME, 'requested')
  return result
}

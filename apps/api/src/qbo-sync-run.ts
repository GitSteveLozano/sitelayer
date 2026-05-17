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
  transitionQboSyncRunWorkflow,
  type QboSyncRunWorkflowEvent,
  type QboSyncRunWorkflowSnapshot,
  type QboSyncRunWorkflowState,
} from '@sitelayer/workflows'
import { observeWorkflowEvent } from './metrics.js'
import { recordMutationOutbox, recordWorkflowEvent } from './mutation-tx.js'

type QboSyncRunRow = {
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
  const pendingRow = created.rows[0]!
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
    eventPayload: startEvent as unknown as Record<string, unknown>,
    snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
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
  return { run: updated.rows[0]!, snapshot: nextSnapshot }
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
    eventPayload: event as unknown as Record<string, unknown>,
    snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
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
    eventPayload: event as unknown as Record<string, unknown>,
    snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
    actorUserId: args.triggeredBy,
  })
  observeWorkflowEvent(QBO_SYNC_RUN_WORKFLOW_NAME, 'failed')
}

/**
 * Test-only replay helpers.
 *
 * `applyEventSequence` walks a deterministic-workflow event list through
 * the registered reducer and emits one `workflow_event_log` row per
 * event. The shape matches what `apps/api/src/mutation-tx.ts:recordWorkflowEvent`
 * writes during real request handling so tests and seed fixtures get the
 * exact event-log corpus that production paths would have produced.
 *
 * This file is intentionally test-facing — it pokes a passed-in executor
 * (anything that quacks like `pg.PoolClient` for the `query` method) and
 * leaves DB transaction management to the caller. Seed fixtures wrap
 * calls in BEGIN/COMMIT; in-memory unit tests pass a stub that records
 * SQL.
 *
 * Why this exists (vs. just calling recordWorkflowEvent in a loop):
 *
 *   - recordWorkflowEvent lives in apps/api and depends on the API's
 *     Sentry/AsyncLocalStorage hookup. Importing it from packages/* would
 *     invert the dep graph.
 *   - The shape of the workflow_event_log row is tied to the reducer
 *     output. Repeating that walk every place we want a stuck-mid-flight
 *     scenario is bug-prone — `applyEventSequence` collapses it into one
 *     audited primitive.
 *   - Returning the per-step snapshots (and the final reducer snapshot)
 *     lets seed scripts stamp the matching entity row (rental_billing_runs,
 *     estimate_pushes, ...) so the row and its event log agree bit for
 *     bit — the same invariant `scripts/replay-workflow.ts` audits in
 *     prod.
 */

import { getWorkflow } from './registry.js'

/** Anything that quacks like `pg.PoolClient.query`. The tests pass a
 *  stub that records SQL; the seed script passes a live PoolClient. */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows?: unknown[] } | unknown>
}

export interface ApplyEventSequenceArgs<Event extends { type: string }> {
  /** Workflow name as registered via `registerWorkflow` (e.g. `rental_billing_run`). */
  workflowName: string
  /** Schema version to look up. Defaults to the highest registered version. */
  schemaVersion?: number
  /** Stable entity id (the row's primary key). Used as `workflow_event_log.entity_id`. */
  entityId: string
  /** Matches workflow_event_log.entity_type ('rental_billing_run', 'estimate_push', ...). */
  entityType: string
  /** Tenant id — needed for the NOT NULL column on workflow_event_log. */
  companyId: string
  /** Starting snapshot. The caller owns its shape (state, state_version, and
   *  any persisted fields). state_version is the version of the row BEFORE
   *  the first event is applied. */
  initialSnapshot: { state: string; state_version: number; [k: string]: unknown }
  /** Ordered event payloads. Each must be valid for the reducer at the
   *  state produced by the prior event (or the initial state for the first). */
  events: readonly Event[]
  /** Optional clerk_user_id stamped onto each row's `actor_user_id`. */
  actorUserId?: string | null
  /** Optional override for the per-event applied_at timestamp. The
   *  default (null) lets postgres write its own `now()`. */
  appliedAt?: string | null
}

export interface ApplyEventSequenceStep<Snapshot> {
  /** state_version BEFORE the event is applied (matches the persisted column). */
  stateVersionBefore: number
  eventType: string
  /** Reducer output for this step. */
  snapshotAfter: Snapshot
}

export interface ApplyEventSequenceResult<Snapshot> {
  /** Reducer output after the final event. Use this to UPDATE the entity row. */
  finalSnapshot: Snapshot
  /** Per-event audit trail; same shape that's persisted as workflow_event_log rows. */
  steps: ReadonlyArray<ApplyEventSequenceStep<Snapshot>>
}

/**
 * Walk a sequence of events through the registered reducer, writing one
 * workflow_event_log row per event, and return the final snapshot plus
 * a per-step trace. Throws if the workflow isn't registered or any
 * transition is illegal.
 *
 * The caller is responsible for:
 *   - opening / committing the surrounding transaction
 *   - persisting the final snapshot back onto the entity row (e.g.
 *     `update rental_billing_runs set status=$1, state_version=$2 ...`)
 */
export async function applyEventSequence<
  Snapshot extends { state: string; state_version: number; [k: string]: unknown },
  Event extends { type: string },
>(executor: QueryExecutor, args: ApplyEventSequenceArgs<Event>): Promise<ApplyEventSequenceResult<Snapshot>> {
  const definition = getWorkflow(args.workflowName, args.schemaVersion)
  if (!definition) {
    throw new Error(
      `applyEventSequence: no workflow registered for ${args.workflowName}${
        args.schemaVersion !== undefined ? `@${args.schemaVersion}` : ''
      }`,
    )
  }

  let snapshot = args.initialSnapshot as Snapshot
  const steps: Array<ApplyEventSequenceStep<Snapshot>> = []

  for (const event of args.events) {
    const stateVersionBefore = snapshot.state_version
    const nextSnapshot = definition.reduce(snapshot as never, event as never) as Snapshot
    await executor.query(
      `insert into workflow_event_log (
         company_id, workflow_name, schema_version, entity_type, entity_id,
         state_version, event_type, event_payload, snapshot_after,
         actor_user_id, applied_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, coalesce($11::timestamptz, now()))
       on conflict (entity_id, workflow_name, state_version) do nothing`,
      [
        args.companyId,
        definition.name,
        definition.schemaVersion,
        args.entityType,
        args.entityId,
        stateVersionBefore,
        event.type,
        JSON.stringify(event),
        JSON.stringify(nextSnapshot),
        args.actorUserId ?? null,
        args.appliedAt ?? null,
      ],
    )
    steps.push({ stateVersionBefore, eventType: event.type, snapshotAfter: nextSnapshot })
    snapshot = nextSnapshot
  }

  return { finalSnapshot: snapshot, steps }
}

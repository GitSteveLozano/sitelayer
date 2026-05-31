/**
 * Single source of truth for the `workflow_event_log` INSERT.
 *
 * The append-only event log is written from two places with deliberately
 * different conflict semantics:
 *   - API/human path (`recordWorkflowEvent`, apps/api/src/mutation-tx.ts):
 *     a unique violation is a human double-submit → throw → 409.
 *   - worker path (`appendWorkflowEvent`, packages/queue/src/index.ts):
 *     a unique violation is an idempotent retry → `on conflict do nothing`.
 *
 * Both used to hand-maintain the same 13-column INSERT, so adding a column
 * to one and not the other silently desynced the log (and the replay corpus
 * that depends on it). This helper builds the parameterized SQL + values in
 * one place; the two writers differ ONLY in (a) where they source the trace
 * columns and (b) the conflict clause — both passed in. It returns
 * `{ text, values }` and never touches a DB driver, so it can live in the
 * workflows package that both apps/api and packages/queue already depend on.
 */

/** The 13 logical columns of a workflow_event_log row, in INSERT order. */
export interface WorkflowEventLogInsertArgs {
  companyId: string
  workflowName: string
  schemaVersion: number
  entityType: string
  entityId: string
  /** state_version BEFORE the transition (the version the event was dispatched against). */
  stateVersion: number
  eventType: string
  /** Full event object; serialized to jsonb by the caller-agnostic builder. */
  eventPayload: object
  /** Full reducer output; serialized to jsonb. */
  snapshotAfter: object
  actorUserId?: string | null
  requestId?: string | null
  sentryTrace?: string | null
  sentryBaggage?: string | null
}

export interface WorkflowEventLogInsertOptions {
  /**
   * 'throw' → omit the conflict clause so a duplicate raises a unique
   *           violation the caller maps to 409 (human/API path).
   * 'do_nothing' → append `on conflict (entity_id, state_version) do nothing`
   *           for idempotent worker retries.
   */
  onConflict: 'throw' | 'do_nothing'
}

/** Column list, in the order the placeholders + values follow. */
export const WORKFLOW_EVENT_LOG_COLUMNS = [
  'company_id',
  'workflow_name',
  'schema_version',
  'entity_type',
  'entity_id',
  'state_version',
  'event_type',
  'event_payload',
  'snapshot_after',
  'actor_user_id',
  'request_id',
  'sentry_trace',
  'sentry_baggage',
] as const

/**
 * Build the parameterized `insert into workflow_event_log (...)` statement
 * and its values array. The two jsonb columns (event_payload, snapshot_after)
 * carry a `::jsonb` cast; the values are pre-stringified here so both call
 * sites stay identical.
 */
export function buildWorkflowEventLogInsert(
  args: WorkflowEventLogInsertArgs,
  opts: WorkflowEventLogInsertOptions,
): { text: string; values: unknown[] } {
  const conflictClause = opts.onConflict === 'do_nothing' ? '\n    on conflict (entity_id, state_version) do nothing' : ''
  const text = `
    insert into workflow_event_log (
      ${WORKFLOW_EVENT_LOG_COLUMNS.join(', ')}
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)${conflictClause}
  `
  const values: unknown[] = [
    args.companyId,
    args.workflowName,
    args.schemaVersion,
    args.entityType,
    args.entityId,
    args.stateVersion,
    args.eventType,
    JSON.stringify(args.eventPayload),
    JSON.stringify(args.snapshotAfter),
    args.actorUserId ?? null,
    args.requestId ?? null,
    args.sentryTrace ?? null,
    args.sentryBaggage ?? null,
  ]
  return { text, values }
}

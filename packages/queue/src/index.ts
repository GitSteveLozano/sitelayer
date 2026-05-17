import type { QueryResult, QueryResultRow } from 'pg'

export {
  fetchDueRentals,
  processRentalInvoice,
  RENTAL_SELECT_COLUMNS,
  type ProcessRentalInvoiceResult,
  type RentalMaterialBillRow,
  type RentalRow,
} from './rentals.js'

export { recordLedger, type RecordLedgerArgs, type LedgerTraceContext } from './ledger.js'

export {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  isTrippingError,
  withCircuitBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker.js'

/**
 * Mark outbox rows whose attempt_count has reached the retry cap as
 * 'dead'. Run once per heartbeat at the start of the drain so a stuck
 * row never gets re-claimed. Returns the number of rows dead-lettered.
 *
 * Pairs with the MUTATION_MAX_RETRIES env knob in worker.ts.
 */
export async function deadLetterStaleOutbox(
  client: QueueClient,
  companyId: string,
  maxRetries: number,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `with d as (
       update mutation_outbox
         set status = 'dead', applied_at = now()
         where company_id = $1
           and status in ('pending', 'processing')
           and attempt_count >= $2
         returning 1
     )
     select count(*)::int as count from d`,
    [companyId, maxRetries],
  )
  return result.rows[0]?.count ?? 0
}

export {
  processLockLaborEntries,
  LOCK_LABOR_ENTRIES_MAX_ATTEMPTS,
  type LockLaborEntriesAction,
  type LockLaborEntriesPayload,
  type LockLaborEntriesSummary,
} from './pushers/lock-labor-entries.js'

export {
  processRentalBillingInvoicePush,
  type RentalBillingInvoicePushInput,
  type RentalBillingInvoicePushResult,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from './pushers/rental-billing-invoice.js'

export {
  processEstimatePush,
  type EstimatePushInput,
  type EstimatePushResult,
  type EstimatePushFn,
  type EstimatePushSummary,
} from './pushers/estimate-push.js'

export interface QueueClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>
}

export interface ReleasableQueueClient extends QueueClient {
  release(): void
}

export interface QueuePool {
  connect(): Promise<ReleasableQueueClient>
}

export interface TraceContext {
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
}

export type ProcessedOutboxRow = {
  id: string
  entity_type: string
  entity_id: string
  mutation_type: string
  attempt_count: number
  created_at: string
} & TraceContext

export type ProcessedSyncEventRow = {
  id: string
  entity_type: string
  entity_id: string
  direction: string
  attempt_count: number
  created_at: string
} & TraceContext

export type QueueProcessResult = {
  processedOutboxCount: number
  processedSyncEventCount: number
  outbox: ProcessedOutboxRow[]
  syncEvents: ProcessedSyncEventRow[]
}

// mutation_types claimed by dedicated handlers, NOT by the generic drain.
// Adding a new dedicated handler? Add its mutation_type here so the generic
// drain doesn't race the dedicated worker.
export const DEDICATED_HANDLER_MUTATION_TYPES = [
  'post_qbo_invoice',
  'post_qbo_estimate',
  'lock_labor_entries',
  'post_qbo_time_activities',
  'notify_worker_resolution',
  'notify_estimator_escalation',
  'notify_foreman_assignment',
] as const

/**
 * Append one row to workflow_event_log from inside a worker tx. Used by
 * dedicated handlers when emitting POST_SUCCEEDED / POST_FAILED so the
 * event log captures worker transitions, not just human ones.
 *
 * The unique (entity_id, state_version) constraint protects against
 * duplicate writes if a worker tx retries after partial commit. A
 * caller that hits the constraint should treat the event as already
 * recorded and continue.
 *
 * The `trace` param carries the W3C sentry-trace/baggage + request_id
 * that the originating API request stamped on the outbox row. The
 * dedicated handlers below pull these fields off the claimed outbox row
 * and pass them through so the worker-emitted POST_SUCCEEDED row is
 * linked to the same trace as the SPA → API → outbox → worker chain.
 * Migration 079 adds sentry_baggage so the full W3C pair lands here.
 */
export async function appendWorkflowEvent(
  client: QueueClient,
  args: {
    companyId: string
    workflowName: string
    schemaVersion: number
    entityType: string
    entityId: string
    /** state_version BEFORE the transition. */
    stateVersion: number
    eventType: string
    eventPayload: Record<string, unknown>
    snapshotAfter: Record<string, unknown>
    actorUserId?: string | null
    trace?: TraceContext
  },
): Promise<void> {
  const sentryTrace = args.trace?.sentry_trace ?? null
  const sentryBaggage = args.trace?.sentry_baggage ?? null
  const requestId = args.trace?.request_id ?? null
  await client.query(
    `
    insert into workflow_event_log (
      company_id, workflow_name, schema_version, entity_type, entity_id,
      state_version, event_type, event_payload, snapshot_after, actor_user_id,
      request_id, sentry_trace, sentry_baggage
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
    on conflict (entity_id, state_version) do nothing
    `,
    [
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
      requestId,
      sentryTrace,
      sentryBaggage,
    ],
  )
}

export async function processOutboxBatch(
  client: QueueClient,
  companyId: string,
  limit: number,
): Promise<ProcessedOutboxRow[]> {
  const claimed = await client.query<{ id: string }>(
    `
    update mutation_outbox
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      next_attempt_at = now() + interval '5 minutes',
      error = null
    where id in (
      select id
      from mutation_outbox
      where company_id = $1
        and mutation_type <> all($3::text[])
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit, [...DEDICATED_HANDLER_MUTATION_TYPES]],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return []

  const applied = await client.query<ProcessedOutboxRow>(
    `
    update mutation_outbox
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id, entity_type, entity_id, mutation_type, attempt_count, created_at,
      sentry_trace, sentry_baggage, request_id
    `,
    [companyId, ids],
  )
  return applied.rows
}

export async function processSyncEventBatch(
  client: QueueClient,
  companyId: string,
  limit: number,
): Promise<ProcessedSyncEventRow[]> {
  const claimed = await client.query<{ id: string }>(
    `
    update sync_events
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      next_attempt_at = now() + interval '5 minutes',
      error = null
    where id in (
      select id
      from sync_events
      where company_id = $1
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return []

  const applied = await client.query<ProcessedSyncEventRow>(
    `
    update sync_events
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id, entity_type, entity_id, direction, attempt_count, created_at,
      sentry_trace, sentry_baggage, request_id
    `,
    [companyId, ids],
  )
  return applied.rows
}

export async function processQueueWithClient(
  client: QueueClient,
  companyId: string,
  limit = 25,
): Promise<QueueProcessResult> {
  const outboxRows = await processOutboxBatch(client, companyId, limit)
  const syncEventRows = await processSyncEventBatch(client, companyId, limit)

  if (outboxRows.length || syncEventRows.length) {
    await client.query(
      `
      update integration_connections
      set last_synced_at = now(), status = 'connected', version = version + 1
      where company_id = $1
        and provider in ('qbo', 'demo')
      `,
      [companyId],
    )
  }

  return {
    processedOutboxCount: outboxRows.length,
    processedSyncEventCount: syncEventRows.length,
    outbox: outboxRows,
    syncEvents: syncEventRows,
  }
}

export async function processQueue(pool: QueuePool, companyId: string, limit = 25): Promise<QueueProcessResult> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await processQueueWithClient(client, companyId, limit)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Mark a single outbox row failed in its own transaction. Used after a
 * per-row work tx has been rolled back so the failure is recorded even
 * when the inner catch path's recovery work itself threw. Best-effort:
 * if even this update can't succeed, the row will be re-claimed once
 * its 5-minute lease elapses.
 *
 * Exported for use by the pusher modules under `./pushers/`.
 */
export async function markOutboxRowFailedFresh(
  client: QueueClient,
  companyId: string,
  outboxId: string,
  errorMessage: string,
  retryDelayMinutes = 15,
): Promise<void> {
  try {
    await client.query('begin')
    await client.query(
      `update mutation_outbox
         set status = 'failed', error = $3, next_attempt_at = now() + ($4 || ' minutes')::interval
       where company_id = $1 and id = $2`,
      [companyId, outboxId, errorMessage.slice(0, 1000), String(retryDelayMinutes)],
    )
    await client.query('commit')
  } catch (markErr) {
    await client.query('rollback').catch(() => {})
    // Re-throw so the caller can log it; the row will be re-claimed once
    // next_attempt_at elapses (the original claim already set this).
    throw markErr
  }
}

import type { QueryResult, QueryResultRow } from 'pg'
import { buildWorkflowEventLogInsert } from '@sitelayer/workflows'

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

// Audit Escrow MVP — signed, chained, append-only evidence anchor for
// sitelayer's audit chain. Wedge 2 of docs/PROVING_GROUND_PLAN.md.
// Lives in the queue package because both apps/api (verification routes)
// and apps/worker (hourly tick) need to import it; queue is the
// established shared infrastructure layer for cross-app primitives.
export {
  AUDIT_ESCROW_ALGORITHM,
  AUDIT_ESCROW_VERSION,
  appendEntry as appendAuditEscrowEntry,
  canonicalizeJSON as canonicalizeAuditEscrowJSON,
  getChainHead as getAuditEscrowChainHead,
  getEntryById as getAuditEscrowEntryById,
  getOrCreateActiveSigningKey as getOrCreateAuditEscrowSigningKey,
  hashCanonicalJSON as hashAuditEscrowCanonicalJSON,
  hashSHA256 as hashAuditEscrowSHA256,
  sealEntry as sealAuditEscrowEntry,
  signEd25519 as signAuditEscrowEd25519,
  verifyEd25519 as verifyAuditEscrowEd25519,
  verifyEntry as verifyAuditEscrowEntry,
  type AppendEntryParams as AppendAuditEscrowEntryParams,
  type AuditEscrowEntry,
  type AuditEscrowKey,
  type AuditEscrowMaterial,
  type SealMetadataInput as SealAuditEscrowMetadataInput,
  type VerificationReport as AuditEscrowVerificationReport,
} from './audit-escrow.js'

/**
 * Prune long-applied rows out of `mutation_outbox` and `sync_events`.
 * Both tables grow forever once a row is `applied_at IS NOT NULL`
 * because nothing ever reclaims them — they're an audit trail, not a
 * work queue. After ~30 days they're operationally useless (the trace
 * id has aged out of Sentry, the QBO push has long since reconciled)
 * but they keep bloating the table, slowing autovacuum and chewing
 * managed-Postgres disk.
 *
 * Safe to re-run: the DELETE is gated by `applied_at < now() -
 * interval 'N days'`, so a second run within the same hour is a no-op.
 * Caller is responsible for cadence (the worker's queue-prune runner
 * fires once per day via a last-run-at gate).
 *
 * Returns per-table delete counts so the caller can emit metrics /
 * structured logs.
 */
export async function pruneAppliedQueue(
  client: QueueClient,
  opts: { retentionDays: number },
): Promise<{ mutation_outbox: number; sync_events: number }> {
  const retentionDays = Math.max(1, Math.floor(opts.retentionDays))
  // Use a parameterised interval so a misconfigured env can't inject
  // SQL via the `interval 'N days'` literal. Casting through
  // `make_interval` keeps the value typed as an integer day count.
  const outbox = await client.query<{ count: number }>(
    `with d as (
       delete from mutation_outbox
        where applied_at is not null
          and applied_at < now() - make_interval(days => $1)
        returning 1
     )
     select count(*)::int as count from d`,
    [retentionDays],
  )
  const sync = await client.query<{ count: number }>(
    `with d as (
       delete from sync_events
        where applied_at is not null
          and applied_at < now() - make_interval(days => $1)
        returning 1
     )
     select count(*)::int as count from d`,
    [retentionDays],
  )
  return {
    mutation_outbox: outbox.rows[0]?.count ?? 0,
    sync_events: sync.rows[0]?.count ?? 0,
  }
}

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
  processRentalInvoicePush,
  type RentalInvoicePushInput,
  type RentalInvoicePushResult,
  type RentalInvoicePushFn,
  type RentalInvoicePushSummary,
} from './pushers/rental-cadence-invoice.js'

export {
  processEstimatePush,
  type EstimatePushInput,
  type EstimatePushResult,
  type EstimatePushFn,
  type EstimatePushSummary,
} from './pushers/estimate-push.js'

export {
  processQboPull,
  type QboPullInput,
  type QboPullResult,
  type QboPullFn,
  type QboPullSummary,
} from './pushers/qbo-pull.js'

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
  capture_session_id?: string | null
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
  // Rental cadence invoice push — drained by apps/worker/src/runners/
  // rental-invoice-push.ts → processRentalInvoicePush (the queue handler lives
  // in pushers/rental-cadence-invoice.ts). Marking it dedicated keeps the
  // generic drain from claiming the row and marking it 'applied' WITHOUT
  // pushing to QBO / dispatching the INVOICE_QUEUED/INVOICE_POSTED cadence
  // transitions — the same silent-data-drop footgun this list guards.
  'post_rental_invoice',
  'post_qbo_estimate',
  'lock_labor_entries',
  'post_qbo_time_activities',
  'notify_worker_resolution',
  'notify_estimator_escalation',
  'notify_foreman_assignment',
  // Blueprint storage GC — drained by apps/worker/src/runners/
  // blueprint-storage-gc.ts. Marking it dedicated keeps the generic
  // drain from racing the GC runner (the generic drain just marks
  // applied without actually deleting the Spaces object).
  'delete_blueprint_storage_object',
  // Context handoff dispatch — drained by apps/worker/src/runners/
  // context-work-dispatch.ts so the generic drain cannot mark the
  // Mesh handoff applied before an agent system has actually accepted it.
  'dispatch_mesh_work_request',
  // Crew-schedule confirm side effects — drained by apps/worker/src/runners/
  // crew-schedule-confirm.ts (processCrewScheduleConfirm), which materializes
  // confirmed labor_entries / bumps projects.version and fans out the foreman
  // decline notification. Without these the generic drain would claim the row
  // and mark it 'applied' without doing the work, silently dropping labor
  // materialization — and every auto-confirmed new assignment now enqueues a
  // materialize_labor_entries row, so the race is on the hot path.
  'materialize_labor_entries',
  'notify_foreman_decline',
  // QBO reference-data pull (customers + items + classes backfill) —
  // drained by apps/worker/src/runners/qbo-pull.ts (processQboPull). Without
  // this entry the generic drain (processOutboxBatch) would claim the row and
  // mark it 'applied' WITHOUT performing the pull — a silent data-drop, the
  // exact footgun this exclusion list warns about.
  'pull_qbo_reference',
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
  const captureSessionId = args.trace?.capture_session_id ?? null
  // Shared INSERT builder — same column list as the API path
  // (recordWorkflowEvent). The worker path differs only in: trace context
  // comes off the claimed outbox row (args.trace), and conflict handling is
  // idempotent `do nothing` so a retried drain is a safe no-op.
  const { text, values } = buildWorkflowEventLogInsert(
    {
      companyId: args.companyId,
      workflowName: args.workflowName,
      schemaVersion: args.schemaVersion,
      entityType: args.entityType,
      entityId: args.entityId,
      stateVersion: args.stateVersion,
      eventType: args.eventType,
      eventPayload: args.eventPayload,
      snapshotAfter: args.snapshotAfter,
      actorUserId: args.actorUserId ?? null,
      requestId,
      sentryTrace,
      sentryBaggage,
      captureSessionId,
    },
    { onConflict: 'do_nothing' },
  )
  await client.query(text, values)
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
      -- Exponential backoff + jitter (was a flat 5 min for every retry). Delay
      -- doubles per prior attempt off a 5s base, capped at 6h, exponent capped
      -- at 16 to avoid power() overflow before the dead-letter sweep retires the
      -- row. 50-100% jitter de-syncs a thundering herd. attempt_count here is the
      -- pre-increment (prior-attempt) count, so the first retry is ~2.5-5s.
      next_attempt_at = now() + (
        least(interval '6 hours', interval '5 seconds' * power(2, least(attempt_count, 16)))
        * (0.5 + random() * 0.5)
      ),
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
      sentry_trace, sentry_baggage, request_id, capture_session_id
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
      -- Exponential backoff + jitter (was a flat 5 min for every retry). Delay
      -- doubles per prior attempt off a 5s base, capped at 6h, exponent capped
      -- at 16 to avoid power() overflow before the dead-letter sweep retires the
      -- row. 50-100% jitter de-syncs a thundering herd. attempt_count here is the
      -- pre-increment (prior-attempt) count, so the first retry is ~2.5-5s.
      next_attempt_at = now() + (
        least(interval '6 hours', interval '5 seconds' * power(2, least(attempt_count, 16)))
        * (0.5 + random() * 0.5)
      ),
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
      sentry_trace, sentry_baggage, request_id, capture_session_id
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

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
export const DEDICATED_HANDLER_MUTATION_TYPES = ['post_qbo_invoice', 'post_qbo_estimate'] as const

/**
 * Append one row to workflow_event_log from inside a worker tx. Used by
 * dedicated handlers when emitting POST_SUCCEEDED / POST_FAILED so the
 * event log captures worker transitions, not just human ones.
 *
 * The unique (entity_id, state_version) constraint protects against
 * duplicate writes if a worker tx retries after partial commit. A
 * caller that hits the constraint should treat the event as already
 * recorded and continue.
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
  },
): Promise<void> {
  await client.query(
    `
    insert into workflow_event_log (
      company_id, workflow_name, schema_version, entity_type, entity_id,
      state_version, event_type, event_payload, snapshot_after, actor_user_id
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
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

// ---------------------------------------------------------------------------
// Rental billing invoice push handler
//
// See docs/DETERMINISTIC_WORKFLOWS.md. The route's POST_REQUESTED event
// enqueues a mutation_outbox row with mutation_type='post_qbo_invoice' and
// idempotency_key='rental_billing_run:post:{run_id}'. This handler claims
// those rows, locks the run, runs the user-supplied push function (which
// hits QBO and returns the new invoice id), and applies POST_SUCCEEDED or
// POST_FAILED through the same reducer the route uses.
//
// All work for one row happens in a single tx so the run state, sync_event
// audit row, and outbox row's status all move atomically.
// ---------------------------------------------------------------------------

export type RentalBillingInvoicePushInput = {
  client: QueueClient
  companyId: string
  runId: string
  payload: Record<string, unknown>
}

export type RentalBillingInvoicePushResult = {
  qbo_invoice_id: string
}

export type RentalBillingInvoicePushFn = (
  input: RentalBillingInvoicePushInput,
) => Promise<RentalBillingInvoicePushResult>

export type RentalBillingInvoicePushSummary = {
  processed: number
  posted: number
  failed: number
  skipped: number
}

type ClaimedInvoicePushRow = {
  id: string
  entity_id: string
  payload: Record<string, unknown>
  attempt_count: number
}

type RentalBillingRunStateRow = {
  id: string
  status: string
  state_version: number
  qbo_invoice_id: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
}

async function applyWorkerEmittedEvent(
  client: QueueClient,
  companyId: string,
  runId: string,
  outcome: { kind: 'succeeded'; qbo_invoice_id: string } | { kind: 'failed'; error: string },
): Promise<RentalBillingRunStateRow | null> {
  const lockResult = await client.query<RentalBillingRunStateRow>(
    `select id, status, state_version, qbo_invoice_id,
            approved_at, approved_by, posted_at, failed_at, error
     from rental_billing_runs
     where company_id = $1 and id = $2 and deleted_at is null
     for update`,
    [companyId, runId],
  )
  const current = lockResult.rows[0]
  if (!current) return null
  if (current.status !== 'posting') {
    // Race: a human VOID landed first, or the run already moved off
    // 'posting'. Either way the worker must NOT overwrite state — the human
    // event is authoritative. Return the current row so the caller can mark
    // the outbox applied without changing state.
    return current
  }
  const beforeVersion = current.state_version
  const nextVersion = beforeVersion + 1
  if (outcome.kind === 'succeeded') {
    const postedAt = new Date().toISOString()
    const updated = await client.query<RentalBillingRunStateRow>(
      `update rental_billing_runs
         set status = 'posted',
             state_version = $3,
             posted_at = $4,
             qbo_invoice_id = $5,
             error = null,
             failed_at = null,
             version = version + 1,
             updated_at = now()
       where company_id = $1 and id = $2
       returning id, status, state_version, qbo_invoice_id,
                 approved_at, approved_by, posted_at, failed_at, error`,
      [companyId, runId, nextVersion, postedAt, outcome.qbo_invoice_id],
    )
    const row = updated.rows[0] ?? null
    if (row) {
      await appendWorkflowEvent(client, {
        companyId,
        workflowName: 'rental_billing_run',
        schemaVersion: 1,
        entityType: 'rental_billing_run',
        entityId: runId,
        stateVersion: beforeVersion,
        eventType: 'POST_SUCCEEDED',
        eventPayload: { type: 'POST_SUCCEEDED', posted_at: postedAt, qbo_invoice_id: outcome.qbo_invoice_id },
        snapshotAfter: {
          state: row.status,
          state_version: row.state_version,
          approved_at: row.approved_at,
          approved_by: row.approved_by,
          posted_at: row.posted_at,
          failed_at: row.failed_at,
          error: row.error,
          qbo_invoice_id: row.qbo_invoice_id,
        },
      })
    }
    return row
  }
  const failedAt = new Date().toISOString()
  const errorMessage = outcome.error.slice(0, 1000)
  const updated = await client.query<RentalBillingRunStateRow>(
    `update rental_billing_runs
       set status = 'failed',
           state_version = $3,
           failed_at = $4,
           error = $5,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning id, status, state_version, qbo_invoice_id,
               approved_at, approved_by, posted_at, failed_at, error`,
    [companyId, runId, nextVersion, failedAt, errorMessage],
  )
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: 'rental_billing_run',
      schemaVersion: 1,
      entityType: 'rental_billing_run',
      entityId: runId,
      stateVersion: beforeVersion,
      eventType: 'POST_FAILED',
      eventPayload: { type: 'POST_FAILED', failed_at: failedAt, error: errorMessage },
      snapshotAfter: {
        state: row.status,
        state_version: row.state_version,
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        posted_at: row.posted_at,
        failed_at: row.failed_at,
        error: row.error,
        qbo_invoice_id: row.qbo_invoice_id,
      },
    })
  }
  return row
}

async function recordInvoicePushSyncEvent(
  client: QueueClient,
  companyId: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status)
     values ($1, null, 'outbound', 'rental_billing_run', $2, $3::jsonb, 'applied')`,
    [companyId, runId, JSON.stringify(payload)],
  )
}

export async function processRentalBillingInvoicePush(
  client: QueueClient,
  companyId: string,
  push: RentalBillingInvoicePushFn,
  limit = 5,
): Promise<RentalBillingInvoicePushSummary> {
  const claimed = await client.query<ClaimedInvoicePushRow>(
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
        and entity_type = 'rental_billing_run'
        and mutation_type = 'post_qbo_invoice'
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id, entity_id, payload, attempt_count
    `,
    [companyId, limit],
  )

  let posted = 0
  let failed = 0
  let skipped = 0

  for (const row of claimed.rows) {
    const runId = row.entity_id
    try {
      // Idempotency check: if QBO invoice id already exists, skip the push
      // and emit POST_SUCCEEDED with the existing id. Worker retries against
      // the same idempotency key are safe.
      const existing = await client.query<{ qbo_invoice_id: string | null; status: string }>(
        `select qbo_invoice_id, status from rental_billing_runs
         where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [companyId, runId],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        await client.query(
          `update mutation_outbox set status = 'failed', error = $3, applied_at = now()
           where company_id = $1 and id = $2`,
          [companyId, row.id, 'rental_billing_run not found'],
        )
        failed += 1
        continue
      }
      if (existingRow.qbo_invoice_id && existingRow.status === 'posting') {
        // Already pushed in a prior attempt that crashed before marking the
        // outbox row applied. Emit POST_SUCCEEDED with the existing id and
        // mark the outbox row applied — no second QBO push.
        await applyWorkerEmittedEvent(client, companyId, runId, {
          kind: 'succeeded',
          qbo_invoice_id: existingRow.qbo_invoice_id,
        })
        await recordInvoicePushSyncEvent(client, companyId, runId, {
          action: 'post_succeeded',
          provider: 'qbo',
          external_id: existingRow.qbo_invoice_id,
          idempotent_replay: true,
        })
        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        skipped += 1
        continue
      }

      const result = await push({ client, companyId, runId, payload: row.payload })
      const updated = await applyWorkerEmittedEvent(client, companyId, runId, {
        kind: 'succeeded',
        qbo_invoice_id: result.qbo_invoice_id,
      })
      await recordInvoicePushSyncEvent(client, companyId, runId, {
        action: 'post_succeeded',
        provider: 'qbo',
        external_id: result.qbo_invoice_id,
        state_version: updated?.state_version ?? null,
      })
      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      posted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await applyWorkerEmittedEvent(client, companyId, row.entity_id, {
        kind: 'failed',
        error: message,
      })
      await recordInvoicePushSyncEvent(client, companyId, row.entity_id, {
        action: 'post_failed',
        provider: 'qbo',
        error: message,
      })
      await client.query(
        `update mutation_outbox
           set status = 'failed', error = $3, next_attempt_at = now() + interval '15 minutes'
         where company_id = $1 and id = $2`,
        [companyId, row.id, message.slice(0, 1000)],
      )
      failed += 1
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

// ---------------------------------------------------------------------------
// Estimate-push QBO handler.
//
// Twin of processRentalBillingInvoicePush, narrower output (one
// qbo_estimate_id rather than an invoice). Same idempotency contract:
// - claim outbox rows with mutation_type='post_qbo_estimate'
// - lock estimate_pushes row, refuse if state != 'posting'
// - if qbo_estimate_id already set, skip and emit POST_SUCCEEDED with the
//   existing id (covers crash-after-push retries)
// - on success: emit POST_SUCCEEDED, append to workflow_event_log, mark
//   outbox applied
// - on failure: emit POST_FAILED, append to workflow_event_log, requeue
//   outbox with 15-minute backoff
// ---------------------------------------------------------------------------

export type EstimatePushInput = {
  client: QueueClient
  companyId: string
  pushId: string
  payload: Record<string, unknown>
}

export type EstimatePushResult = {
  qbo_estimate_id: string
}

export type EstimatePushFn = (input: EstimatePushInput) => Promise<EstimatePushResult>

export type EstimatePushSummary = {
  processed: number
  posted: number
  failed: number
  skipped: number
}

type EstimatePushStateRow = {
  id: string
  status: string
  state_version: number
  qbo_estimate_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
}

async function applyEstimatePushWorkerEvent(
  client: QueueClient,
  companyId: string,
  pushId: string,
  outcome: { kind: 'succeeded'; qbo_estimate_id: string } | { kind: 'failed'; error: string },
): Promise<EstimatePushStateRow | null> {
  const lockResult = await client.query<EstimatePushStateRow>(
    `select id, status, state_version, qbo_estimate_id,
            reviewed_at, reviewed_by, approved_at, approved_by,
            posted_at, failed_at, error
     from estimate_pushes
     where company_id = $1 and id = $2 and deleted_at is null
     for update`,
    [companyId, pushId],
  )
  const current = lockResult.rows[0]
  if (!current) return null
  if (current.status !== 'posting') {
    return current
  }
  const beforeVersion = current.state_version
  const nextVersion = beforeVersion + 1
  if (outcome.kind === 'succeeded') {
    const postedAt = new Date().toISOString()
    const updated = await client.query<EstimatePushStateRow>(
      `update estimate_pushes
         set status = 'posted',
             state_version = $3,
             posted_at = $4,
             qbo_estimate_id = $5,
             error = null,
             failed_at = null,
             version = version + 1,
             updated_at = now()
       where company_id = $1 and id = $2
       returning id, status, state_version, qbo_estimate_id,
                 reviewed_at, reviewed_by, approved_at, approved_by,
                 posted_at, failed_at, error`,
      [companyId, pushId, nextVersion, postedAt, outcome.qbo_estimate_id],
    )
    const row = updated.rows[0] ?? null
    if (row) {
      await appendWorkflowEvent(client, {
        companyId,
        workflowName: 'estimate_push',
        schemaVersion: 1,
        entityType: 'estimate_push',
        entityId: pushId,
        stateVersion: beforeVersion,
        eventType: 'POST_SUCCEEDED',
        eventPayload: { type: 'POST_SUCCEEDED', posted_at: postedAt, qbo_estimate_id: outcome.qbo_estimate_id },
        snapshotAfter: rowToWorkflowSnapshot(row),
      })
    }
    return row
  }
  const failedAt = new Date().toISOString()
  const errorMessage = outcome.error.slice(0, 1000)
  const updated = await client.query<EstimatePushStateRow>(
    `update estimate_pushes
       set status = 'failed',
           state_version = $3,
           failed_at = $4,
           error = $5,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning id, status, state_version, qbo_estimate_id,
               reviewed_at, reviewed_by, approved_at, approved_by,
               posted_at, failed_at, error`,
    [companyId, pushId, nextVersion, failedAt, errorMessage],
  )
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: 'estimate_push',
      schemaVersion: 1,
      entityType: 'estimate_push',
      entityId: pushId,
      stateVersion: beforeVersion,
      eventType: 'POST_FAILED',
      eventPayload: { type: 'POST_FAILED', failed_at: failedAt, error: errorMessage },
      snapshotAfter: rowToWorkflowSnapshot(row),
    })
  }
  return row
}

function rowToWorkflowSnapshot(row: EstimatePushStateRow): Record<string, unknown> {
  return {
    state: row.status,
    state_version: row.state_version,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error,
    qbo_estimate_id: row.qbo_estimate_id,
  }
}

async function recordEstimatePushSyncEvent(
  client: QueueClient,
  companyId: string,
  pushId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status)
     values ($1, null, 'outbound', 'estimate_push', $2, $3::jsonb, 'applied')`,
    [companyId, pushId, JSON.stringify(payload)],
  )
}

export async function processEstimatePush(
  client: QueueClient,
  companyId: string,
  push: EstimatePushFn,
  limit = 5,
): Promise<EstimatePushSummary> {
  const claimed = await client.query<{
    id: string
    entity_id: string
    payload: Record<string, unknown>
    attempt_count: number
  }>(
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
        and entity_type = 'estimate_push'
        and mutation_type = 'post_qbo_estimate'
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id, entity_id, payload, attempt_count
    `,
    [companyId, limit],
  )

  let posted = 0
  let failed = 0
  let skipped = 0

  for (const row of claimed.rows) {
    const pushId = row.entity_id
    try {
      const existing = await client.query<{ qbo_estimate_id: string | null; status: string }>(
        `select qbo_estimate_id, status from estimate_pushes
         where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [companyId, pushId],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        await client.query(
          `update mutation_outbox set status = 'failed', error = $3, applied_at = now()
           where company_id = $1 and id = $2`,
          [companyId, row.id, 'estimate_push not found'],
        )
        failed += 1
        continue
      }
      if (existingRow.qbo_estimate_id && existingRow.status === 'posting') {
        // Replay-safe: previous push succeeded but outbox row never marked
        // applied. Emit POST_SUCCEEDED with the existing id, no second QBO call.
        await applyEstimatePushWorkerEvent(client, companyId, pushId, {
          kind: 'succeeded',
          qbo_estimate_id: existingRow.qbo_estimate_id,
        })
        await recordEstimatePushSyncEvent(client, companyId, pushId, {
          action: 'post_succeeded',
          provider: 'qbo',
          external_id: existingRow.qbo_estimate_id,
          idempotent_replay: true,
        })
        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        skipped += 1
        continue
      }

      const result = await push({ client, companyId, pushId, payload: row.payload })
      const updated = await applyEstimatePushWorkerEvent(client, companyId, pushId, {
        kind: 'succeeded',
        qbo_estimate_id: result.qbo_estimate_id,
      })
      await recordEstimatePushSyncEvent(client, companyId, pushId, {
        action: 'post_succeeded',
        provider: 'qbo',
        external_id: result.qbo_estimate_id,
        state_version: updated?.state_version ?? null,
      })
      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      posted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await applyEstimatePushWorkerEvent(client, companyId, row.entity_id, {
        kind: 'failed',
        error: message,
      })
      await recordEstimatePushSyncEvent(client, companyId, row.entity_id, {
        action: 'post_failed',
        provider: 'qbo',
        error: message,
      })
      await client.query(
        `update mutation_outbox
           set status = 'failed', error = $3, next_attempt_at = now() + interval '15 minutes'
         where company_id = $1 and id = $2`,
        [companyId, row.id, message.slice(0, 1000)],
      )
      failed += 1
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

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
export const DEDICATED_HANDLER_MUTATION_TYPES = ['post_qbo_invoice'] as const

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
  const nextVersion = current.state_version + 1
  if (outcome.kind === 'succeeded') {
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
      [companyId, runId, nextVersion, new Date().toISOString(), outcome.qbo_invoice_id],
    )
    return updated.rows[0] ?? null
  }
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
    [companyId, runId, nextVersion, new Date().toISOString(), outcome.error.slice(0, 1000)],
  )
  return updated.rows[0] ?? null
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

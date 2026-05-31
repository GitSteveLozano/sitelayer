import {
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  rentalBillingRowToSnapshot,
  transitionRentalBillingWorkflow,
  type RentalBillingWorkflowEvent,
} from '@sitelayer/workflows'
import { appendWorkflowEvent, markOutboxRowFailedFresh, type QueueClient, type TraceContext } from '../index.js'

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
  // Trace continuation hints from the originating mutation_outbox row.
  // See EstimatePushInput for the rationale; same wire shape.
  sentry_trace?: string | null
  sentry_baggage?: string | null
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
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
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
  trace?: TraceContext,
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
    // Race: a human VOID / CANCEL_POST landed first, or the run already moved
    // off 'posting'. Either way the worker must NOT overwrite state — the
    // human event is authoritative. Return the current row so the caller can
    // mark the outbox applied without changing state.
    return current
  }
  const beforeVersion = current.state_version

  // Route the worker-emitted transition through the SAME pure reducer the
  // human event route uses (transitionRentalBillingWorkflow), instead of
  // hand-writing the posting→posted / posting→failed SQL + state_version
  // bump. The clock value and QBO id / error string are event PAYLOAD —
  // the reducer reads them off the event and never calls Date.now(). The
  // SQL below is now one generic "write this snapshot" UPDATE. This deletes
  // the worker's independent transition table; divergence from the route is
  // now impossible because both call the one reducer.
  const event: RentalBillingWorkflowEvent =
    outcome.kind === 'succeeded'
      ? { type: 'POST_SUCCEEDED', posted_at: new Date().toISOString(), qbo_invoice_id: outcome.qbo_invoice_id }
      : { type: 'POST_FAILED', failed_at: new Date().toISOString(), error: outcome.error.slice(0, 1000) }

  // assertRentalBillingTransition throws if `current` isn't in 'posting'; the
  // status guard above already prevents that, so a throw here is a real bug
  // signal that propagates to the per-row catch in
  // processRentalBillingInvoicePush (which records POST_FAILED + requeues).
  const nextSnapshot = transitionRentalBillingWorkflow(rentalBillingRowToSnapshot(current), event)

  const updated = await client.query<RentalBillingRunStateRow>(
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
     returning id, status, state_version, qbo_invoice_id,
               approved_at, approved_by, posted_at, failed_at, error`,
    [
      companyId,
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
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: RENTAL_BILLING_WORKFLOW_NAME,
      schemaVersion: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
      entityType: 'rental_billing_run',
      entityId: runId,
      stateVersion: beforeVersion,
      eventType: event.type,
      eventPayload: event as unknown as Record<string, unknown>,
      snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
      ...(trace ? { trace } : {}),
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
  // Phase 1: claim. Own transaction so the 'processing' marker is durable
  // even if every per-row work tx fails. The next_attempt_at = now()+5min
  // set here keeps a row off the claim list until either a per-row tx
  // commits a final state OR the 5-minute lease elapses (watchdog path).
  await client.query('begin')
  let claimed: { rows: ClaimedInvoicePushRow[]; rowCount: number | null }
  try {
    const result = await client.query<ClaimedInvoicePushRow>(
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
      returning id, entity_id, payload, attempt_count, sentry_trace, sentry_baggage, request_id
      `,
      [companyId, limit],
    )
    claimed = { rows: result.rows, rowCount: result.rowCount ?? null }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }

  let posted = 0
  let failed = 0
  let skipped = 0

  // Phase 2: per-row work, each in its own transaction. A failure in one
  // row's body or recovery path cannot strand earlier rows' state — each
  // row commits or rolls back independently.
  for (const row of claimed.rows) {
    const runId = row.entity_id
    // Propagate the originating sentry-trace + baggage + request_id from the
    // outbox row (set by the API request that emitted POST_REQUESTED) into
    // the worker-emitted workflow_event_log row. Without this, the worker-
    // side POST_SUCCEEDED/POST_FAILED transitions are orphaned from the
    // human trace.
    const rowTrace: TraceContext = {
      sentry_trace: row.sentry_trace,
      sentry_baggage: row.sentry_baggage,
      request_id: row.request_id,
    }
    await client.query('begin')
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
        await client.query('commit')
        failed += 1
        continue
      }
      if (existingRow.qbo_invoice_id && existingRow.status === 'posting') {
        // Already pushed in a prior attempt that crashed before marking the
        // outbox row applied. Emit POST_SUCCEEDED with the existing id and
        // mark the outbox row applied — no second QBO push.
        await applyWorkerEmittedEvent(
          client,
          companyId,
          runId,
          {
            kind: 'succeeded',
            qbo_invoice_id: existingRow.qbo_invoice_id,
          },
          rowTrace,
        )
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
        await client.query('commit')
        skipped += 1
        continue
      }

      const result = await push({
        client,
        companyId,
        runId,
        payload: row.payload,
        sentry_trace: row.sentry_trace,
        sentry_baggage: row.sentry_baggage,
      })
      const updated = await applyWorkerEmittedEvent(
        client,
        companyId,
        runId,
        {
          kind: 'succeeded',
          qbo_invoice_id: result.qbo_invoice_id,
        },
        rowTrace,
      )
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
      await client.query('commit')
      posted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      // Roll back the per-row tx so the partial work doesn't leak. Then
      // attempt the failure-recording sequence in fresh transactions so a
      // second crash here doesn't strand the outbox row in 'processing'.
      await client.query('rollback').catch(() => {})

      // Best-effort: emit POST_FAILED through the reducer and record a
      // sync_event. If either fails (constraint, connection), proceed to
      // marking the outbox row failed regardless — that's the load-bearing
      // step for un-sticking the queue.
      try {
        await client.query('begin')
        await applyWorkerEmittedEvent(
          client,
          companyId,
          row.entity_id,
          {
            kind: 'failed',
            error: message,
          },
          rowTrace,
        )
        await recordInvoicePushSyncEvent(client, companyId, row.entity_id, {
          action: 'post_failed',
          provider: 'qbo',
          error: message,
        })
        await client.query('commit')
      } catch (recoveryErr) {
        await client.query('rollback').catch(() => {})
        // Surface the recovery failure but don't bail — still try to
        // mark the outbox row failed below.
        try {
          // Best-effort sentry/log breadcrumb; the actual recovery is the
          // outbox status update below.
          ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
            '[queue] rental-billing recovery path threw',
            { runId: row.entity_id, originalError: message, recoveryError: recoveryErr },
          )
        } catch {
          /* ignore */
        }
      }

      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        // Truly hopeless: the lease (next_attempt_at = now+5min) means
        // the row gets re-claimed eventually. Surface the error so it's
        // visible in worker logs/Sentry.
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] rental-billing failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

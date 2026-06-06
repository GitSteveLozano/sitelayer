import {
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalWorkflow,
  type RentalWorkflowSnapshot,
} from '@sitelayer/workflows'
import { appendWorkflowEvent, markOutboxRowFailedFresh, type QueueClient, type TraceContext } from '../index.js'

// ---------------------------------------------------------------------------
// Rental invoice cadence push handler — Phase 2 of the `rental` workflow.
//
// MIRRORS pushers/rental-billing-invoice.ts. The cadence path is the rental
// twin of rental_billing_run's POST_REQUESTED → worker apply loop, but the
// rental side has no human APPROVE/POST_REQUESTED surface — the *worker* tick
// (runners/rental-invoice.ts) bills a RETURNED rental, then enqueues a
// mutation_outbox row with mutation_type='post_rental_invoice' and
// idempotency_key='rental:invoice_push:{rental_id}:{state_version}'.
//
// This handler claims those rows, locks the rental, runs the user-supplied
// push function (real QBO invoice when live, else a deterministic stub id so
// dev/preview/fixtures still exercise the plumbing — gated exactly like
// rental_billing_run via QBO_LIVE_RENTAL_INVOICE), and then dispatches the
// cadence transitions INVOICE_QUEUED → INVOICE_POSTED through the SAME pure
// reducer the API route uses (transitionRentalWorkflow). The cadence cycle
// for an already-RETURNED rental is
// `returned → INVOICE_QUEUED → invoiced_pending → INVOICE_POSTED → returned`,
// so the row's `status` round-trips back to `returned` while `state_version`
// advances by two and the two event-log rows are recorded.
//
// All work for one row happens in a single tx so the rental state, the
// workflow_event_log rows, the sync_event audit row, and the outbox row's
// status all move atomically. appendWorkflowEvent uses
// `on conflict (entity_id, workflow_name, state_version) do nothing`, so a
// re-claimed row (crash after the QBO push, before the outbox row was marked
// applied) is an idempotent no-op rather than a duplicate or a swallowed event.
// ---------------------------------------------------------------------------

export type RentalInvoicePushInput = {
  client: QueueClient
  companyId: string
  rentalId: string
  payload: Record<string, unknown>
  // Trace continuation hints from the originating mutation_outbox row.
  // Same wire shape as RentalBillingInvoicePushInput.
  sentry_trace?: string | null
  sentry_baggage?: string | null
}

export type RentalInvoicePushResult = {
  qbo_invoice_id: string
}

export type RentalInvoicePushFn = (input: RentalInvoicePushInput) => Promise<RentalInvoicePushResult>

export type RentalInvoicePushSummary = {
  processed: number
  posted: number
  failed: number
  skipped: number
}

type ClaimedRentalInvoicePushRow = {
  id: string
  entity_id: string
  payload: Record<string, unknown>
  attempt_count: number
  sentry_trace: string | null
  sentry_baggage: string | null
  request_id: string | null
  capture_session_id: string | null
}

type RentalStateRow = {
  id: string
  status: string
  state_version: number
  returned_at: string | null
  returned_by: string | null
  closed_at: string | null
  closed_by: string | null
}

function rentalRowToSnapshot(row: RentalStateRow): RentalWorkflowSnapshot {
  return {
    state: row.status as RentalWorkflowSnapshot['state'],
    state_version: row.state_version,
    returned_at: row.returned_at ?? null,
    returned_by: row.returned_by ?? null,
    closed_at: row.closed_at ?? null,
    closed_by: row.closed_by ?? null,
  }
}

/**
 * Dispatch the worker-only cadence transitions (INVOICE_QUEUED →
 * INVOICE_POSTED) through the rental reducer and persist the advanced
 * state_version. The qbo_invoice_id is carried on the event payloads (and the
 * sync_event audit row) — the rental table has no qbo_invoice_id column, and
 * doesn't need one: the snapshot's `state` round-trips back to `returned` for
 * the next cadence cycle. Returns the post-transition state_version, or null
 * when the rental row vanished mid-tx.
 */
async function applyRentalCadenceTransitions(
  client: QueueClient,
  companyId: string,
  rentalId: string,
  qboInvoiceId: string,
  trace?: TraceContext,
): Promise<number | null> {
  const lockResult = await client.query<RentalStateRow>(
    `select id, status, state_version, returned_at, returned_by, closed_at, closed_by
       from rentals
      where company_id = $1 and id = $2 and deleted_at is null
      for update`,
    [companyId, rentalId],
  )
  const current = lockResult.rows[0]
  if (!current) return null
  // Belt-and-braces: only an already-RETURNED rental walks the cadence cycle.
  // A concurrent CLOSE / RETURN race or a re-claim after the cycle already ran
  // (status back at 'returned' but at a higher state_version) is handled by
  // the appendWorkflowEvent conflict guard, but if the row moved OFF 'returned'
  // entirely (e.g. a human CLOSE landed first) we must NOT force an illegal
  // transition — cede to the human event and mark the outbox row applied.
  if (current.status !== 'returned') return current.state_version

  const startVersion = current.state_version
  let snapshot = rentalRowToSnapshot(current)

  // returned → invoiced_pending
  const queued = transitionRentalWorkflow(snapshot, { type: 'INVOICE_QUEUED' })
  await appendWorkflowEvent(client, {
    companyId,
    workflowName: RENTAL_WORKFLOW_NAME,
    schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
    entityType: 'rental',
    entityId: rentalId,
    stateVersion: snapshot.state_version,
    eventType: 'INVOICE_QUEUED',
    eventPayload: { type: 'INVOICE_QUEUED', qbo_invoice_id: qboInvoiceId },
    snapshotAfter: queued as unknown as Record<string, unknown>,
    actorUserId: null,
    ...(trace ? { trace } : {}),
  })
  snapshot = queued

  // invoiced_pending → returned (next cadence cycle starts)
  const posted = transitionRentalWorkflow(snapshot, { type: 'INVOICE_POSTED' })
  await appendWorkflowEvent(client, {
    companyId,
    workflowName: RENTAL_WORKFLOW_NAME,
    schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
    entityType: 'rental',
    entityId: rentalId,
    stateVersion: snapshot.state_version,
    eventType: 'INVOICE_POSTED',
    eventPayload: { type: 'INVOICE_POSTED', qbo_invoice_id: qboInvoiceId },
    snapshotAfter: posted as unknown as Record<string, unknown>,
    actorUserId: null,
    ...(trace ? { trace } : {}),
  })

  // Persist the advanced state_version so the next cadence cycle records at a
  // fresh version (the `do nothing` conflict guard relies on this). Guard the
  // write on the version we read under the lock so a concurrent path can't
  // clobber a newer state_version with our stale one.
  await client.query(
    `update rentals set state_version = $3, version = version + 1, updated_at = now()
      where company_id = $1 and id = $2 and state_version = $4`,
    [companyId, rentalId, posted.state_version, startVersion],
  )
  return posted.state_version
}

async function recordRentalInvoiceSyncEvent(
  client: QueueClient,
  companyId: string,
  rentalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status)
     values ($1, null, 'outbound', 'rental', $2, $3::jsonb, 'applied')`,
    [companyId, rentalId, JSON.stringify(payload)],
  )
}

export async function processRentalInvoicePush(
  client: QueueClient,
  companyId: string,
  push: RentalInvoicePushFn,
  limit = 5,
): Promise<RentalInvoicePushSummary> {
  // Phase 1: claim. Own transaction so the 'processing' marker is durable even
  // if every per-row work tx fails. next_attempt_at = now()+5min keeps a row
  // off the claim list until either a per-row tx commits a final state OR the
  // 5-minute lease elapses (watchdog path). Identical to rental-billing.
  await client.query('begin')
  let claimed: { rows: ClaimedRentalInvoicePushRow[]; rowCount: number | null }
  try {
    const result = await client.query<ClaimedRentalInvoicePushRow>(
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
          and entity_type = 'rental'
          and mutation_type = 'post_rental_invoice'
          and (
            (status = 'pending' and next_attempt_at <= now())
            or (status = 'processing' and next_attempt_at <= now())
          )
        order by next_attempt_at asc, created_at asc
        limit $2
        for update skip locked
      )
      returning id, entity_id, payload, attempt_count, sentry_trace, sentry_baggage, request_id, capture_session_id
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

  // Phase 2: per-row work, each in its own transaction.
  for (const row of claimed.rows) {
    const rentalId = row.entity_id
    const rowTrace: TraceContext = {
      sentry_trace: row.sentry_trace,
      sentry_baggage: row.sentry_baggage,
      request_id: row.request_id,
      capture_session_id: row.capture_session_id ?? null,
    }
    await client.query('begin')
    try {
      const existing = await client.query<{ status: string; state_version: number }>(
        `select status, state_version from rentals
         where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [companyId, rentalId],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        await client.query(
          `update mutation_outbox set status = 'failed', error = $3, applied_at = now()
           where company_id = $1 and id = $2`,
          [companyId, row.id, 'rental not found'],
        )
        await client.query('commit')
        failed += 1
        continue
      }
      if (existingRow.status !== 'returned') {
        // The rental already moved off 'returned' — either a prior tick already
        // ran this cadence cycle (idempotent replay) or a human CLOSE landed.
        // Mark the outbox row applied without re-pushing to QBO; the cadence is
        // already recorded (or deliberately superseded).
        await recordRentalInvoiceSyncEvent(client, companyId, rentalId, {
          action: 'invoice_posted',
          provider: 'qbo',
          idempotent_replay: true,
          rental_status: existingRow.status,
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
        rentalId,
        payload: row.payload,
        sentry_trace: row.sentry_trace,
        sentry_baggage: row.sentry_baggage,
      })
      const stateVersion = await applyRentalCadenceTransitions(
        client,
        companyId,
        rentalId,
        result.qbo_invoice_id,
        rowTrace,
      )
      await recordRentalInvoiceSyncEvent(client, companyId, rentalId, {
        action: 'invoice_posted',
        provider: 'qbo',
        external_id: result.qbo_invoice_id,
        state_version: stateVersion,
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
      await client.query('rollback').catch(() => {})
      // Best-effort: record a failed sync_event for the audit trail, then mark
      // the outbox row failed in a fresh tx. The outbox status update is the
      // load-bearing step for un-sticking the queue.
      try {
        await client.query('begin')
        await recordRentalInvoiceSyncEvent(client, companyId, rentalId, {
          action: 'invoice_failed',
          provider: 'qbo',
          error: message.slice(0, 1000),
        })
        await client.query('commit')
      } catch {
        await client.query('rollback').catch(() => {})
      }
      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] rental-invoice failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

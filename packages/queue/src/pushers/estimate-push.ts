import {
  ESTIMATE_PUSH_WORKFLOW_NAME,
  ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
  estimatePushRowToSnapshot,
  transitionEstimatePushWorkflow,
  type EstimatePushWorkflowEvent,
} from '@sitelayer/workflows'
import { appendWorkflowEvent, markOutboxRowFailedFresh, type QueueClient, type TraceContext } from '../index.js'

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
  // Trace continuation hints from the originating mutation_outbox row.
  // Passed through to the worker-side push fn so it can wrap the
  // external HTTP call in Sentry.continueTrace and keep the originating
  // API request's trace_id active across the API→DB→worker boundary.
  // Both nullable: rows enqueued before migration 079 (or by code paths
  // without Sentry context) won't carry trace headers.
  sentry_trace?: string | null
  sentry_baggage?: string | null
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
  trace?: TraceContext,
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

  // Route the worker-emitted transition through the SAME pure reducer the
  // human event route uses (transitionEstimatePushWorkflow), instead of
  // hand-writing the posting→posted / posting→failed SQL + state_version
  // bump. The clock value and QBO id / error string are event PAYLOAD —
  // the reducer reads them off the event and never calls Date.now(). The
  // SQL below is now one generic "write this snapshot" UPDATE.
  const event: EstimatePushWorkflowEvent =
    outcome.kind === 'succeeded'
      ? { type: 'POST_SUCCEEDED', posted_at: new Date().toISOString(), qbo_estimate_id: outcome.qbo_estimate_id }
      : { type: 'POST_FAILED', failed_at: new Date().toISOString(), error: outcome.error.slice(0, 1000) }

  // assertEstimatePushTransition throws if `current` isn't in 'posting';
  // the status guard above already prevents that, so a throw here is a
  // real bug signal that propagates to the per-row catch in
  // processEstimatePush (which records POST_FAILED + requeues).
  const nextSnapshot = transitionEstimatePushWorkflow(estimatePushRowToSnapshot(current), event)

  const updated = await client.query<EstimatePushStateRow>(
    `update estimate_pushes
       set status = $3,
           state_version = $4,
           reviewed_at = $5,
           reviewed_by = $6,
           approved_at = $7,
           approved_by = $8,
           posted_at = $9,
           failed_at = $10,
           error = $11,
           qbo_estimate_id = $12,
           version = version + 1,
           updated_at = now()
     where company_id = $1 and id = $2
     returning id, status, state_version, qbo_estimate_id,
               reviewed_at, reviewed_by, approved_at, approved_by,
               posted_at, failed_at, error`,
    [
      companyId,
      pushId,
      nextSnapshot.state,
      nextSnapshot.state_version,
      nextSnapshot.reviewed_at ?? null,
      nextSnapshot.reviewed_by ?? null,
      nextSnapshot.approved_at ?? null,
      nextSnapshot.approved_by ?? null,
      nextSnapshot.posted_at ?? null,
      nextSnapshot.failed_at ?? null,
      nextSnapshot.error ?? null,
      nextSnapshot.qbo_estimate_id ?? null,
    ],
  )
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: ESTIMATE_PUSH_WORKFLOW_NAME,
      schemaVersion: ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
      entityType: 'estimate_push',
      entityId: pushId,
      stateVersion: beforeVersion,
      eventType: event.type,
      eventPayload: event as unknown as Record<string, unknown>,
      snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
      ...(trace ? { trace } : {}),
    })
  }
  return row
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
  // Phase 1: claim in its own tx — see processRentalBillingInvoicePush
  // for the structural rationale; same shape applies here.
  await client.query('begin')
  let claimed: {
    rows: Array<
      {
        id: string
        entity_id: string
        payload: Record<string, unknown>
        attempt_count: number
      } & TraceContext
    >
    rowCount: number | null
  }
  try {
    const result = await client.query<
      {
        id: string
        entity_id: string
        payload: Record<string, unknown>
        attempt_count: number
      } & TraceContext
    >(
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

  // Phase 2: per-row work in its own tx.
  for (const row of claimed.rows) {
    const pushId = row.entity_id
    // Propagate the originating sentry-trace + baggage + request_id from the
    // outbox row into the worker-emitted workflow_event_log row. See
    // processRentalBillingInvoicePush for the same wiring.
    const rowTrace: TraceContext = {
      sentry_trace: row.sentry_trace,
      sentry_baggage: row.sentry_baggage,
      request_id: row.request_id,
      capture_session_id: row.capture_session_id ?? null,
    }
    await client.query('begin')
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
        await client.query('commit')
        failed += 1
        continue
      }
      if (existingRow.qbo_estimate_id && existingRow.status === 'posting') {
        // Replay-safe: previous push succeeded but outbox row never marked
        // applied. Emit POST_SUCCEEDED with the existing id, no second QBO call.
        await applyEstimatePushWorkerEvent(
          client,
          companyId,
          pushId,
          {
            kind: 'succeeded',
            qbo_estimate_id: existingRow.qbo_estimate_id,
          },
          rowTrace,
        )
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
        await client.query('commit')
        skipped += 1
        continue
      }

      const result = await push({
        client,
        companyId,
        pushId,
        payload: row.payload,
        sentry_trace: row.sentry_trace,
        sentry_baggage: row.sentry_baggage,
      })
      const updated = await applyEstimatePushWorkerEvent(
        client,
        companyId,
        pushId,
        {
          kind: 'succeeded',
          qbo_estimate_id: result.qbo_estimate_id,
        },
        rowTrace,
      )
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
      await client.query('commit')
      posted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await client.query('rollback').catch(() => {})

      // Best-effort recovery in a fresh tx; identical pattern to
      // processRentalBillingInvoicePush.
      try {
        await client.query('begin')
        await applyEstimatePushWorkerEvent(
          client,
          companyId,
          row.entity_id,
          {
            kind: 'failed',
            error: message,
          },
          rowTrace,
        )
        await recordEstimatePushSyncEvent(client, companyId, row.entity_id, {
          action: 'post_failed',
          provider: 'qbo',
          error: message,
        })
        await client.query('commit')
      } catch (recoveryErr) {
        await client.query('rollback').catch(() => {})
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] estimate-push recovery path threw',
          { pushId: row.entity_id, originalError: message, recoveryError: recoveryErr },
        )
      }

      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] estimate-push failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, posted, failed, skipped }
}

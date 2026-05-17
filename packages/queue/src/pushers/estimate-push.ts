import {
  appendWorkflowEvent,
  markOutboxRowFailedFresh,
  type QueueClient,
  type TraceContext,
} from '../index.js'

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
        ...(trace ? { trace } : {}),
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
      ...(trace ? { trace } : {}),
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

      const result = await push({ client, companyId, pushId, payload: row.payload })
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

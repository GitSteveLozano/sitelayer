import { markOutboxRowFailedFresh, type QueueClient, type TraceContext } from '../index.js'

// ---------------------------------------------------------------------------
// QBO reference-data PULL handler.
//
// The mirror image of processEstimatePush: instead of pushing a sitelayer
// entity OUT to QBO, it pulls QBO Customers + Items + Classes IN and upserts
// customers / service_items / integration_mappings. Same outbox/leased
// envelope, same FOR UPDATE SKIP LOCKED claim SQL (copied verbatim from
// processEstimatePush so the lease semantics can't drift), same per-row tx
// and 15-minute failed-row backoff.
//
// Idempotency contract differs from push deliberately:
//   - push   keys per workflow run id (one outbox row per run).
//   - pull   keys per connection (`integration_connection:qbo:pull:<connId>`)
//     — a single recurring backfill job per QBO connection. The API enqueue
//     route re-arms a finished row (applied/failed/dead → pending) so a
//     second "Backfill" click after a completed pull runs again rather than
//     hitting the UNIQUE(company_id, idempotency_key) no-op forever.
//
// This module owns the lease/tx/idempotency envelope ONLY. The actual QBO
// HTTP calls + the customers/service_items/integration_mappings upsert SQL
// live in the injected `pull` fn (apps/worker/src/qbo-pull.ts), exactly as
// processEstimatePush delegates the HTTP to the injected `push` fn. The pull
// fn writes through the SAME `client` the lease holds, so its work commits /
// rolls back atomically with the per-row tx.
//
//   - on success: write an inbound sync_events breadcrumb, stamp
//     integration_connections (last_synced_at / sync_cursor / status), mark
//     the outbox row applied.
//   - on throw:   markOutboxRowFailedFresh (parks the row at the terminal
//     'failed' status — re-armed by the backfill re-click upsert in
//     routes/qbo.ts, NOT by any automatic retry) + an inbound sync_events
//     failure row. The pull fn is allowed to throw on any failure, same
//     contract as the estimate push fn.
// ---------------------------------------------------------------------------

export type QboPullInput = {
  client: QueueClient
  companyId: string
  connectionId: string
  payload: Record<string, unknown>
  // Trace continuation hints from the originating mutation_outbox row.
  // Passed through to the worker-side pull fn so it can wrap the external
  // HTTP calls in Sentry.continueTrace and keep the originating API
  // request's trace_id active across the API→DB→worker boundary. Both
  // nullable for rows enqueued by code paths without Sentry context.
  sentry_trace?: string | null
  sentry_baggage?: string | null
}

export type QboPullResult = {
  pulledCustomers: number
  pulledItems: number
  pulledClasses: number
}

export type QboPullFn = (input: QboPullInput) => Promise<QboPullResult>

export type QboPullSummary = {
  processed: number
  pulled: number
  failed: number
  skipped: number
}

async function recordQboPullSyncEvent(
  client: QueueClient,
  companyId: string,
  connectionId: string,
  payload: Record<string, unknown>,
  status: 'applied' | 'failed' = 'applied',
  error: string | null = null,
): Promise<void> {
  await client.query(
    `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status, error)
     values ($1, $2, 'inbound', 'qbo_pull', $3, $4::jsonb, $5, $6)`,
    [companyId, connectionId, connectionId, JSON.stringify(payload), status, error],
  )
}

/**
 * Claim and apply up to `limit` (default 1) pull_qbo_reference outbox rows
 * for the given company. The pull is a single recurring job per connection,
 * so the default limit is 1; the array shape is kept to mirror
 * processEstimatePush exactly.
 */
export async function processQboPull(
  client: QueueClient,
  companyId: string,
  pull: QboPullFn,
  limit = 1,
): Promise<QboPullSummary> {
  // Phase 1: claim in its own tx — copied verbatim from processEstimatePush
  // (entity_type / mutation_type swapped). Do NOT fork this lease SQL.
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
          and entity_type = 'integration_connection'
          and mutation_type = 'pull_qbo_reference'
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

  let pulled = 0
  let failed = 0
  const skipped = 0

  // Phase 2: per-row work in its own tx.
  for (const row of claimed.rows) {
    const connectionId = row.entity_id
    await client.query('begin')
    try {
      // Bind app.company_id for the lifetime of this tx so the FORCE'd RLS
      // policies on customers / service_items / integration_mappings accept
      // the WITH CHECK on every INSERT/UPDATE the pull fn performs. The push
      // pushers rely on the unset-NULL permissive branch; setting the GUC
      // explicitly here is strictly stronger (cross-company writes are
      // rejected at the DB) and mirrors withMutationTx's scoped-write seam.
      // SET LOCAL is scoped to this tx; the connection returns clean.
      await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])

      const result = await pull({
        client,
        companyId,
        connectionId,
        payload: row.payload,
        sentry_trace: row.sentry_trace,
        sentry_baggage: row.sentry_baggage,
      })

      await recordQboPullSyncEvent(client, companyId, connectionId, {
        action: 'pull_succeeded',
        provider: 'qbo',
        counts: {
          customers: result.pulledCustomers,
          items: result.pulledItems,
          classes: result.pulledClasses,
        },
      })

      // Stamp the connection like the inline /sync path's success tail does.
      await client.query(
        `update integration_connections
           set last_synced_at = now(),
               sync_cursor = $2,
               status = 'connected',
               version = version + 1
         where company_id = $1 and id = $3`,
        [companyId, new Date().toISOString(), connectionId],
      )

      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
      pulled += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      await client.query('rollback').catch(() => {})

      // Best-effort failure breadcrumb in a fresh tx; identical pattern to
      // processEstimatePush's recovery path.
      try {
        await client.query('begin')
        await recordQboPullSyncEvent(
          client,
          companyId,
          connectionId,
          { action: 'pull_failed', provider: 'qbo', error: message },
          'failed',
          message.slice(0, 1000),
        )
        await client.query('commit')
      } catch (recoveryErr) {
        await client.query('rollback').catch(() => {})
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] qbo-pull recovery path threw',
          { connectionId, originalError: message, recoveryError: recoveryErr },
        )
      }

      try {
        await markOutboxRowFailedFresh(client, companyId, row.id, message)
        failed += 1
      } catch (markErr) {
        ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(
          '[queue] qbo-pull failed to mark outbox row failed; will be re-claimed after lease',
          { outboxId: row.id, error: markErr },
        )
      }
    }
  }

  return { processed: claimed.rowCount ?? 0, pulled, failed, skipped }
}

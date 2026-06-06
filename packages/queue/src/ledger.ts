import type { QueueClient } from './index.js'

export type LedgerTraceContext = {
  sentryTrace?: string | null
  sentryBaggage?: string | null
  requestId?: string | null
}

export type RecordLedgerArgs = {
  companyId: string
  entityType: string
  entityId: string
  /** sync_events.payload (and outbox payload by default). */
  syncPayload: Record<string, unknown>
  /** mutation_outbox.payload override; defaults to syncPayload. */
  outboxPayload?: Record<string, unknown>
  /** mutation_outbox.mutation_type. */
  mutationType: string
  /** mutation_outbox idempotency_key (one row per logical mutation). */
  idempotencyKey: string
  /** sync_events.integration_connection_id. */
  integrationConnectionId?: string | null
  /** mutation_outbox.device_id (defaults to 'worker'). */
  deviceId?: string
  /** mutation_outbox.actor_user_id (defaults to null). */
  actorUserId?: string | null
  /** sync_events.status (defaults to 'pending'). */
  syncStatus?: 'pending' | 'failed'
  /** sync_events.error column. */
  syncError?: string | null
  trace?: LedgerTraceContext
}

/**
 * Write the sync_events + mutation_outbox pair using a caller-supplied
 * QueueClient (typically a PoolClient inside BEGIN/COMMIT). Mirrors the API
 * server's recordMutationLedger so the worker can produce identical ledger
 * rows for jobs it generates (e.g. auto-billed rental invoices).
 */
export async function recordLedger(client: QueueClient, args: RecordLedgerArgs): Promise<void> {
  const sentryTrace = args.trace?.sentryTrace ?? null
  const sentryBaggage = args.trace?.sentryBaggage ?? null
  const requestId = args.trace?.requestId ?? null
  const status = args.syncStatus ?? 'pending'
  await client.query(
    `
    insert into sync_events (
      company_id, integration_connection_id, direction, entity_type, entity_id, payload, status,
      sentry_trace, sentry_baggage, request_id, error
    )
    values ($1, $2, 'local', $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
    `,
    [
      args.companyId,
      args.integrationConnectionId ?? null,
      args.entityType,
      args.entityId,
      JSON.stringify(args.syncPayload),
      status,
      sentryTrace,
      sentryBaggage,
      requestId,
      args.syncError ?? null,
    ],
  )
  await client.query(
    `
    insert into mutation_outbox (
      company_id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status,
      sentry_trace, sentry_baggage, request_id
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending', $9, $10, $11)
    on conflict (company_id, idempotency_key) do update
      set payload = excluded.payload,
          status = 'pending',
          attempt_count = mutation_outbox.attempt_count + 1,
          next_attempt_at = now(),
          sentry_trace = excluded.sentry_trace,
          sentry_baggage = excluded.sentry_baggage,
          request_id = excluded.request_id
    `,
    [
      args.companyId,
      args.deviceId ?? 'worker',
      args.actorUserId ?? null,
      args.entityType,
      args.entityId,
      args.mutationType,
      JSON.stringify(args.outboxPayload ?? args.syncPayload),
      args.idempotencyKey,
      sentryTrace,
      sentryBaggage,
      requestId,
    ],
  )
}

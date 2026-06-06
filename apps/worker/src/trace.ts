import * as Sentry from '@sentry/node'
import { createLogger, runWithRequestContext } from '@sitelayer/logger'
import type { ProcessedOutboxRow, ProcessedSyncEventRow } from '@sitelayer/queue'

const logger = createLogger('worker')

export type RowWithTrace = Pick<
  ProcessedOutboxRow | ProcessedSyncEventRow,
  'id' | 'entity_type' | 'sentry_trace' | 'sentry_baggage' | 'request_id'
> & { kind: 'outbox' | 'sync_event' }

/**
 * Wrap `fn` inside `Sentry.continueTrace` when the originating row carries
 * sentry-trace + baggage. Worker-side companion to the API's ingress
 * continuation in apps/api/src/trace-ingress.ts: closes the API→DB→worker
 * handoff so an external HTTP call (QBO push, email send) executed by the
 * worker shares the originating API request's trace_id, not a fresh
 * worker-generated one.
 *
 * When the row has no trace info (legacy rows, internal-only mutations,
 * pre-migration-079 backfills), the wrap is skipped and the worker
 * generates its own trace context. Preserves pre-patch behaviour for
 * those rows.
 */
export function withRowTrace<T>(
  row: { sentry_trace?: string | null | undefined; sentry_baggage?: string | null | undefined },
  fn: () => T,
): T {
  if (!row.sentry_trace) {
    return fn()
  }
  return Sentry.continueTrace(
    {
      sentryTrace: row.sentry_trace,
      baggage: row.sentry_baggage ?? undefined,
    },
    fn,
  )
}

export function spanForAppliedRow(row: RowWithTrace) {
  const continueParams = {
    sentryTrace: row.sentry_trace ?? undefined,
    baggage: row.sentry_baggage ?? undefined,
  }
  const ctx = { requestId: row.request_id ?? `worker-${row.id}` }
  Sentry.continueTrace(continueParams, () => {
    runWithRequestContext(ctx, () => {
      Sentry.startSpan(
        {
          name: `queue.apply ${row.kind} ${row.entity_type}`,
          op: 'queue.process',
          attributes: {
            'queue.kind': row.kind,
            'queue.row_id': row.id,
            'queue.entity_type': row.entity_type,
            request_id: row.request_id ?? undefined,
          },
        },
        () => {
          logger.info(
            { queue_kind: row.kind, row_id: row.id, entity_type: row.entity_type, request_id: row.request_id },
            'queue row applied',
          )
        },
      )
    })
  })
}

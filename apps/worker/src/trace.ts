import * as Sentry from '@sentry/node'
import { createLogger, runWithRequestContext } from '@sitelayer/logger'
import type { ProcessedOutboxRow, ProcessedSyncEventRow } from '@sitelayer/queue'

const logger = createLogger('worker')

export type RowWithTrace = Pick<
  ProcessedOutboxRow | ProcessedSyncEventRow,
  'id' | 'entity_type' | 'sentry_trace' | 'sentry_baggage' | 'request_id'
> & { kind: 'outbox' | 'sync_event' }

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

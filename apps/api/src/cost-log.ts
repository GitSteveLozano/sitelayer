/**
 * Per-company cost logging.
 *
 * Records a single billable event in `company_usage_log` (migration 086).
 * The intent is to make the substrate for future quotas / billing visible
 * today, so we can calibrate placeholder cost numbers against real usage
 * before any enforcement lands.
 *
 * Call this inside an existing `withMutationTx` / `withCompanyClient`
 * closure — pass the same PoolClient through so the insert ledger is
 * scoped to the same transaction as the operation it describes (and the
 * same `app.company_id` GUC for RLS). Opening a fresh transaction just
 * for the cost log would be wasted overhead and would split the audit
 * trail across two `now()` timestamps.
 *
 * `recordCostLog` is intentionally side-effecting only: callers should
 * not depend on its return value, and errors propagate. If the surrounding
 * tx rolls back (e.g. the QBO push it logs the cost for actually failed
 * post-commit), the cost row rolls back with it — which is what we want,
 * because a rolled-back QBO call shouldn't show up in usage.
 */
import type { PoolClient } from 'pg'

export interface CostLogEntry {
  companyId: string
  operation: string
  costUsd: number
  description?: string
  requestId?: string | null
  sentryTrace?: string | null
  metadata?: Record<string, unknown>
}

export async function recordCostLog(client: PoolClient, entry: CostLogEntry): Promise<void> {
  await client.query(
    `insert into company_usage_log (
       company_id, operation, cost_usd, description, request_id, sentry_trace, metadata
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.companyId,
      entry.operation,
      entry.costUsd.toFixed(6),
      entry.description ?? null,
      entry.requestId ?? null,
      entry.sentryTrace ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  )
}

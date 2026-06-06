import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { pruneAppliedQueue } from '@sitelayer/queue'
import { observeQueuePruneOrGc } from '../metrics.js'

export interface QueuePruneSummary {
  ran: boolean
  mutation_outbox: number
  sync_events: number
}

export interface QueuePruneRunner {
  /**
   * Run a prune pass if more than `intervalMs` has elapsed since the
   * last successful run (process-local gate). Safe to invoke from every
   * heartbeat; gate ensures the actual DELETE only fires once per day.
   * Returns `{ ran: false }` when the gate prevented the run.
   */
  maybePrune(): Promise<QueuePruneSummary>
  /** Force a prune (used by tests). */
  forcePrune(): Promise<QueuePruneSummary>
}

/**
 * Daily prune of long-applied rows in `mutation_outbox` and
 * `sync_events`. Both tables grow forever once `applied_at IS NOT
 * NULL` because nothing reclaims them — they're an audit trail, not
 * a work queue. After the retention window they're operationally
 * useless (trace ids aged out of Sentry, QBO pushes long since
 * reconciled) but they keep bloating the table and slowing
 * autovacuum.
 *
 * We deliberately don't add a new `worker_periodic_task_runs` table
 * for the cadence gate — the DELETE is idempotent (gated by `applied_at
 * < now() - retention`) so a process restart that loses the in-memory
 * `lastRunAt` only costs us one extra prune, which is a no-op when no
 * new rows have aged in. If we ever run a multi-worker fleet on the
 * same DB, the duplicate runs are still safe; the only cost is
 * CPU/IO on the DELETE we already had to do anyway.
 *
 * Env knobs:
 *   QUEUE_APPLIED_RETENTION_DAYS — default 90
 *   QUEUE_PRUNE_INTERVAL_MS      — default 24h
 */
export function createQueuePruneRunner(deps: { pool: Pool; logger: Logger }): QueuePruneRunner {
  const { pool, logger } = deps

  const retentionDays = (() => {
    const raw = Number(process.env.QUEUE_APPLIED_RETENTION_DAYS ?? 90)
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 90
  })()
  const intervalMs = (() => {
    const raw = Number(process.env.QUEUE_PRUNE_INTERVAL_MS ?? 24 * 60 * 60 * 1000)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24 * 60 * 60 * 1000
  })()

  // Process-local last-run timestamp. A worker restart resets it,
  // which causes one extra prune on first heartbeat after boot — that
  // prune is a no-op when no rows have aged in, so we tolerate it
  // rather than persist state.
  let lastRunAt = 0

  async function runPrune(): Promise<QueuePruneSummary> {
    const client = await pool.connect()
    try {
      const result = await pruneAppliedQueue(client, { retentionDays })
      observeQueuePruneOrGc('mutation_outbox', 'pruned', result.mutation_outbox)
      observeQueuePruneOrGc('sync_events', 'pruned', result.sync_events)
      logger.info(
        {
          retention_days: retentionDays,
          mutation_outbox_pruned: result.mutation_outbox,
          sync_events_pruned: result.sync_events,
        },
        '[queue-prune] tick',
      )
      lastRunAt = Date.now()
      return { ran: true, ...result }
    } catch (err) {
      observeQueuePruneOrGc('mutation_outbox', 'failed')
      observeQueuePruneOrGc('sync_events', 'failed')
      logger.warn({ err, retention_days: retentionDays }, '[queue-prune] failed')
      throw err
    } finally {
      client.release()
    }
  }

  return {
    async maybePrune() {
      if (Date.now() - lastRunAt < intervalMs) {
        return { ran: false, mutation_outbox: 0, sync_events: 0 }
      }
      return runPrune()
    },
    forcePrune: runPrune,
  }
}

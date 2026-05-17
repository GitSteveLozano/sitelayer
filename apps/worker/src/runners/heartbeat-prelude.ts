import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { CircuitBreaker, deadLetterStaleOutbox } from '@sitelayer/queue'
import { captureMessageWithEntityContext } from '../instrument.js'

export interface HeartbeatPreludeDeps {
  pool: Pool
  logger: Logger
  qboCircuit: CircuitBreaker
  mutationMaxRetries: number
  qboCircuitCooldownMs: number
}

export function createHeartbeatPrelude(deps: HeartbeatPreludeDeps) {
  const { pool, logger, qboCircuit, mutationMaxRetries, qboCircuitCooldownMs } = deps

  async function sweepDeadLetters(companyId: string): Promise<void> {
    // Dead-letter outbox rows whose attempt_count has crossed the retry cap.
    // Runs before any drain so a broken row never gets re-claimed. Logs the
    // count when non-zero — operators can investigate via /api/system/mutation-outbox.
    try {
      const deadClient = await pool.connect()
      try {
        const dead = await deadLetterStaleOutbox(deadClient, companyId, mutationMaxRetries)
        if (dead > 0) {
          logger.warn(
            { company_id: companyId, dead, cap: mutationMaxRetries },
            '[worker] dead-lettered stale outbox rows',
          )
          captureMessageWithEntityContext('outbox rows dead-lettered', {
            level: 'warning',
            scope: 'mutation_outbox_dead_letter',
            entity_type: 'mutation_outbox',
            company_id: companyId,
            extra: { dead, cap: mutationMaxRetries },
          })
        }
      } finally {
        deadClient.release()
      }
    } catch (err) {
      // Dead-letter is best-effort; a transient DB hiccup shouldn't halt the heartbeat.
      logger.warn({ err }, '[worker] dead-letter sweep failed')
    }
  }

  async function deferQboOutboxIfCircuitOpen(companyId: string): Promise<void> {
    // If the QBO circuit is open, defer all pending QBO-bound outbox rows by
    // the cooldown window. Otherwise their next_attempt_at fires every 5min
    // and burns failures (and attempt_count) at the breaker.
    if (qboCircuit.isOpen('qbo')) {
      try {
        await pool.query(
          `update mutation_outbox
             set next_attempt_at = greatest(next_attempt_at, now() + ($2 || ' milliseconds')::interval)
             where company_id = $1
               and mutation_type in ('post_qbo_invoice', 'post_qbo_estimate', 'post_qbo_time_activity')
               and status in ('pending', 'processing')`,
          [companyId, String(qboCircuitCooldownMs)],
        )
      } catch (err) {
        logger.warn({ err }, '[worker] failed to defer QBO outbox under open circuit')
      }
    }
  }

  return {
    sweepDeadLetters,
    deferQboOutboxIfCircuitOpen,
  }
}

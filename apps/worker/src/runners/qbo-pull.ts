import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processQboPull,
  withCircuitBreaker,
  type QboPullFn,
  type QboPullSummary,
} from '@sitelayer/queue'
import { createQboPull } from '../qbo-pull.js'
import { withRowTrace } from '../trace.js'

// Stub pull — returns zero counts. Ships default (QBO_LIVE_QBO_PULL unset),
// exactly as the estimate-push runner ships stub-default. The stub still
// exercises the full lease/tx/idempotency envelope (claim → success →
// applied → sync_events), it just makes no QBO HTTP call.
const stubQboPull: QboPullFn = async () => {
  return { pulledCustomers: 0, pulledItems: 0, pulledClasses: 0 }
}

export function createQboPullRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  const liveQboPullEnabled = process.env.QBO_LIVE_QBO_PULL === '1'
  const qboPullBase: QboPullFn = liveQboPullEnabled ? createQboPull() : stubQboPull
  // Wrap the QBO pull (and the circuit breaker around it) inside the row's
  // originating Sentry trace, same as the estimate-push runner. withRowTrace
  // continues the trace when the claimed mutation_outbox row carries
  // sentry_trace + baggage so the external HTTP calls inherit the originating
  // API request's trace_id.
  const qboPull: QboPullFn = (input) =>
    withRowTrace(input, () => withCircuitBreaker(qboCircuit, 'qbo', () => qboPullBase(input)))

  if (liveQboPullEnabled) {
    logger.info('[qbo-pull] live QBO reference pull enabled')
  } else {
    logger.info('[qbo-pull] stub QBO reference pull (set QBO_LIVE_QBO_PULL=1 to go live)')
  }

  return async function drainQboPull(companyId: string): Promise<QboPullSummary> {
    // See drainEstimatePushes — same transaction-scope contract: one client
    // checked out for the claim + per-row work, released after.
    const client = await pool.connect()
    try {
      return await processQboPull(client, companyId, qboPull, 1)
    } finally {
      client.release()
    }
  }
}

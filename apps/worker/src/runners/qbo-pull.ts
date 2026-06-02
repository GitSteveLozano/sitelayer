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
import { resolveCompanyQboLive } from '../qbo-live.js'

// Stub pull — returns zero counts. Ships default (every company dry-run),
// exactly as the estimate-push runner ships stub-default. The stub still
// exercises the full lease/tx/idempotency envelope (claim → success →
// applied → sync_events), it just makes no QBO HTTP call.
const stubQboPull: QboPullFn = async () => {
  return { pulledCustomers: 0, pulledItems: 0, pulledClasses: 0 }
}

export function createQboPullRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  // PER-COMPANY live gating (multi-tenant). QBO_LIVE_QBO_PULL is now a
  // cluster-wide kill switch; the live decision is resolved per company at
  // drain time (global-env-on AND integration_connections.qbo_live_enabled).
  const liveBase = createQboPull()
  const buildQboPull = (live: boolean): QboPullFn => {
    const base: QboPullFn = live ? liveBase : stubQboPull
    // Wrap the QBO pull (and the circuit breaker around it) inside the row's
    // originating Sentry trace, same as the estimate-push runner. withRowTrace
    // continues the trace when the claimed mutation_outbox row carries
    // sentry_trace + baggage so the external HTTP calls inherit the originating
    // API request's trace_id.
    return (input) => withRowTrace(input, () => withCircuitBreaker(qboCircuit, 'qbo', () => base(input)))
  }

  if (process.env.QBO_LIVE_QBO_PULL === '1') {
    logger.info('[qbo-pull] QBO_LIVE_QBO_PULL kill switch ON — live per company where qbo_live_enabled=true')
  } else {
    logger.info('[qbo-pull] QBO_LIVE_QBO_PULL kill switch OFF — every company stub/dry-run')
  }

  return async function drainQboPull(companyId: string): Promise<QboPullSummary> {
    // See drainEstimatePushes — same transaction-scope contract: one client
    // checked out for the claim + per-row work, released after.
    const client = await pool.connect()
    try {
      const live = await resolveCompanyQboLive(client, companyId, 'QBO_LIVE_QBO_PULL')
      const qboPull = buildQboPull(live)
      return await processQboPull(client, companyId, qboPull, 1)
    } finally {
      client.release()
    }
  }
}

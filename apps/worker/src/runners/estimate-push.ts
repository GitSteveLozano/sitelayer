import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processEstimatePush,
  withCircuitBreaker,
  type EstimatePushFn,
  type EstimatePushSummary,
} from '@sitelayer/queue'
import { observeWorkflowEvent } from '../metrics.js'
import { createQboEstimatePush } from '../qbo-estimate-push.js'
import { withRowTrace } from '../trace.js'

const stubEstimatePush: EstimatePushFn = async ({ pushId }) => {
  return { qbo_estimate_id: `STUB-EST-${pushId.slice(0, 8)}-${Date.now()}` }
}

export function createEstimatePushRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  const liveEstimatePushEnabled = process.env.QBO_LIVE_ESTIMATE_PUSH === '1'
  const estimatePushBase: EstimatePushFn = liveEstimatePushEnabled ? createQboEstimatePush() : stubEstimatePush
  // Wrap the QBO push (and the circuit breaker around it) inside the row's
  // originating Sentry trace. The pusher loop in @sitelayer/queue passes
  // sentry_trace + sentry_baggage from the claimed mutation_outbox row into
  // the EstimatePushInput; withRowTrace continues the trace if those fields
  // are present so the external HTTP call inherits the originating API
  // request's trace_id. Without this, the worker generated a fresh trace
  // per row and the API→DB→worker handoff visible in audit_events looked
  // like two disconnected traces. See apps/api/src/trace-ingress.ts for the
  // matching API-ingress side.
  const estimatePush: EstimatePushFn = (input) =>
    withRowTrace(input, () => withCircuitBreaker(qboCircuit, 'qbo', () => estimatePushBase(input)))

  if (liveEstimatePushEnabled) {
    logger.info('[estimate-push] live QBO estimate push enabled')
  } else {
    logger.info('[estimate-push] stub QBO estimate push (set QBO_LIVE_ESTIMATE_PUSH=1 to go live)')
  }

  return async function drainEstimatePushes(companyId: string): Promise<EstimatePushSummary> {
    // See drainRentalBillingInvoicePushes — same transaction-scope
    // contract.
    const client = await pool.connect()
    try {
      const summary = await processEstimatePush(client, companyId, estimatePush, 5)
      // Workflow lifecycle counters. POST_SUCCEEDED / POST_FAILED rows
      // are emitted inside processEstimatePush; mirror them into the
      // worker-side counter so operator dashboards can graph posted
      // vs failed rates per drain. `skipped` is an idempotent replay
      // (estimate already had qbo_estimate_id) — still a success.
      for (let i = 0; i < summary.posted; i += 1) observeWorkflowEvent('estimate_push', 'succeeded')
      for (let i = 0; i < summary.skipped; i += 1) observeWorkflowEvent('estimate_push', 'succeeded')
      for (let i = 0; i < summary.failed; i += 1) observeWorkflowEvent('estimate_push', 'failed')
      return summary
    } finally {
      client.release()
    }
  }
}

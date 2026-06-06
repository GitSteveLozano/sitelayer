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
import { qboCircuitKey } from '../qbo-circuit.js'
import { withRowTrace } from '../trace.js'
import { resolveCompanyQboLive } from '../qbo-live.js'

const stubEstimatePush: EstimatePushFn = async ({ pushId }) => {
  return { qbo_estimate_id: `STUB-EST-${pushId.slice(0, 8)}-${Date.now()}` }
}

export function createEstimatePushRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  // PER-COMPANY live gating (multi-tenant). The QBO_LIVE_ESTIMATE_PUSH env is
  // now a CLUSTER-WIDE KILL SWITCH; the actual live decision is resolved PER
  // COMPANY at drain time (global-env-on AND the company's
  // integration_connections.qbo_live_enabled). Both push fns are built once
  // at boot; the per-drain resolver selects between them so company #2 stays
  // dry-run while company #1 is live. DEFAULT is dry-run for every company.
  const liveBase = createQboEstimatePush()
  // Breaker key is PER COMPANY (qbo:<companyId>) so one tenant's revoked-token
  // / outage failures can't open the circuit for every other company's drain.
  const buildEstimatePush = (live: boolean, companyId: string): EstimatePushFn => {
    const base: EstimatePushFn = live ? liveBase : stubEstimatePush
    const key = qboCircuitKey(companyId)
    // Wrap the QBO push (and the circuit breaker around it) inside the row's
    // originating Sentry trace. The pusher loop in @sitelayer/queue passes
    // sentry_trace + sentry_baggage from the claimed mutation_outbox row into
    // the EstimatePushInput; withRowTrace continues the trace if those fields
    // are present so the external HTTP call inherits the originating API
    // request's trace_id. Without this, the worker generated a fresh trace
    // per row and the API→DB→worker handoff visible in audit_events looked
    // like two disconnected traces. See apps/api/src/trace-ingress.ts for the
    // matching API-ingress side.
    return (input) => withRowTrace(input, () => withCircuitBreaker(qboCircuit, key, () => base(input)))
  }

  if (process.env.QBO_LIVE_ESTIMATE_PUSH === '1') {
    logger.info('[estimate-push] QBO_LIVE_ESTIMATE_PUSH kill switch ON — live per company where qbo_live_enabled=true')
  } else {
    logger.info('[estimate-push] QBO_LIVE_ESTIMATE_PUSH kill switch OFF — every company stub/dry-run')
  }

  return async function drainEstimatePushes(companyId: string): Promise<EstimatePushSummary> {
    // See drainRentalBillingInvoicePushes — same transaction-scope
    // contract.
    const client = await pool.connect()
    try {
      const live = await resolveCompanyQboLive(client, companyId, 'QBO_LIVE_ESTIMATE_PUSH')
      const estimatePush = buildEstimatePush(live, companyId)
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

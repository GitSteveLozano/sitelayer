import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processRentalInvoicePush,
  withCircuitBreaker,
  type RentalInvoicePushFn,
  type RentalInvoicePushSummary,
} from '@sitelayer/queue'
import { observeWorkflowEvent } from '../metrics.js'
import { createQboRentalCadencePush } from '../qbo-rental-cadence-push.js'
import { qboCircuitKey } from '../qbo-circuit.js'
import { withRowTrace } from '../trace.js'
import { resolveCompanyQboLive } from '../qbo-live.js'

const stubRentalInvoicePush: RentalInvoicePushFn = async ({ rentalId }) => {
  // Deterministic synthetic id: same rentalId → same stub invoice id, so a
  // re-claim of the same outbox row (crash after the push, before the row was
  // marked applied) never invents a new external id.
  return { qbo_invoice_id: `STUB-RENT-INV-${rentalId.slice(0, 8)}` }
}

export function createRentalInvoicePushRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  // Rental cadence invoice push fn selection — PER COMPANY (multi-tenant),
  // identical gating to the rental_billing_run push (rental-billing-push.ts):
  //
  // Stub mode (default for every company): returns a synthetic invoice id so
  // the deterministic plumbing (cadence tick → outbox → worker →
  // INVOICE_QUEUED/INVOICE_POSTED) can be exercised end-to-end without QBO.
  //
  // Live mode: the real push fn builds a one-line rental invoice and POSTs it
  // to QBO. A company runs live ONLY when the cluster-wide kill switch
  // (QBO_LIVE_RENTAL_INVOICE=1) AND that company's
  // integration_connections.qbo_live_enabled are BOTH true; resolved per drain.
  const liveBase = createQboRentalCadencePush()
  const buildRentalInvoicePush = (live: boolean, companyId: string): RentalInvoicePushFn => {
    const base: RentalInvoicePushFn = live ? liveBase : stubRentalInvoicePush
    const key = qboCircuitKey(companyId)
    // Continue the originating trace into the QBO call. Same pattern as
    // rental-billing-push.ts.
    return (input) => withRowTrace(input, () => withCircuitBreaker(qboCircuit, key, () => base(input)))
  }

  if (process.env.QBO_LIVE_RENTAL_INVOICE === '1') {
    logger.info(
      '[rental-cadence] QBO_LIVE_RENTAL_INVOICE kill switch ON — live per company where qbo_live_enabled=true',
    )
  } else {
    logger.info('[rental-cadence] QBO_LIVE_RENTAL_INVOICE kill switch OFF — every company stub/dry-run')
  }

  return async function drainRentalInvoicePushes(companyId: string): Promise<RentalInvoicePushSummary> {
    const client = await pool.connect()
    try {
      const live = await resolveCompanyQboLive(client, companyId, 'QBO_LIVE_RENTAL_INVOICE')
      const rentalInvoicePush = buildRentalInvoicePush(live, companyId)
      const summary = await processRentalInvoicePush(client, companyId, rentalInvoicePush, 5)
      // Mirror the worker-emitted cadence outcome into the workflow-event
      // counter. `skipped` is the idempotent-replay / superseded case — still
      // a non-failure.
      for (let i = 0; i < summary.posted; i += 1) observeWorkflowEvent('rental', 'succeeded')
      for (let i = 0; i < summary.skipped; i += 1) observeWorkflowEvent('rental', 'succeeded')
      for (let i = 0; i < summary.failed; i += 1) observeWorkflowEvent('rental', 'failed')
      return summary
    } finally {
      client.release()
    }
  }
}

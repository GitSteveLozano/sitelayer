import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processRentalBillingInvoicePush,
  withCircuitBreaker,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from '@sitelayer/queue'
import { observeWorkflowEvent } from '../metrics.js'
import { createQboRentalInvoicePush } from '../qbo-invoice-push.js'
import { withRowTrace } from '../trace.js'

const stubRentalBillingInvoicePush: RentalBillingInvoicePushFn = async ({ runId }) => {
  // Deterministic synthetic id: same runId → same stub invoice id, so replay
  // of the same outbox row never invents a new external id.
  return { qbo_invoice_id: `STUB-INV-${runId.slice(0, 8)}` }
}

export function createRentalBillingPushRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  // Rental billing invoice push fn selection.
  //
  // Stub mode (default): returns a synthetic invoice id so the deterministic
  // plumbing (route → outbox → worker → POST_SUCCEEDED → state=posted) can
  // be exercised end-to-end without QBO. Useful for dev/preview tiers and
  // for fixtures.
  //
  // Live mode (QBO_LIVE_RENTAL_INVOICE=1): builds the real push fn that
  // queries integration_connections + integration_mappings via the same tx
  // client, POSTs /invoice to QBO, and returns the new Invoice.Id. See
  // apps/worker/src/qbo-invoice-push.ts.
  const liveRentalBillingInvoicePushEnabled = process.env.QBO_LIVE_RENTAL_INVOICE === '1'
  const rentalBillingInvoiceBasePush: RentalBillingInvoicePushFn = liveRentalBillingInvoicePushEnabled
    ? createQboRentalInvoicePush()
    : stubRentalBillingInvoicePush
  // Continue the originating API trace into the QBO call. See
  // estimate-push.ts for the matching pattern and rationale.
  const rentalBillingInvoicePush: RentalBillingInvoicePushFn = (input) =>
    withRowTrace(input, () => withCircuitBreaker(qboCircuit, 'qbo', () => rentalBillingInvoiceBasePush(input)))

  if (liveRentalBillingInvoicePushEnabled) {
    logger.info('[rental-billing] live QBO invoice push enabled')
  } else {
    logger.info('[rental-billing] stub QBO invoice push (set QBO_LIVE_RENTAL_INVOICE=1 to go live)')
  }

  return async function drainRentalBillingInvoicePushes(companyId: string): Promise<RentalBillingInvoicePushSummary> {
    // processRentalBillingInvoicePush manages its own per-phase
    // transactions internally so a failure on one row can't strand
    // earlier rows' work or leave the outbox in 'processing' beyond
    // the 5-minute lease. We just hand it a connection.
    const client = await pool.connect()
    try {
      const summary = await processRentalBillingInvoicePush(client, companyId, rentalBillingInvoicePush, 5)
      // Mirror POST_SUCCEEDED / POST_FAILED rows into the worker-side
      // counter. `skipped` is the idempotent-replay case (run already
      // had qbo_invoice_id) — still a success.
      for (let i = 0; i < summary.posted; i += 1) observeWorkflowEvent('rental_billing_run', 'succeeded')
      for (let i = 0; i < summary.skipped; i += 1) observeWorkflowEvent('rental_billing_run', 'succeeded')
      for (let i = 0; i < summary.failed; i += 1) observeWorkflowEvent('rental_billing_run', 'failed')
      return summary
    } finally {
      client.release()
    }
  }
}

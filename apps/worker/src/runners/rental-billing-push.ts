import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processRentalBillingInvoicePush,
  withCircuitBreaker,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from '@sitelayer/queue'
import { createQboRentalInvoicePush } from '../qbo-invoice-push.js'

const stubRentalBillingInvoicePush: RentalBillingInvoicePushFn = async ({ runId }) => {
  return { qbo_invoice_id: `STUB-INV-${runId.slice(0, 8)}-${Date.now()}` }
}

export function createRentalBillingPushRunner(deps: {
  pool: Pool
  logger: Logger
  qboCircuit: CircuitBreaker
}) {
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
  const rentalBillingInvoicePush: RentalBillingInvoicePushFn = (input) =>
    withCircuitBreaker(qboCircuit, 'qbo', () => rentalBillingInvoiceBasePush(input))

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
      return await processRentalBillingInvoicePush(client, companyId, rentalBillingInvoicePush, 5)
    } finally {
      client.release()
    }
  }
}

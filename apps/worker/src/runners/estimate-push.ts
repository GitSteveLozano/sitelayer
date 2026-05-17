import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  processEstimatePush,
  withCircuitBreaker,
  type EstimatePushFn,
  type EstimatePushSummary,
} from '@sitelayer/queue'
import { createQboEstimatePush } from '../qbo-estimate-push.js'

const stubEstimatePush: EstimatePushFn = async ({ pushId }) => {
  return { qbo_estimate_id: `STUB-EST-${pushId.slice(0, 8)}-${Date.now()}` }
}

export function createEstimatePushRunner(deps: { pool: Pool; logger: Logger; qboCircuit: CircuitBreaker }) {
  const { pool, logger, qboCircuit } = deps

  const liveEstimatePushEnabled = process.env.QBO_LIVE_ESTIMATE_PUSH === '1'
  const estimatePushBase: EstimatePushFn = liveEstimatePushEnabled ? createQboEstimatePush() : stubEstimatePush
  const estimatePush: EstimatePushFn = (input) => withCircuitBreaker(qboCircuit, 'qbo', () => estimatePushBase(input))

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
      return await processEstimatePush(client, companyId, estimatePush, 5)
    } finally {
      client.release()
    }
  }
}

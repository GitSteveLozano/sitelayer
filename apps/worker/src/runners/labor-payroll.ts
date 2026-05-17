import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { CircuitBreaker, withCircuitBreaker } from '@sitelayer/queue'
import {
  processLaborPayrollPush,
  processGenerateLaborPayrollRun,
  selectLaborPayrollPush,
} from '../labor-payroll-push.js'

export interface LaborPayrollRunner {
  drainPushes(companyId: string): Promise<Awaited<ReturnType<typeof processLaborPayrollPush>>>
  drainGenerateBridge(companyId: string): Promise<Awaited<ReturnType<typeof processGenerateLaborPayrollRun>>>
}

export function createLaborPayrollRunner(deps: {
  pool: Pool
  logger: Logger
  qboCircuit: CircuitBreaker
}): LaborPayrollRunner {
  const { pool, logger, qboCircuit } = deps

  const liveLaborPayrollPushEnabled = process.env.QBO_LIVE_LABOR_PAYROLL === '1'
  const laborPayrollPushBase = selectLaborPayrollPush()
  const laborPayrollPush: typeof laborPayrollPushBase = (input) =>
    withCircuitBreaker(qboCircuit, 'qbo', () => laborPayrollPushBase(input))
  if (liveLaborPayrollPushEnabled) {
    logger.info('[labor-payroll] live QBO TimeActivity push enabled')
  } else {
    logger.info('[labor-payroll] stub QBO TimeActivity push (set QBO_LIVE_LABOR_PAYROLL=1 to go live)')
  }

  async function drainLaborPayrollPushes(companyId: string) {
    const client = await pool.connect()
    try {
      return await processLaborPayrollPush(client, companyId, laborPayrollPush, 5)
    } finally {
      client.release()
    }
  }

  async function drainGenerateLaborPayrollRunBridge(companyId: string) {
    // Bridges time-review APPROVE → labor-payroll without modifying the
    // time-review reducer. Polls approved time_review_runs whose period has
    // no payroll run yet and creates one in 'generated' state.
    const client = await pool.connect()
    try {
      return await processGenerateLaborPayrollRun(client, companyId, 10)
    } finally {
      client.release()
    }
  }

  return {
    drainPushes: drainLaborPayrollPushes,
    drainGenerateBridge: drainGenerateLaborPayrollRunBridge,
  }
}

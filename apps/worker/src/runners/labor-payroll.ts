import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { CircuitBreaker, withCircuitBreaker } from '@sitelayer/queue'
import { observeWorkflowEvent } from '../metrics.js'
import {
  processLaborPayrollPush,
  processGenerateLaborPayrollRun,
  selectLaborPayrollPush,
} from '../labor-payroll-push.js'
import { processLaborPayrollAutoPost } from '../labor-payroll-auto-post.js'
import { setCompanyGuc } from '../runner-utils.js'

export interface LaborPayrollRunner {
  drainPushes(companyId: string): Promise<Awaited<ReturnType<typeof processLaborPayrollPush>>>
  drainGenerateBridge(companyId: string): Promise<Awaited<ReturnType<typeof processGenerateLaborPayrollRun>>>
  drainAutoPost(companyId: string): Promise<Awaited<ReturnType<typeof processLaborPayrollAutoPost>>>
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
      const summary = await processLaborPayrollPush(client, companyId, laborPayrollPush, 5)
      // POST_SUCCEEDED / POST_FAILED counters. `skipped` rows are
      // idempotent replays (run already had qbo_payroll_batch_ref) —
      // still successful.
      for (let i = 0; i < summary.posted; i += 1) observeWorkflowEvent('labor_payroll_run', 'succeeded')
      for (let i = 0; i < summary.skipped; i += 1) observeWorkflowEvent('labor_payroll_run', 'succeeded')
      for (let i = 0; i < summary.failed; i += 1) observeWorkflowEvent('labor_payroll_run', 'failed')
      return summary
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

  async function drainLaborPayrollAutoPost(companyId: string) {
    // Weekly AUTO post cadence ("THIS WEEK PAYROLL · AUTO"). Gated OFF per
    // company by default (migration 116) and short-circuits to a no-op
    // unless the company opted in AND the clock window is open. Dispatches
    // the worker-only AUTO_APPROVE / AUTO_POST_REQUESTED events through the
    // same pure reducer + enqueues the same post_qbo_time_activities outbox
    // row the human path uses — so drainPushes handles the QBO call. The
    // RLS GUC is bound per-row inside processLaborPayrollAutoPost's
    // transactions (via setCompanyGuc) since SET LOCAL is tx-scoped.
    const client = await pool.connect()
    try {
      return await processLaborPayrollAutoPost(client, companyId, { setCompanyGuc })
    } finally {
      client.release()
    }
  }

  return {
    drainPushes: drainLaborPayrollPushes,
    drainGenerateBridge: drainGenerateLaborPayrollRunBridge,
    drainAutoPost: drainLaborPayrollAutoPost,
  }
}

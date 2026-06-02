import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { CircuitBreaker, withCircuitBreaker } from '@sitelayer/queue'
import { observeWorkflowEvent } from '../metrics.js'
import {
  processLaborPayrollPush,
  processGenerateLaborPayrollRun,
  createQboLaborPayrollPush,
  stubLaborPayrollPush,
} from '../labor-payroll-push.js'
import { processLaborPayrollAutoPost } from '../labor-payroll-auto-post.js'
import { setCompanyGuc } from '../runner-utils.js'
import { resolveCompanyQboLive } from '../qbo-live.js'

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

  // PER-COMPANY live gating (multi-tenant). QBO_LIVE_LABOR_PAYROLL is now a
  // cluster-wide kill switch; the live decision is resolved per company at
  // drain time (global-env-on AND integration_connections.qbo_live_enabled).
  // Both push fns are built once at boot; the per-drain resolver selects
  // between them so company #2 stays dry-run while company #1 is live.
  const liveBase = createQboLaborPayrollPush()
  const buildLaborPayrollPush = (live: boolean): typeof liveBase => {
    const base = live ? liveBase : stubLaborPayrollPush
    return (input) => withCircuitBreaker(qboCircuit, 'qbo', () => base(input))
  }
  if (process.env.QBO_LIVE_LABOR_PAYROLL === '1') {
    logger.info('[labor-payroll] QBO_LIVE_LABOR_PAYROLL kill switch ON — live per company where qbo_live_enabled=true')
  } else {
    logger.info('[labor-payroll] QBO_LIVE_LABOR_PAYROLL kill switch OFF — every company stub/dry-run')
  }

  async function drainLaborPayrollPushes(companyId: string) {
    const client = await pool.connect()
    try {
      const live = await resolveCompanyQboLive(client, companyId, 'QBO_LIVE_LABOR_PAYROLL')
      const laborPayrollPush = buildLaborPayrollPush(live)
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

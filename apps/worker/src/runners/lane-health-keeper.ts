// Lane health keeper — evaluates known kill-switch signals every tick and
// flips lane state accordingly. Three signal families today:
//
//   1. QBO circuit breaker. The breaker already pauses individual
//      qbo-touching outbox rows via withCircuitBreaker; mirroring its
//      state onto the QBO_LANES set keeps operator dashboards honest
//      (the lane row is the single source of truth for the admin UI).
//
//   2. Outbox backlog. mutation_outbox + sync_events pending counts >
//      threshold flips ALL lanes to `degraded` so a downstream consumer
//      can throttle if it wants. Below the low-water clears the
//      degradation; we don't want flapping at the threshold so the
//      hysteresis band is explicit (default 1000 trigger, 500 clear).
//
//   3. Sentry-driven error spikes. We don't have a local Sentry table to
//      query (errors go straight to Sentry SaaS); the audit_events table
//      is the closest local proxy but doesn't carry severity in a way
//      that's lane-specific. Left as a TODO marker for the next pass —
//      see TODO_SENTRY_ERROR_RATE below.

import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { setLaneState, type LaneState } from '../dispatch-lanes.js'

const QBO_LANES = ['estimate_push', 'rental_billing_push', 'labor_payroll_push', 'damage_charges'] as const

const ALL_LANES = [
  'estimate_push',
  'rental_billing_push',
  'labor_payroll_push',
  'damage_charges',
  'notifications',
  'context_work_dispatch',
  'rental_invoice',
  'lock_labor_entries',
  'field_events',
  'takeoff_to_bid',
  'voice_to_log',
  'companycam_poll',
  'welcome_email',
  'blueprint_storage_gc',
  'work_request_stale',
  'queue_prune',
  'stuck_workflow_alerts',
] as const

const HIGH_WATER = (() => {
  const raw = Number(process.env.LANE_HEALTH_BACKLOG_HIGH ?? 1000)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000
})()
const LOW_WATER = (() => {
  const raw = Number(process.env.LANE_HEALTH_BACKLOG_LOW ?? 500)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500
})()
const QBO_RESUME_MS = (() => {
  const raw = Number(process.env.LANE_HEALTH_QBO_RESUME_MS ?? 5 * 60_000)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5 * 60_000
})()
const KEEPER_INTERVAL_MS = (() => {
  const raw = Number(process.env.LANE_HEALTH_KEEPER_INTERVAL_MS ?? 30_000)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000
})()

export interface LaneHealthSummary {
  ran: boolean
  qbo_state: string
  outbox_pending: number
  sync_pending: number
  changes: Array<{ lane: string; from: LaneState | null; to: LaneState; reason: string }>
}

export interface LaneHealthKeeper {
  /** Run a check pass if KEEPER_INTERVAL_MS has elapsed; gate via process-local lastRunAt. */
  maybeRun(): Promise<LaneHealthSummary>
  /** Force a check (used by tests). */
  forceRun(): Promise<LaneHealthSummary>
}

export function createLaneHealthKeeper(deps: { pool: Pool; logger: Logger }): LaneHealthKeeper {
  const { pool, logger } = deps
  let lastRunAt = 0

  async function run(): Promise<LaneHealthSummary> {
    const changes: LaneHealthSummary['changes'] = []

    // --- QBO circuit -------------------------------------------------
    let qboState = 'unknown'
    try {
      const qboResult = await pool.query<{ state: string }>(
        `select state from integration_circuit_state where integration = $1 limit 1`,
        ['qbo'],
      )
      qboState = qboResult.rows[0]?.state ?? 'closed'
    } catch (err) {
      logger.warn({ err }, '[lane-health-keeper] failed to read qbo circuit state')
    }
    if (qboState === 'open') {
      for (const lane of QBO_LANES) {
        const resumeAt = new Date(Date.now() + QBO_RESUME_MS)
        const r = await setLaneState(pool, {
          name: lane,
          to_state: 'paused',
          reason: 'qbo_circuit_open',
          decided_by: 'system:lane-health-keeper',
          resume_after: resumeAt,
        })
        if (r.changed) changes.push({ lane, from: r.from_state, to: 'paused', reason: 'qbo_circuit_open' })
      }
    } else {
      // Circuit closed — clear any qbo_circuit_open pause. We DON'T blanket
      // resume to 'active' because the lane might also be flagged for
      // backlog (degraded), or held by an operator for a live-flip
      // rollback. Only flip back rows whose pause_reason is exactly
      // 'qbo_circuit_open' AND state = 'paused'.
      try {
        const stale = await pool.query<{ name: string; state: LaneState }>(
          `select name, state from dispatch_lanes
            where name = any($1::text[])
              and state = 'paused' and pause_reason = 'qbo_circuit_open'`,
          [QBO_LANES],
        )
        for (const row of stale.rows) {
          const r = await setLaneState(pool, {
            name: row.name,
            to_state: 'active',
            reason: 'qbo_circuit_closed',
            decided_by: 'system:lane-health-keeper',
          })
          if (r.changed) changes.push({ lane: row.name, from: r.from_state, to: 'active', reason: 'qbo_circuit_closed' })
        }
      } catch (err) {
        logger.warn({ err }, '[lane-health-keeper] failed to clear stale qbo pauses')
      }
    }

    // --- Outbox backlog ---------------------------------------------
    let outboxPending = 0
    let syncPending = 0
    try {
      const out = await pool.query<{ pending: number }>(
        `select count(*)::int as pending from mutation_outbox where status in ('pending', 'processing')`,
      )
      const sync = await pool.query<{ pending: number }>(
        `select count(*)::int as pending from sync_events where status in ('pending', 'processing')`,
      )
      outboxPending = out.rows[0]?.pending ?? 0
      syncPending = sync.rows[0]?.pending ?? 0
    } catch (err) {
      logger.warn({ err }, '[lane-health-keeper] failed to read backlog counts')
    }
    const backlogHigh = outboxPending > HIGH_WATER || syncPending > HIGH_WATER
    const backlogLow = outboxPending < LOW_WATER && syncPending < LOW_WATER
    if (backlogHigh) {
      for (const lane of ALL_LANES) {
        const r = await setLaneState(pool, {
          name: lane,
          to_state: 'degraded',
          reason: 'outbox_backlog_high',
          decided_by: 'system:lane-health-keeper',
          metadata: { outbox_pending: outboxPending, sync_pending: syncPending },
        })
        if (r.changed) changes.push({ lane, from: r.from_state, to: 'degraded', reason: 'outbox_backlog_high' })
      }
    } else if (backlogLow) {
      // Only clear our own degradation (pause_reason = 'outbox_backlog_high').
      try {
        const stale = await pool.query<{ name: string; state: LaneState }>(
          `select name, state from dispatch_lanes
            where state = 'degraded' and pause_reason = 'outbox_backlog_high'`,
        )
        for (const row of stale.rows) {
          const r = await setLaneState(pool, {
            name: row.name,
            to_state: 'active',
            reason: 'outbox_backlog_cleared',
            decided_by: 'system:lane-health-keeper',
          })
          if (r.changed) changes.push({ lane: row.name, from: r.from_state, to: 'active', reason: 'outbox_backlog_cleared' })
        }
      } catch (err) {
        logger.warn({ err }, '[lane-health-keeper] failed to clear stale degraded rows')
      }
    }

    // --- TODO_SENTRY_ERROR_RATE -------------------------------------
    // When Sentry error counts land in a local table or are pushed via a
    // webhook, threshold > 50 errors/5min per lane → degraded. The
    // closest local proxy today is `audit_events` but that table records
    // successful state mutations, not errors. Skip for now and revisit
    // when the metrics pipeline gains a `worker_error_rate_5m` view.

    lastRunAt = Date.now()
    return {
      ran: true,
      qbo_state: qboState,
      outbox_pending: outboxPending,
      sync_pending: syncPending,
      changes,
    }
  }

  return {
    async maybeRun() {
      if (Date.now() - lastRunAt < KEEPER_INTERVAL_MS) {
        return { ran: false, qbo_state: 'skipped', outbox_pending: 0, sync_pending: 0, changes: [] }
      }
      return run()
    },
    forceRun: run,
  }
}

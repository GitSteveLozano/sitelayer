import { captureWithEntityContext } from './instrument.js'
import { loadAppConfig, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import { CircuitOpenError, type LockLaborEntriesSummary } from '@sitelayer/queue'
import { buildPool } from './db-pool.js'
import { createQboCircuit } from './qbo-circuit.js'
import { createLifecycle } from './lifecycle.js'
import { createHeartbeatPrelude } from './runners/heartbeat-prelude.js'
import { createQueueDrainRunner } from './runners/queue-drain.js'
import { createRentalInvoiceRunner } from './runners/rental-invoice.js'
import { createNotificationRunner } from './runners/notification.js'
import { createRentalBillingPushRunner } from './runners/rental-billing-push.js'
import { createEstimatePushRunner } from './runners/estimate-push.js'
import { createLockLaborRunner } from './runners/lock-labor.js'
import { createLaborPayrollRunner } from './runners/labor-payroll.js'
import { createFieldEventsRunner } from './runners/field-events.js'
import { createTakeoffToBidRunner } from './runners/takeoff-to-bid.js'
import { createDamageChargesRunner } from './runners/damage-charges.js'
import { createVoiceToLogRunner } from './runners/voice-to-log.js'
import { createCompanyCamPollRunner } from './runners/companycam-poll.js'
import { createWelcomeEmailRunner } from './runners/welcome-email.js'
import { createStuckWorkflowAlertsRunner } from './runners/stuck-workflow-alerts.js'
import { createBlueprintStorageGcClient, createBlueprintStorageGcRunner } from './runners/blueprint-storage-gc.js'
import { createQueuePruneRunner } from './runners/queue-prune.js'
import { createContextWorkDispatchRunner } from './runners/context-work-dispatch.js'
import { createWorkRequestStaleRunner } from './runners/work-request-stale.js'
import { createLaneHealthKeeper } from './runners/lane-health-keeper.js'
import { runIfLaneActive } from './dispatch-lanes.js'
import { createAuditEscrowTickRunner } from './runners/audit-escrow-tick.js'
import type { AgentDrainSummary } from './runner-utils.js'

const logger = createLogger('worker')

let appConfig: ReturnType<typeof loadAppConfig>
try {
  appConfig = loadAppConfig()
} catch (err) {
  if (err instanceof TierConfigError) {
    logger.fatal({ err }, '[tier] refusing to start')
    process.exit(1)
  }
  throw err
}

const databaseUrl = appConfig.databaseUrl
const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
const activeCompanySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 10_000)
const maxPollIntervalMs = Number(process.env.WORKER_POLL_MAX_INTERVAL_MS ?? 60_000)

const pool = buildPool({
  databaseUrl,
  appConfig,
  rejectUnauthorized: databaseSslRejectUnauthorized,
})

async function getCompanyId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>('select id from companies where slug = $1 limit 1', [
    activeCompanySlug,
  ])
  return result.rows[0]?.id ?? null
}

const { qboCircuit, qboCircuitCooldownMs } = createQboCircuit({ pool, logger })

// Drop outbox rows once attempt_count crosses this cap. Prevents a permanently
// broken row (bad payload, dead idempotency target) from hammering QBO forever.
const mutationMaxRetries = Number(process.env.MUTATION_MAX_RETRIES ?? 10)

// ---------------------------------------------------------------------------
// Runner registry — each runner owns its per-job-type pipeline. Built once
// at boot so init-time logging (live vs stub QBO flags, dispatcher channel
// availability, etc.) fires before the first heartbeat.
// ---------------------------------------------------------------------------
const heartbeatPrelude = createHeartbeatPrelude({
  pool,
  logger,
  qboCircuit,
  mutationMaxRetries,
  qboCircuitCooldownMs,
})
const processQueue = createQueueDrainRunner({ pool })
const notificationRunner = createNotificationRunner({ pool, logger })
const rentalInvoiceRunner = createRentalInvoiceRunner({ pool, logger })
const rentalBillingPushRunner = createRentalBillingPushRunner({ pool, logger, qboCircuit })
const estimatePushRunner = createEstimatePushRunner({ pool, logger, qboCircuit })
const lockLaborRunner = createLockLaborRunner({ pool })
const laborPayrollRunner = createLaborPayrollRunner({ pool, logger, qboCircuit })
const fieldEventsRunner = createFieldEventsRunner({ pool, logger })
const takeoffToBidRunner = createTakeoffToBidRunner({ pool })
const damageChargesRunner = createDamageChargesRunner({ pool })
const voiceToLogRunner = createVoiceToLogRunner({ pool })
const companyCamPollRunner = createCompanyCamPollRunner({ pool })
const welcomeEmailRunner = createWelcomeEmailRunner({ pool, logger })
const checkStuckPostingWorkflows = createStuckWorkflowAlertsRunner({ pool, logger })

// Blueprint storage GC + queue prune (cost-control runners shipped
// 2026-05-17 after the cost audit flagged orphaned Spaces objects and
// unbounded mutation_outbox / sync_events growth). The GC runner needs
// a storage client; we await the dynamic-import build at boot so the
// SDK lazy-load happens once, not on every heartbeat.
const blueprintStorageGc = createBlueprintStorageGcRunner({
  pool,
  storage: await createBlueprintStorageGcClient(),
})
const queuePruneRunner = createQueuePruneRunner({ pool, logger })
const contextWorkDispatchRunner = createContextWorkDispatchRunner({ pool })
const workRequestStaleRunner = createWorkRequestStaleRunner({ pool })
const laneHealthKeeper = createLaneHealthKeeper({ pool, logger })
// Wedge 2 audit-escrow tick — hourly forward-anchor of audit_events +
// context_handoff_events into the signed chain (migration 095). Has
// its own internal cadence gate; safe to invoke each heartbeat.
const auditEscrowTickRunner = createAuditEscrowTickRunner({ pool, logger })

// Startup-time check: env-state and lane-state should agree. A
// QBO_LIVE_ESTIMATE_PUSH=0 worker with an `active` estimate_push lane is
// a configuration drift — the env still forces stub-mode, but operators
// looking at the lane row would conclude live pushes are flowing. Log
// loudly so the next operator notices.
void (async () => {
  const liveEnv = process.env.QBO_LIVE_ESTIMATE_PUSH === '1'
  try {
    const result = await pool.query<{ state: string; pause_reason: string }>(
      `select state, pause_reason from dispatch_lanes where name = $1`,
      ['estimate_push'],
    )
    const lane = result.rows[0]
    if (!lane) return
    if (!liveEnv && lane.state === 'active') {
      logger.warn(
        { lane: 'estimate_push', lane_state: lane.state, qbo_live_estimate_push: '0' },
        '[lane-startup] estimate_push lane is active but QBO_LIVE_ESTIMATE_PUSH=0 — env forces stub-mode; lane row is misleading',
      )
    }
    if (liveEnv && lane.state === 'paused') {
      logger.warn(
        { lane: 'estimate_push', lane_state: lane.state, pause_reason: lane.pause_reason, qbo_live_estimate_push: '1' },
        '[lane-startup] estimate_push lane is paused but QBO_LIVE_ESTIMATE_PUSH=1 — lane-gate will short-circuit the drain',
      )
    }
  } catch (err) {
    logger.warn({ err }, '[lane-startup] failed to read estimate_push lane state')
  }
})()

async function heartbeat(): Promise<{ idle: boolean }> {
  const companyId = await getCompanyId()
  if (!companyId) {
    logger.info({ company_slug: activeCompanySlug }, '[worker] waiting for company slug')
    return { idle: true }
  }

  await heartbeatPrelude.sweepDeadLetters(companyId)
  await heartbeatPrelude.deferQboOutboxIfCircuitOpen(companyId)

  // Run queue polling and notification draining in parallel. Notifications are
  // company-agnostic (worker pulls across all tenants) so they don't depend on
  // the active company slug.
  const [outboxResult, syncResult, notifications] = await Promise.all([
    pool.query<{ pending_count: number }>(
      `select count(*)::int as pending_count from mutation_outbox where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
    ),
    pool.query<{ pending_count: number }>(
      `select count(*)::int as pending_count from sync_events where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
    ),
    runIfLaneActive(
      pool,
      logger,
      'notifications',
      () =>
        notificationRunner.drain().catch((error) => {
          logger.error({ err: error }, '[worker] notification drain failed')
          captureWithEntityContext(error, {
            scope: 'notification_drain',
            entity_type: 'notification',
            company_id: companyId,
          })
          return { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 }
        }),
      { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 },
    ),
  ])

  const pendingOutbox = outboxResult.rows[0]?.pending_count ?? 0
  const pendingSyncEvents = syncResult.rows[0]?.pending_count ?? 0

  const rentalSummary = await runIfLaneActive(
    pool,
    logger,
    'rental_invoice',
    () =>
      rentalInvoiceRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] rental drain failed')
        captureWithEntityContext(error, {
          scope: 'rental_drain',
          entity_type: 'rental',
          company_id: companyId,
        })
        return { processed: 0, billed: 0, skipped: 0, amount: 0 }
      }),
    { processed: 0, billed: 0, skipped: 0, amount: 0 },
  )

  const rentalBillingPushSummary = await runIfLaneActive(
    pool,
    logger,
    'rental_billing_push',
    () =>
      rentalBillingPushRunner(companyId).catch((error) => {
        if (error instanceof CircuitOpenError) {
          logger.info({ key: error.key }, '[worker] rental billing push skipped — circuit open')
          return { processed: 0, posted: 0, failed: 0, skipped: 0 }
        }
        logger.error({ err: error }, '[worker] rental billing invoice push drain failed')
        captureWithEntityContext(error, {
          scope: 'rental_billing_invoice_push',
          entity_type: 'rental_billing_run',
          company_id: companyId,
          workflow_name: 'rental_billing_run',
        })
        return { processed: 0, posted: 0, failed: 0, skipped: 0 }
      }),
    { processed: 0, posted: 0, failed: 0, skipped: 0 },
  )

  const estimatePushSummary = await runIfLaneActive(
    pool,
    logger,
    'estimate_push',
    () =>
      estimatePushRunner(companyId).catch((error) => {
        if (error instanceof CircuitOpenError) {
          logger.info({ key: error.key }, '[worker] estimate push skipped — circuit open')
          return { processed: 0, posted: 0, failed: 0, skipped: 0 }
        }
        logger.error({ err: error }, '[worker] estimate push drain failed')
        captureWithEntityContext(error, {
          scope: 'estimate_push',
          entity_type: 'estimate_push',
          company_id: companyId,
          workflow_name: 'estimate_push',
        })
        return { processed: 0, posted: 0, failed: 0, skipped: 0 }
      }),
    { processed: 0, posted: 0, failed: 0, skipped: 0 },
  )

  const lockLaborSummary = await runIfLaneActive(
    pool,
    logger,
    'lock_labor_entries',
    () =>
      lockLaborRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] lock_labor_entries drain failed')
        captureWithEntityContext(error, {
          scope: 'lock_labor_entries',
          entity_type: 'labor_entry',
          company_id: companyId,
          workflow_name: 'time_review_run',
        })
        return { processed: 0, locked: 0, unlocked: 0, failed: 0 } as LockLaborEntriesSummary
      }),
    { processed: 0, locked: 0, unlocked: 0, failed: 0 } as LockLaborEntriesSummary,
  )

  // labor_payroll lane covers both the bridge generation AND the QBO push
  // halves of the payroll pipeline. They're separate drains because one
  // touches local state and one calls QBO, but operationally they share a
  // single kill-switch: pausing labor_payroll_push halts both.
  await runIfLaneActive(
    pool,
    logger,
    'labor_payroll_push',
    () =>
      laborPayrollRunner.drainGenerateBridge(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] generate_labor_payroll_run drain failed')
        captureWithEntityContext(error, {
          scope: 'generate_labor_payroll_run',
          entity_type: 'labor_payroll_run',
          company_id: companyId,
          workflow_name: 'labor_payroll_run',
        })
      }),
    undefined,
  )

  await runIfLaneActive(
    pool,
    logger,
    'labor_payroll_push',
    () =>
      laborPayrollRunner.drainPushes(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] labor payroll push drain failed')
        captureWithEntityContext(error, {
          scope: 'labor_payroll_push',
          entity_type: 'labor_payroll_run',
          company_id: companyId,
          workflow_name: 'labor_payroll_run',
        })
      }),
    undefined,
  )

  await runIfLaneActive(
    pool,
    logger,
    'field_events',
    async () => {
      await fieldEventsRunner.drainNotifications(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] field event notification drain failed')
        captureWithEntityContext(error, {
          scope: 'field_event_notifications',
          entity_type: 'field_event',
          company_id: companyId,
          workflow_name: 'field_event',
        })
      })
      await fieldEventsRunner.runAutoEscalation(companyId)
    },
    undefined,
  )

  const takeoffToBidSummary = await runIfLaneActive(
    pool,
    logger,
    'takeoff_to_bid',
    () =>
      takeoffToBidRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] takeoff_to_bid drain failed')
        captureWithEntityContext(error, {
          scope: 'takeoff_to_bid',
          entity_type: 'ai_insight',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  const damageChargePushSummary = await runIfLaneActive(
    pool,
    logger,
    'damage_charges',
    () =>
      damageChargesRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] damage_charge_invoice_push drain failed')
        captureWithEntityContext(error, {
          scope: 'damage_charge_invoice_push',
          entity_type: 'damage_charge',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  const companyCamSummary = await runIfLaneActive(
    pool,
    logger,
    'companycam_poll',
    () =>
      companyCamPollRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] companycam poll failed')
        captureWithEntityContext(error, {
          scope: 'companycam_poll',
          entity_type: 'companycam_import',
          company_id: companyId,
        })
        return { processed: 0, imported: 0, skipped: 0, failed: 0 }
      }),
    { processed: 0, imported: 0, skipped: 0, failed: 0 },
  )

  const welcomeEmailSummary = await runIfLaneActive(
    pool,
    logger,
    'welcome_email',
    () =>
      welcomeEmailRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] welcome_email drain failed')
        captureWithEntityContext(error, {
          scope: 'welcome_email',
          entity_type: 'company',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  const voiceToLogSummary = await runIfLaneActive(
    pool,
    logger,
    'voice_to_log',
    () =>
      voiceToLogRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] voice_to_log drain failed')
        captureWithEntityContext(error, {
          scope: 'voice_to_log',
          entity_type: 'ai_insight',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  // Blueprint storage GC: drains DELETE-blueprint outbox rows and
  // unlinks the underlying Spaces / local-FS object.
  const blueprintStorageGcSummary = await runIfLaneActive(
    pool,
    logger,
    'blueprint_storage_gc',
    () =>
      blueprintStorageGc(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] blueprint_storage_gc drain failed')
        captureWithEntityContext(error, {
          scope: 'blueprint_storage_gc',
          entity_type: 'blueprint_document',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  const contextWorkDispatchSummary = await runIfLaneActive(
    pool,
    logger,
    'context_work_dispatch',
    () =>
      contextWorkDispatchRunner(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] context_work_dispatch drain failed')
        captureWithEntityContext(error, {
          scope: 'context_work_dispatch',
          entity_type: 'context_work_item',
          company_id: companyId,
        })
        return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
      }),
    { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary,
  )

  const workRequestStaleSummary = await runIfLaneActive(
    pool,
    logger,
    'work_request_stale',
    () =>
      workRequestStaleRunner.maybeSweep(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] work_request_stale_sweep failed')
        captureWithEntityContext(error, {
          scope: 'work_request_stale_sweep',
          entity_type: 'context_work_item',
          company_id: companyId,
        })
        return { ran: false, updated: 0, failed: 1 }
      }),
    { ran: false, updated: 0, failed: 0 },
  )

  // Audit-escrow tick — hourly forward-anchor of audit_events +
  // context_handoff_events into the signed chain. Cadence is gated
  // inside the runner; safe to invoke each heartbeat.
  const auditEscrowFallback = {
    ran: false,
    audit_event_entries_created: 0,
    audit_events_anchored: 0,
    context_handoff_entries_created: 0,
    context_handoff_events_anchored: 0,
    failed: 0,
  }
  const auditEscrowSummary = await runIfLaneActive(
    pool,
    logger,
    'audit_escrow_tick',
    () =>
      auditEscrowTickRunner.maybeTick(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] audit_escrow_tick failed')
        captureWithEntityContext(error, {
          scope: 'audit_escrow_tick',
          entity_type: 'audit_event',
          company_id: companyId,
        })
        return {
          ...auditEscrowFallback,
          failed: 1,
        }
      }),
    auditEscrowFallback,
  )

  // Daily prune of long-applied mutation_outbox / sync_events rows.
  // Gated by a process-local lastRunAt; safe to invoke every heartbeat.
  const queuePruneSummary = await queuePruneRunner.maybePrune().catch((error) => {
    logger.error({ err: error }, '[worker] queue_prune failed')
    captureWithEntityContext(error, {
      scope: 'queue_prune',
      company_id: companyId,
    })
    return { ran: false, mutation_outbox: 0, sync_events: 0 }
  })

  // Defense-in-depth alert: any workflow row stuck in 'posting' beyond
  // the threshold means the worker crashed mid-push or QBO succeeded
  // silently and the worker missed the response. Surface to Sentry so
  // a human can investigate.
  const stuckSummary = await runIfLaneActive(
    pool,
    logger,
    'stuck_workflow_alerts',
    () =>
      checkStuckPostingWorkflows(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] stuck-posting check failed')
        captureWithEntityContext(error, {
          scope: 'workflow_stuck_check',
          company_id: companyId,
        })
        return { rentalBillingStuck: 0, estimatePushStuck: 0 }
      }),
    { rentalBillingStuck: 0, estimatePushStuck: 0 },
  )

  // Lane health keeper: every heartbeat (gated by its own 30s interval
  // internally) evaluates QBO circuit + outbox backlog and flips lane
  // states accordingly. Doesn't drain any queue; just maintains the
  // dispatch_lanes table.
  const laneHealthSummary = await laneHealthKeeper.maybeRun().catch((error) => {
    logger.error({ err: error }, '[worker] lane-health-keeper failed')
    captureWithEntityContext(error, { scope: 'lane_health_keeper', company_id: companyId })
    return { ran: false, qbo_state: 'error', outbox_pending: 0, sync_pending: 0, changes: [] }
  })
  if (laneHealthSummary.ran && laneHealthSummary.changes.length > 0) {
    logger.info(
      { changes: laneHealthSummary.changes, qbo_state: laneHealthSummary.qbo_state },
      '[lane-health-keeper] flipped lane states',
    )
  }

  // Shared payload for both the active `[worker] tick` and the
  // `[worker] background tick` log messages. Key insertion order is
  // preserved via this object literal so the JSON output is byte-
  // identical to the prior inline payloads.
  const tickSummaryFields = {
    notifications_processed: notifications.processed,
    notifications_sent: notifications.sent,
    notifications_failed: notifications.failed,
    rentals_processed: rentalSummary.processed,
    rentals_billed: rentalSummary.billed,
    rentals_skipped: rentalSummary.skipped,
    rentals_billed_amount: rentalSummary.amount,
    rental_billing_push_processed: rentalBillingPushSummary.processed,
    rental_billing_push_posted: rentalBillingPushSummary.posted,
    rental_billing_push_failed: rentalBillingPushSummary.failed,
    rental_billing_push_skipped: rentalBillingPushSummary.skipped,
    estimate_push_processed: estimatePushSummary.processed,
    estimate_push_posted: estimatePushSummary.posted,
    estimate_push_failed: estimatePushSummary.failed,
    estimate_push_skipped: estimatePushSummary.skipped,
    lock_labor_entries_processed: lockLaborSummary.processed,
    lock_labor_entries_locked: lockLaborSummary.locked,
    lock_labor_entries_unlocked: lockLaborSummary.unlocked,
    lock_labor_entries_failed: lockLaborSummary.failed,
    takeoff_to_bid_processed: takeoffToBidSummary.processed,
    takeoff_to_bid_insights_created: takeoffToBidSummary.insightsCreated,
    takeoff_to_bid_failed: takeoffToBidSummary.failed,
    voice_to_log_processed: voiceToLogSummary.processed,
    voice_to_log_insights_created: voiceToLogSummary.insightsCreated,
    voice_to_log_failed: voiceToLogSummary.failed,
    damage_charge_push_processed: damageChargePushSummary.processed,
    damage_charge_push_failed: damageChargePushSummary.failed,
    companycam_processed: companyCamSummary.processed,
    companycam_imported: companyCamSummary.imported,
    companycam_failed: companyCamSummary.failed,
    welcome_email_processed: welcomeEmailSummary.processed,
    welcome_email_failed: welcomeEmailSummary.failed,
    blueprint_storage_gc_processed: blueprintStorageGcSummary.processed,
    blueprint_storage_gc_failed: blueprintStorageGcSummary.failed,
    context_work_dispatch_processed: contextWorkDispatchSummary.processed,
    context_work_dispatch_failed: contextWorkDispatchSummary.failed,
    work_request_stale_sweep_ran: workRequestStaleSummary.ran,
    work_request_stale_sweep_updated: workRequestStaleSummary.updated,
    work_request_stale_sweep_failed: workRequestStaleSummary.failed,
    queue_prune_ran: queuePruneSummary.ran,
    queue_prune_mutation_outbox: queuePruneSummary.mutation_outbox,
    queue_prune_sync_events: queuePruneSummary.sync_events,
    rental_billing_stuck_posting: stuckSummary.rentalBillingStuck,
    estimate_push_stuck_posting: stuckSummary.estimatePushStuck,
    audit_escrow_ran: auditEscrowSummary.ran,
    audit_escrow_audit_event_entries: auditEscrowSummary.audit_event_entries_created,
    audit_escrow_audit_events_anchored: auditEscrowSummary.audit_events_anchored,
    audit_escrow_context_handoff_entries: auditEscrowSummary.context_handoff_entries_created,
    audit_escrow_context_handoff_events_anchored: auditEscrowSummary.context_handoff_events_anchored,
    audit_escrow_failed: auditEscrowSummary.failed,
  }

  if (pendingOutbox || pendingSyncEvents) {
    const processed = await processQueue(companyId)
    logger.info(
      {
        company_slug: activeCompanySlug,
        pending_outbox: pendingOutbox,
        pending_sync_events: pendingSyncEvents,
        processed_outbox: processed.processedOutbox,
        processed_sync_events: processed.processedSyncEvents,
        ...tickSummaryFields,
      },
      '[worker] tick',
    )
    return { idle: false }
  }

  if (
    notifications.processed > 0 ||
    rentalSummary.processed > 0 ||
    rentalBillingPushSummary.processed > 0 ||
    estimatePushSummary.processed > 0 ||
    lockLaborSummary.processed > 0 ||
    takeoffToBidSummary.processed > 0 ||
    voiceToLogSummary.processed > 0 ||
    damageChargePushSummary.processed > 0 ||
    companyCamSummary.processed > 0 ||
    welcomeEmailSummary.processed > 0 ||
    blueprintStorageGcSummary.processed > 0 ||
    contextWorkDispatchSummary.processed > 0 ||
    workRequestStaleSummary.ran ||
    queuePruneSummary.ran ||
    auditEscrowSummary.ran
  ) {
    logger.info(
      {
        company_slug: activeCompanySlug,
        ...tickSummaryFields,
      },
      '[worker] background tick',
    )
    return { idle: false }
  }

  logger.debug(
    {
      company_slug: activeCompanySlug,
      pending_outbox: pendingOutbox,
      pending_sync_events: pendingSyncEvents,
    },
    '[worker] idle',
  )
  return { idle: true }
}

const lifecycle = createLifecycle({ pool, logger, pollIntervalMs, maxPollIntervalMs, heartbeat })
lifecycle.installSignalHandlers()

const initial = await lifecycle.runHeartbeat()
lifecycle.scheduleNextHeartbeat(initial?.idle ?? true)

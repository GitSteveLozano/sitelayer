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
import { createStuckWorkflowAlertsRunner } from './runners/stuck-workflow-alerts.js'
import { createBlueprintStorageGcClient, createBlueprintStorageGcRunner } from './runners/blueprint-storage-gc.js'
import { createQueuePruneRunner } from './runners/queue-prune.js'
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
    notificationRunner.drain().catch((error) => {
      logger.error({ err: error }, '[worker] notification drain failed')
      captureWithEntityContext(error, {
        scope: 'notification_drain',
        entity_type: 'notification',
        company_id: companyId,
      })
      return { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 }
    }),
  ])

  const pendingOutbox = outboxResult.rows[0]?.pending_count ?? 0
  const pendingSyncEvents = syncResult.rows[0]?.pending_count ?? 0

  const rentalSummary = await rentalInvoiceRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] rental drain failed')
    captureWithEntityContext(error, {
      scope: 'rental_drain',
      entity_type: 'rental',
      company_id: companyId,
    })
    return { processed: 0, billed: 0, skipped: 0, amount: 0 }
  })

  const rentalBillingPushSummary = await rentalBillingPushRunner(companyId).catch((error) => {
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
  })

  const estimatePushSummary = await estimatePushRunner(companyId).catch((error) => {
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
  })

  const lockLaborSummary = await lockLaborRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] lock_labor_entries drain failed')
    captureWithEntityContext(error, {
      scope: 'lock_labor_entries',
      entity_type: 'labor_entry',
      company_id: companyId,
      workflow_name: 'time_review_run',
    })
    return { processed: 0, locked: 0, unlocked: 0, failed: 0 } as LockLaborEntriesSummary
  })

  await laborPayrollRunner.drainGenerateBridge(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] generate_labor_payroll_run drain failed')
    captureWithEntityContext(error, {
      scope: 'generate_labor_payroll_run',
      entity_type: 'labor_payroll_run',
      company_id: companyId,
      workflow_name: 'labor_payroll_run',
    })
  })

  await laborPayrollRunner.drainPushes(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] labor payroll push drain failed')
    captureWithEntityContext(error, {
      scope: 'labor_payroll_push',
      entity_type: 'labor_payroll_run',
      company_id: companyId,
      workflow_name: 'labor_payroll_run',
    })
  })

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

  const takeoffToBidSummary = await takeoffToBidRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] takeoff_to_bid drain failed')
    captureWithEntityContext(error, {
      scope: 'takeoff_to_bid',
      entity_type: 'ai_insight',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

  const damageChargePushSummary = await damageChargesRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] damage_charge_invoice_push drain failed')
    captureWithEntityContext(error, {
      scope: 'damage_charge_invoice_push',
      entity_type: 'damage_charge',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

  const companyCamSummary = await companyCamPollRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] companycam poll failed')
    captureWithEntityContext(error, {
      scope: 'companycam_poll',
      entity_type: 'companycam_import',
      company_id: companyId,
    })
    return { processed: 0, imported: 0, skipped: 0, failed: 0 }
  })

  const voiceToLogSummary = await voiceToLogRunner(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] voice_to_log drain failed')
    captureWithEntityContext(error, {
      scope: 'voice_to_log',
      entity_type: 'ai_insight',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

  // Blueprint storage GC: drains DELETE-blueprint outbox rows and
  // unlinks the underlying Spaces / local-FS object.
  const blueprintStorageGcSummary = await blueprintStorageGc(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] blueprint_storage_gc drain failed')
    captureWithEntityContext(error, {
      scope: 'blueprint_storage_gc',
      entity_type: 'blueprint_document',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

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
  const stuckSummary = await checkStuckPostingWorkflows(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] stuck-posting check failed')
    captureWithEntityContext(error, {
      scope: 'workflow_stuck_check',
      company_id: companyId,
    })
    return { rentalBillingStuck: 0, estimatePushStuck: 0 }
  })

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
    blueprint_storage_gc_processed: blueprintStorageGcSummary.processed,
    blueprint_storage_gc_failed: blueprintStorageGcSummary.failed,
    queue_prune_ran: queuePruneSummary.ran,
    queue_prune_mutation_outbox: queuePruneSummary.mutation_outbox,
    queue_prune_sync_events: queuePruneSummary.sync_events,
    rental_billing_stuck_posting: stuckSummary.rentalBillingStuck,
    estimate_push_stuck_posting: stuckSummary.estimatePushStuck,
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
    blueprintStorageGcSummary.processed > 0 ||
    queuePruneSummary.ran
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

const lifecycle = createLifecycle({ pool, logger, pollIntervalMs, heartbeat })
lifecycle.installSignalHandlers()

const initial = await lifecycle.runHeartbeat()
lifecycle.scheduleNextHeartbeat(initial?.idle ?? true)

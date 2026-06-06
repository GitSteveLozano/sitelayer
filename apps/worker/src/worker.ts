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
import { createRentalInvoicePushRunner } from './runners/rental-invoice-push.js'
import { createNotificationRunner } from './runners/notification.js'
import { createRentalBillingPushRunner } from './runners/rental-billing-push.js'
import { createEstimatePushRunner } from './runners/estimate-push.js'
import { createQboPullRunner } from './runners/qbo-pull.js'
import { createLockLaborRunner } from './runners/lock-labor.js'
import { createLaborPayrollRunner } from './runners/labor-payroll.js'
import { createFieldEventsRunner } from './runners/field-events.js'
import { createCrewScheduleConfirmRunner } from './runners/crew-schedule-confirm.js'
import { createTakeoffToBidRunner } from './runners/takeoff-to-bid.js'
import { createDamageChargesRunner } from './runners/damage-charges.js'
import { createVoiceToLogRunner } from './runners/voice-to-log.js'
import { createCompanyCamPollRunner } from './runners/companycam-poll.js'
import { createWelcomeEmailRunner } from './runners/welcome-email.js'
import { createStuckWorkflowAlertsRunner } from './runners/stuck-workflow-alerts.js'
import { createBlueprintStorageGcClient, createBlueprintStorageGcRunner } from './runners/blueprint-storage-gc.js'
import { createCaptureArtifactAnalysisRunner } from './runners/capture-artifact-analysis.js'
import { createCaptureArtifactRetentionGcRunner } from './runners/capture-artifact-retention-gc.js'
import { createQueuePruneRunner } from './runners/queue-prune.js'
import { createContextWorkDispatchRunner } from './runners/context-work-dispatch.js'
import { createWorkDispatchReconcilerRunner } from './runners/work-dispatch-reconciler.js'
import { createWorkRequestStaleRunner } from './runners/work-request-stale.js'
import { createLaneHealthKeeper } from './runners/lane-health-keeper.js'
import { recordJobRun } from './runners/job-runs.js'
import { runIfLaneActive } from './dispatch-lanes.js'
import { createAuditEscrowTickRunner } from './runners/audit-escrow-tick.js'
import { startMeshTraceForwarder } from './runners/mesh-trace-forward.js'
import type { AgentDrainSummary } from './runner-utils.js'
import { listActiveCompanies, type ActiveCompany } from './companies.js'

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
// MULTI-TENANT: the worker drains ALL companies by default. ACTIVE_COMPANY_SLUG
// is now an OPTIONAL single-company override (e.g. targeted reprocessing or a
// single-tenant deployment) — when unset the worker iterates every company,
// mirroring the cross-tenant notification drain. A blank/unset value means "all".
const activeCompanySlugOverride = (process.env.ACTIVE_COMPANY_SLUG ?? '').trim() || null
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 10_000)
const maxPollIntervalMs = Number(process.env.WORKER_POLL_MAX_INTERVAL_MS ?? 60_000)
// Optional external-uptime heartbeat. When WORKER_HEARTBEAT_URL is set, the
// worker fires a fire-and-forget GET at the end of every drain loop iteration
// so an uptime monitor (healthchecks.io, Better Uptime, etc.) can detect a
// stalled/crashed worker. Errors are swallowed — a flaky monitor must never
// affect the drain.
const heartbeatUrl = (process.env.WORKER_HEARTBEAT_URL ?? '').trim() || null

function pingHeartbeat(): void {
  if (!heartbeatUrl) return
  void fetch(heartbeatUrl, { method: 'GET' }).catch(() => {
    // best-effort only; never let monitor failures touch the drain
  })
}

const pool = buildPool({
  databaseUrl,
  appConfig,
  rejectUnauthorized: databaseSslRejectUnauthorized,
})

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
const rentalInvoicePushRunner = createRentalInvoicePushRunner({ pool, logger, qboCircuit })
const rentalBillingPushRunner = createRentalBillingPushRunner({ pool, logger, qboCircuit })
const estimatePushRunner = createEstimatePushRunner({ pool, logger, qboCircuit })
const qboPullRunner = createQboPullRunner({ pool, logger, qboCircuit })
const lockLaborRunner = createLockLaborRunner({ pool })
const laborPayrollRunner = createLaborPayrollRunner({ pool, logger, qboCircuit })
const fieldEventsRunner = createFieldEventsRunner({ pool, logger })
const crewScheduleConfirmRunner = createCrewScheduleConfirmRunner({ pool, logger })
const takeoffToBidRunner = createTakeoffToBidRunner({ pool })
const damageChargesRunner = createDamageChargesRunner({ pool })
const voiceToLogRunner = createVoiceToLogRunner({ pool })
const companyCamPollRunner = createCompanyCamPollRunner({ pool })
const welcomeEmailRunner = createWelcomeEmailRunner({ pool, logger })
const checkStuckPostingWorkflows = createStuckWorkflowAlertsRunner({ pool, logger })
// Observability spectrum (T3, records-nothing): isolated, env-gated forwarder of
// workflow_event_log → mesh product-trace ingest. No-op unless MESH_TRACE_* env is
// set; never wired into the critical lifecycle/queue path. See runners/mesh-trace-forward.ts.
startMeshTraceForwarder({ pool, logger: { info: (m: string) => logger.info(m) } })

// Blueprint storage GC + queue prune (cost-control runners shipped
// 2026-05-17 after the cost audit flagged orphaned Spaces objects and
// unbounded mutation_outbox / sync_events growth). The GC runner needs
// a storage client; we await the dynamic-import build at boot so the
// SDK lazy-load happens once, not on every heartbeat.
const objectGcStorage = await createBlueprintStorageGcClient()
const blueprintStorageGc = createBlueprintStorageGcRunner({
  pool,
  storage: objectGcStorage,
})
const captureArtifactRetentionGc = createCaptureArtifactRetentionGcRunner({
  pool,
  storage: objectGcStorage,
})
const captureArtifactAnalysis = createCaptureArtifactAnalysisRunner({
  pool,
  storage: objectGcStorage,
  logger,
})
const queuePruneRunner = createQueuePruneRunner({ pool, logger })
const contextWorkDispatchRunner = createContextWorkDispatchRunner({ pool })
const workDispatchReconcilerRunner = createWorkDispatchReconcilerRunner({ pool })
const workRequestStaleRunner = createWorkRequestStaleRunner({ pool })
const laneHealthKeeper = createLaneHealthKeeper({ pool, logger })
// Wedge 2 audit-escrow tick — hourly forward-anchor of audit_events +
// context_handoff_events into the signed chain (migration 095). Has
// its own internal cadence gate; safe to invoke each heartbeat.
const auditEscrowTickRunner = createAuditEscrowTickRunner({ pool, logger })

// Startup-time check: env-state and lane-state should agree. A
// QBO_LIVE_ESTIMATE_PUSH=0 worker with an `active` estimate_push lane is
// a configuration drift — the env is now the CLUSTER-WIDE kill switch, so
// with it off NO company goes live (regardless of any per-company
// qbo_live_enabled flag), yet operators looking at the lane row would
// conclude live pushes are flowing. Log loudly so the next operator notices.
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
        '[lane-startup] estimate_push lane is active but QBO_LIVE_ESTIMATE_PUSH=0 — kill switch off forces stub-mode for EVERY company; lane row is misleading',
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

// ---------------------------------------------------------------------------
// Per-company drain. MULTI-TENANT: this runs once for EACH active company in a
// heartbeat. Every drain inside stays scoped to `companyId` exactly as before
// (the runners bind the RLS GUC per claimed row / filter `where company_id =
// $1`), so there is NO cross-tenant leakage — company A's rows never process
// under company B's scope. la-operations behavior is preserved exactly: when
// it is the only company (or ACTIVE_COMPANY_SLUG=la-operations), this function
// does precisely what the old single-company heartbeat did.
//
// Company-agnostic work (notification drain, queue prune, lane-health keeper)
// is intentionally NOT here — it runs once per heartbeat in `heartbeat()`.
// ---------------------------------------------------------------------------
async function drainCompany(company: ActiveCompany): Promise<{ idle: boolean }> {
  const companyId = company.id
  const companySlug = company.slug

  await heartbeatPrelude.sweepDeadLetters(companyId)
  await heartbeatPrelude.deferQboOutboxIfCircuitOpen(companyId)

  const [outboxResult, syncResult] = await Promise.all([
    pool.query<{ pending_count: number }>(
      `select count(*)::int as pending_count from mutation_outbox where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
    ),
    pool.query<{ pending_count: number }>(
      `select count(*)::int as pending_count from sync_events where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
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

  const rentalInvoicePushSummary = await runIfLaneActive(
    pool,
    logger,
    'rental_invoice_push',
    () =>
      rentalInvoicePushRunner(companyId).catch((error) => {
        if (error instanceof CircuitOpenError) {
          logger.info({ key: error.key }, '[worker] rental invoice cadence push skipped — circuit open')
          return { processed: 0, posted: 0, failed: 0, skipped: 0 }
        }
        logger.error({ err: error }, '[worker] rental invoice cadence push drain failed')
        captureWithEntityContext(error, {
          scope: 'rental_invoice_cadence_push',
          entity_type: 'rental',
          company_id: companyId,
          workflow_name: 'rental',
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

  const qboPullSummary = await runIfLaneActive(
    pool,
    logger,
    'qbo_pull',
    () =>
      qboPullRunner(companyId).catch((error) => {
        if (error instanceof CircuitOpenError) {
          logger.info({ key: error.key }, '[worker] qbo pull skipped — circuit open')
          return { processed: 0, pulled: 0, failed: 0, skipped: 0 }
        }
        logger.error({ err: error }, '[worker] qbo pull drain failed')
        captureWithEntityContext(error, {
          scope: 'qbo_pull',
          entity_type: 'integration_connection',
          company_id: companyId,
        })
        return { processed: 0, pulled: 0, failed: 0, skipped: 0 }
      }),
    { processed: 0, pulled: 0, failed: 0, skipped: 0 },
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

  // Weekly AUTO post cadence — runs BEFORE drainPushes on the same lane so a
  // just-auto-approved run's POST_REQUESTED outbox row is claimed in the same
  // heartbeat. No-op unless a company opted in (policy gated OFF by default,
  // migration 116) AND the configured clock window is open.
  await runIfLaneActive(
    pool,
    logger,
    'labor_payroll_push',
    () =>
      laborPayrollRunner.drainAutoPost(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] labor payroll auto-post drain failed')
        captureWithEntityContext(error, {
          scope: 'labor_payroll_auto_post',
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

  await runIfLaneActive(
    pool,
    logger,
    'crew_schedule_confirm',
    () =>
      crewScheduleConfirmRunner.drain(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] crew-schedule confirm drain failed')
        captureWithEntityContext(error, {
          scope: 'crew_schedule_confirm',
          entity_type: 'crew_schedule',
          company_id: companyId,
          workflow_name: 'crew_schedule',
        })
        return { processed: 0, materialized: 0, notified: 0, skipped: 0, failed: 0 }
      }),
    { processed: 0, materialized: 0, notified: 0, skipped: 0, failed: 0 },
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
  const captureArtifactRetentionGcSummary = await runIfLaneActive(
    pool,
    logger,
    'capture_artifact_retention_gc',
    () =>
      captureArtifactRetentionGc.maybeSweep(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] capture_artifact_retention_gc sweep failed')
        captureWithEntityContext(error, {
          scope: 'capture_artifact_retention_gc',
          entity_type: 'capture_artifact',
          company_id: companyId,
        })
        return { ran: true, deleted: 0, failed: 1 }
      }),
    { ran: false, deleted: 0, failed: 0 },
  )
  const captureArtifactAnalysisSummary = await runIfLaneActive(
    pool,
    logger,
    'capture_artifact_analysis',
    () =>
      captureArtifactAnalysis.maybeAnalyze(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] capture_artifact_analysis failed')
        captureWithEntityContext(error, {
          scope: 'capture_artifact_analysis',
          entity_type: 'capture_artifact',
          company_id: companyId,
        })
        return { ran: true, analyzed: 0, skipped: 0, failed: 1 }
      }),
    { ran: false, analyzed: 0, skipped: 0, failed: 0 },
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

  const workDispatchReconcileSummary = await runIfLaneActive(
    pool,
    logger,
    'work_request_stale',
    () =>
      workDispatchReconcilerRunner.maybeReconcile(companyId).catch((error) => {
        logger.error({ err: error }, '[worker] work_dispatch_reconciler failed')
        captureWithEntityContext(error, {
          scope: 'work_dispatch_reconciler',
          entity_type: 'context_work_item',
          company_id: companyId,
        })
        return { ran: false, reconciled: 0, failed: 1 }
      }),
    { ran: false, reconciled: 0, failed: 0 },
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

  // Shared payload for both the active `[worker] tick` and the
  // `[worker] background tick` log messages. Key insertion order is
  // preserved via this object literal so the per-company JSON output is
  // stable. Notification / queue-prune / lane-health counters are NOT here —
  // they are company-agnostic and logged once per heartbeat in `heartbeat()`.
  const tickSummaryFields = {
    rentals_processed: rentalSummary.processed,
    rentals_billed: rentalSummary.billed,
    rentals_skipped: rentalSummary.skipped,
    rentals_billed_amount: rentalSummary.amount,
    rental_billing_push_processed: rentalBillingPushSummary.processed,
    rental_billing_push_posted: rentalBillingPushSummary.posted,
    rental_billing_push_failed: rentalBillingPushSummary.failed,
    rental_billing_push_skipped: rentalBillingPushSummary.skipped,
    rental_invoice_push_processed: rentalInvoicePushSummary.processed,
    rental_invoice_push_posted: rentalInvoicePushSummary.posted,
    rental_invoice_push_failed: rentalInvoicePushSummary.failed,
    rental_invoice_push_skipped: rentalInvoicePushSummary.skipped,
    estimate_push_processed: estimatePushSummary.processed,
    estimate_push_posted: estimatePushSummary.posted,
    estimate_push_failed: estimatePushSummary.failed,
    estimate_push_skipped: estimatePushSummary.skipped,
    qbo_pull_processed: qboPullSummary.processed,
    qbo_pull_pulled: qboPullSummary.pulled,
    qbo_pull_failed: qboPullSummary.failed,
    qbo_pull_skipped: qboPullSummary.skipped,
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
    capture_artifact_retention_gc_ran: captureArtifactRetentionGcSummary.ran,
    capture_artifact_retention_gc_deleted: captureArtifactRetentionGcSummary.deleted,
    capture_artifact_retention_gc_failed: captureArtifactRetentionGcSummary.failed,
    capture_artifact_analysis_ran: captureArtifactAnalysisSummary.ran,
    capture_artifact_analysis_analyzed: captureArtifactAnalysisSummary.analyzed,
    capture_artifact_analysis_skipped: captureArtifactAnalysisSummary.skipped,
    capture_artifact_analysis_failed: captureArtifactAnalysisSummary.failed,
    context_work_dispatch_processed: contextWorkDispatchSummary.processed,
    context_work_dispatch_failed: contextWorkDispatchSummary.failed,
    work_dispatch_reconcile_ran: workDispatchReconcileSummary.ran,
    work_dispatch_reconcile_reconciled: workDispatchReconcileSummary.reconciled,
    work_dispatch_reconcile_failed: workDispatchReconcileSummary.failed,
    work_request_stale_sweep_ran: workRequestStaleSummary.ran,
    work_request_stale_sweep_updated: workRequestStaleSummary.updated,
    work_request_stale_sweep_failed: workRequestStaleSummary.failed,
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
        company_slug: companySlug,
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
    rentalSummary.processed > 0 ||
    rentalBillingPushSummary.processed > 0 ||
    rentalInvoicePushSummary.processed > 0 ||
    estimatePushSummary.processed > 0 ||
    qboPullSummary.processed > 0 ||
    lockLaborSummary.processed > 0 ||
    takeoffToBidSummary.processed > 0 ||
    voiceToLogSummary.processed > 0 ||
    damageChargePushSummary.processed > 0 ||
    companyCamSummary.processed > 0 ||
    welcomeEmailSummary.processed > 0 ||
    blueprintStorageGcSummary.processed > 0 ||
    captureArtifactRetentionGcSummary.deleted > 0 ||
    captureArtifactAnalysisSummary.analyzed > 0 ||
    contextWorkDispatchSummary.processed > 0 ||
    workDispatchReconcileSummary.ran ||
    workRequestStaleSummary.ran ||
    auditEscrowSummary.ran
  ) {
    logger.info(
      {
        company_slug: companySlug,
        ...tickSummaryFields,
      },
      '[worker] background tick',
    )
    return { idle: false }
  }

  logger.debug(
    {
      company_slug: companySlug,
      pending_outbox: pendingOutbox,
      pending_sync_events: pendingSyncEvents,
    },
    '[worker] idle',
  )
  return { idle: true }
}

// ---------------------------------------------------------------------------
// Heartbeat: company-agnostic work once, then drain EVERY active company.
//
// MULTI-TENANT entry point. The notification drain, the queue prune, and the
// lane-health keeper are company-agnostic (they pull across all tenants /
// maintain global tables) so they run ONCE per heartbeat. Then we iterate the
// active-company list and drain each in turn — sequentially, so the worker's
// connection-pool pressure and ordering guarantees are unchanged from the old
// single-company heartbeat. A drain failure for one company is isolated (each
// runner already swallows its own errors) and never blocks the others.
//
// `idle` is true only when NO company did work AND the company-agnostic work
// was idle too, so the lifecycle backoff still ramps the poll interval on a
// fully-quiet cluster.
// ---------------------------------------------------------------------------
async function heartbeat(): Promise<{ idle: boolean }> {
  const heartbeatStartedAt = Date.now()
  const companies = await listActiveCompanies(pool, activeCompanySlugOverride)
  if (companies.length === 0) {
    logger.info({ company_slug: activeCompanySlugOverride ?? '(all)' }, '[worker] waiting for company slug')
    pingHeartbeat()
    return { idle: true }
  }

  // Company-agnostic notification drain — once per heartbeat. The worker pulls
  // notifications across ALL tenants in a single batch, so this must NOT run
  // per company.
  const notificationDrainStartedAt = Date.now()
  let notificationDrainErrored = false
  const notifications = await runIfLaneActive(
    pool,
    logger,
    'notifications',
    () =>
      notificationRunner.drain().catch((error) => {
        logger.error({ err: error }, '[worker] notification drain failed')
        captureWithEntityContext(error, {
          scope: 'notification_drain',
          entity_type: 'notification',
        })
        notificationDrainErrored = true
        return { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 }
      }),
    { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 },
  )
  // Best-effort run-ledger record (GLOBAL table, no RLS GUC). Never throws.
  await recordJobRun(
    pool,
    'notification_drain',
    {
      status: notificationDrainErrored ? 'error' : 'ok',
      durationMs: Date.now() - notificationDrainStartedAt,
      metadata: {
        processed: notifications.processed,
        sent: notifications.sent,
        failed: notifications.failed,
        deferred: notifications.deferred,
        hydrated: notifications.hydrated,
      },
    },
    logger,
  )

  // Drain every active company. Sequential to keep pool pressure bounded.
  let anyCompanyBusy = false
  for (const company of companies) {
    const result = await drainCompany(company)
    if (!result.idle) anyCompanyBusy = true
  }

  // Daily prune of long-applied mutation_outbox / sync_events rows (process-
  // local cadence gate, company-agnostic). Once per heartbeat.
  const queuePruneStartedAt = Date.now()
  let queuePruneErrored = false
  const queuePruneSummary = await queuePruneRunner.maybePrune().catch((error) => {
    logger.error({ err: error }, '[worker] queue_prune failed')
    captureWithEntityContext(error, { scope: 'queue_prune' })
    queuePruneErrored = true
    return { ran: false, mutation_outbox: 0, sync_events: 0 }
  })
  // Best-effort run-ledger record. The cadence gate makes a no-run the common
  // case — record it as 'skipped' (gate didn't fire), 'error' on failure,
  // else 'ok'. GLOBAL table, no RLS GUC. Never throws.
  await recordJobRun(
    pool,
    'queue_prune',
    {
      status: queuePruneErrored ? 'error' : queuePruneSummary.ran ? 'ok' : 'skipped',
      durationMs: Date.now() - queuePruneStartedAt,
      metadata: {
        ran: queuePruneSummary.ran,
        mutation_outbox: queuePruneSummary.mutation_outbox,
        sync_events: queuePruneSummary.sync_events,
      },
    },
    logger,
  )

  // Lane health keeper: every heartbeat (gated by its own 30s interval
  // internally) evaluates QBO circuit + outbox backlog and flips lane states.
  // Maintains the global dispatch_lanes table; company-agnostic, runs once.
  const laneHealthStartedAt = Date.now()
  let laneHealthErrored = false
  const laneHealthSummary = await laneHealthKeeper.maybeRun().catch((error) => {
    logger.error({ err: error }, '[worker] lane-health-keeper failed')
    captureWithEntityContext(error, { scope: 'lane_health_keeper' })
    laneHealthErrored = true
    return { ran: false, qbo_state: 'error', outbox_pending: 0, sync_pending: 0, changes: [] }
  })
  // Best-effort run-ledger record. The internal 30s gate makes a no-run common
  // — 'skipped' when the gate didn't fire, 'error' on failure, else 'ok'.
  // GLOBAL table, no RLS GUC. Never throws.
  await recordJobRun(
    pool,
    'lane_health_keeper',
    {
      status: laneHealthErrored ? 'error' : laneHealthSummary.ran ? 'ok' : 'skipped',
      durationMs: Date.now() - laneHealthStartedAt,
      metadata: {
        ran: laneHealthSummary.ran,
        qbo_state: laneHealthSummary.qbo_state,
        outbox_pending: laneHealthSummary.outbox_pending,
        sync_pending: laneHealthSummary.sync_pending,
        changes: laneHealthSummary.changes.length,
      },
    },
    logger,
  )
  if (laneHealthSummary.ran && laneHealthSummary.changes.length > 0) {
    logger.info(
      { changes: laneHealthSummary.changes, qbo_state: laneHealthSummary.qbo_state },
      '[lane-health-keeper] flipped lane states',
    )
  }

  if (notifications.processed > 0 || queuePruneSummary.ran) {
    logger.info(
      {
        companies: companies.length,
        notifications_processed: notifications.processed,
        notifications_sent: notifications.sent,
        notifications_failed: notifications.failed,
        queue_prune_ran: queuePruneSummary.ran,
        queue_prune_mutation_outbox: queuePruneSummary.mutation_outbox,
        queue_prune_sync_events: queuePruneSummary.sync_events,
      },
      '[worker] cross-tenant tick',
    )
  }

  // External-uptime heartbeat: fire once at the end of every completed drain
  // loop iteration (after all per-company + cross-tenant work). Fire-and-forget.
  pingHeartbeat()

  const idle = !anyCompanyBusy && notifications.processed === 0 && !queuePruneSummary.ran

  // Best-effort run-ledger record for the heartbeat loop itself — recorded
  // once at the end of each heartbeat. GLOBAL table, no RLS GUC. Never throws.
  await recordJobRun(
    pool,
    'worker_heartbeat',
    {
      status: 'ok',
      durationMs: Date.now() - heartbeatStartedAt,
      metadata: { idle, companies: companies.length },
    },
    logger,
  )

  return { idle }
}

const lifecycle = createLifecycle({ pool, logger, pollIntervalMs, maxPollIntervalMs, heartbeat })
lifecycle.installSignalHandlers()

const initial = await lifecycle.runHeartbeat()
lifecycle.scheduleNextHeartbeat(initial?.idle ?? true)

import { Sentry, captureMessageWithEntityContext, captureWithEntityContext } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import {
  CircuitBreaker,
  CircuitOpenError,
  deadLetterStaleOutbox,
  fetchDueRentals,
  processEstimatePush,
  processLockLaborEntries,
  processQueueWithClient,
  processRentalBillingInvoicePush,
  processRentalInvoice,
  recordLedger,
  withCircuitBreaker,
  type EstimatePushFn,
  type EstimatePushSummary,
  type LockLaborEntriesSummary,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from '@sitelayer/queue'
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { spanForAppliedRow } from './trace.js'
import { loadEmailConfig, sendEmail } from './email.js'
import { createQboRentalInvoicePush } from './qbo-invoice-push.js'
import { processDamageChargeInvoicePush } from './damage-charge-push.js'
import { drainCompanyCamPolls } from './companycam-poll.js'
import { createQboEstimatePush } from './qbo-estimate-push.js'
import { createClerkClient } from '@clerk/backend'
import { clerkUserFetcherFromClient, createClerkResolver, type ClerkResolver } from './clerk-hydrate.js'
import { drainNotifications as drainNotificationsBatch } from './notifications.js'
import { processTakeoffToBidRun, type TakeoffToBidPayload } from './takeoff-to-bid-agent.js'
import { processVoiceToLogRun, type VoiceToLogPayload } from './voice-to-log-agent.js'
import {
  processLaborPayrollPush,
  processGenerateLaborPayrollRun,
  selectLaborPayrollPush,
} from './labor-payroll-push.js'
import { processFieldEventNotifications } from './field-event-notifier.js'
import { processFieldEventAutoEscalation, DEFAULT_AUTO_ESCALATE_CONFIG } from './field-event-escalation.js'
import {
  ConsoleChannel,
  DefaultNotificationDispatcher,
  EmailChannel,
  TwilioSMSChannel,
  WebPushChannel,
  loadTwilioConfig,
  loadVapidConfig,
  type NotificationChannel,
  type NotificationDispatcher,
  type PushSubscriptionRow,
  type WebPushClient,
} from './notification-channels.js'
// `web-push` is loaded lazily so the worker boots even when the
// dependency is missing (older deploys), matching the email-provider
// fallback pattern.
import webpush from 'web-push'

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

function withTierOptions(config: PoolConfig): PoolConfig {
  return { ...config, options: postgresOptionsForTier(appConfig.tier, config.options || process.env.PGOPTIONS) }
}

function getPoolConfig(connectionString: string): PoolConfig {
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!databaseSslRejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return withTierOptions({
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
      })
    }
  } catch {
    return withTierOptions({ connectionString })
  }

  return withTierOptions({ connectionString })
}

const pool = new Pool(getPoolConfig(databaseUrl))

/**
 * Bind `app.company_id` for the lifetime of the active transaction so any
 * RLS-protected SELECT/INSERT/UPDATE the worker issues against company-scoped
 * tables passes the `company_isolation` policy (migration 066). Caller must
 * have already opened a transaction with `client.query('begin')`.
 *
 * Migration 066's policy is `app_current_company_id() IS NULL OR company_id =
 * app_current_company_id()`, so a tx that forgets to set this still works —
 * but writes to the 4 RLS-enforced tables (audit_events, workflow_event_log,
 * mutation_outbox, sync_events) under FORCE will pass WITH CHECK only when
 * the GUC matches the row's company_id. Set this near the top of every BEGIN
 * the worker opens to keep behaviour stable when the permissive `IS NULL OR`
 * clause is removed in a follow-up.
 */
async function setCompanyGuc(client: PoolClient, companyId: string): Promise<void> {
  await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
}

async function processQueue(companyId: string, limit = 25) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const result = await processQueueWithClient(client, companyId, limit)
    await client.query('commit')
    for (const row of result.outbox) {
      spanForAppliedRow({ ...row, kind: 'outbox' })
    }
    for (const row of result.syncEvents) {
      spanForAppliedRow({ ...row, kind: 'sync_event' })
    }
    return {
      processedOutbox: result.processedOutboxCount,
      processedSyncEvents: result.processedSyncEventCount,
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

// Cap per heartbeat so an accidentally-backdated rental (or an import that
// seeded 10 000 rows) can't stall the worker or flood the audit log in one
// tick.
const RENTAL_INVOICE_MAX_PER_HEARTBEAT = 50

async function drainRentalInvoices(companyId: string): Promise<{
  processed: number
  billed: number
  skipped: number
  amount: number
}> {
  const client = await pool.connect()
  try {
    const due = await fetchDueRentals(client, companyId, RENTAL_INVOICE_MAX_PER_HEARTBEAT)
    if (due.length === 0) {
      return { processed: 0, billed: 0, skipped: 0, amount: 0 }
    }
    let billed = 0
    let skipped = 0
    let amount = 0
    for (const rental of due) {
      await client.query('begin')
      try {
        await setCompanyGuc(client, rental.company_id)
        const result = await processRentalInvoice(client, rental)
        // Mirror the API's POST /api/rentals/:id/invoke ledger writes so a
        // worker-billed rental still surfaces in sync_events / mutation_outbox
        // and reaches QBO downstream. Same idempotency keys (versioned for
        // rentals so consecutive ticks don't collapse into one outbox row).
        if (result.bill) {
          await recordLedger(client, {
            companyId: rental.company_id,
            entityType: 'material_bill',
            entityId: result.bill.id,
            mutationType: 'create',
            idempotencyKey: `material_bill:create:${result.bill.id}`,
            syncPayload: {
              action: 'create',
              bill: result.bill,
              source: 'rental_invoice',
              rental_id: rental.id,
              origin: 'worker',
            },
            outboxPayload: {
              ...(result.bill as unknown as Record<string, unknown>),
              source: 'rental_invoice',
              rental_id: rental.id,
            },
          })
        }
        await recordLedger(client, {
          companyId: rental.company_id,
          entityType: 'rental',
          entityId: rental.id,
          mutationType: 'invoice',
          idempotencyKey: `rental:invoice:${rental.id}:${result.rental.version}`,
          syncPayload: {
            action: 'invoice',
            rental: result.rental,
            days: result.days,
            amount: result.amount,
            invoiced_through: result.invoiced_through,
            origin: 'worker',
          },
          outboxPayload: {
            rental: result.rental,
            bill_id: result.bill?.id ?? null,
            days: result.days,
            amount: result.amount,
          },
        })
        await client.query('commit')
        if (result.bill) {
          billed += 1
          amount += result.amount
        } else {
          skipped += 1
        }
      } catch (error) {
        await client.query('rollback')
        logger.error({ err: error, rental_id: rental.id }, '[worker] rental invoice failed')
        captureWithEntityContext(error, {
          scope: 'rental_invoice',
          entity_type: 'rental',
          entity_id: rental.id,
          company_id: rental.company_id,
        })
      }
    }
    return { processed: due.length, billed, skipped, amount }
  } finally {
    client.release()
  }
}

async function getCompanyId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>('select id from companies where slug = $1 limit 1', [
    activeCompanySlug,
  ])
  return result.rows[0]?.id ?? null
}

const notificationMaxAttemptsRaw = Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? 5)
const NOTIFICATION_MAX_ATTEMPTS = Number.isFinite(notificationMaxAttemptsRaw)
  ? Math.max(1, Math.floor(notificationMaxAttemptsRaw))
  : 5
const notificationBatchLimit = Number(process.env.NOTIFICATION_BATCH_LIMIT ?? 10)
const emailConfig = loadEmailConfig()

// If this many sends fail back-to-back in one batch, treat the email provider
// as down and stop processing the rest of the batch. The unprocessed rows
// stay locked under `FOR UPDATE SKIP LOCKED`, so on COMMIT they release with
// their original next_attempt_at and get re-claimed in the next heartbeat.
// This avoids burning every queued notification's attempt counter against a
// total provider outage.
const NOTIFICATION_PROVIDER_FAILURE_THRESHOLD = (() => {
  const n = Number(process.env.NOTIFICATION_PROVIDER_FAILURE_THRESHOLD ?? 3)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
})()

// Clerk wiring. The notifications drain hydrates `recipient_email` from the
// Clerk user id when the row was queued without an address. We fail loud at
// startup when CLERK_SECRET_KEY is missing AND the worker is supposed to
// drain notifications: silently marking those rows sent (the prior TODO
// behavior) means real users miss real emails. CLAUDE.md operating rule:
// don't fall back to silent localhost-style defaults.
const NOTIFICATIONS_ENABLED = (process.env.NOTIFICATIONS_ENABLED ?? '1') !== '0'
const clerkSecretKey = (process.env.CLERK_SECRET_KEY ?? '').trim()

let clerkResolver: ClerkResolver | null = null
if (NOTIFICATIONS_ENABLED) {
  if (!clerkSecretKey) {
    logger.fatal(
      { hint: 'set CLERK_SECRET_KEY or NOTIFICATIONS_ENABLED=0' },
      '[notifications] refusing to start: CLERK_SECRET_KEY required for clerk_user_id → email hydration',
    )
    process.exit(1)
  }
  const clerkClient = createClerkClient({ secretKey: clerkSecretKey })
  const cacheTtlRaw = Number(process.env.CLERK_EMAIL_CACHE_TTL_MS ?? 5 * 60 * 1000)
  const resolverOpts: Parameters<typeof createClerkResolver>[0] = {
    getUser: clerkUserFetcherFromClient(clerkClient),
  }
  if (Number.isFinite(cacheTtlRaw) && cacheTtlRaw > 0) {
    resolverOpts.cacheTtlMs = cacheTtlRaw
  }
  clerkResolver = createClerkResolver(resolverOpts)
  logger.info('[notifications] clerk hydration enabled')
} else {
  logger.warn('[notifications] NOTIFICATIONS_ENABLED=0; clerk hydration skipped (rows requiring it will defer)')
}

// ---------------------------------------------------------------------------
// Notification channel system (Phase 1C)
//
// Build the dispatcher once at boot from env. Channels self-disable when
// their config is missing; the dispatcher's router falls back to email,
// then defers, so the system gracefully degrades without dropping rows.
// ---------------------------------------------------------------------------
const vapidConfig = loadVapidConfig()
const twilioConfig = loadTwilioConfig()

const consoleChannel: NotificationChannel = new ConsoleChannel({ logger })
const emailChannel: NotificationChannel = new EmailChannel({ emailConfig, sendEmail })
const smsChannel: NotificationChannel | null = twilioConfig
  ? new TwilioSMSChannel({ config: twilioConfig, logger })
  : null

// The static push channel only declares availability; per-(company, user)
// instances handle actual sends so the subscription loader/pruner have
// the right context. The static instance is reused for the
// availability check inside the dispatcher.
const staticPushChannel: NotificationChannel | null = vapidConfig
  ? new WebPushChannel(
      {
        vapid: vapidConfig,
        webpush: webpush as unknown as WebPushClient,
        loadSubscriptions: async () => [],
        pruneSubscription: async () => {},
        logger,
      },
      'static',
      'static',
    )
  : null

function buildPushChannel(companyId: string, clerkUserId: string): NotificationChannel {
  return new WebPushChannel(
    {
      vapid: vapidConfig,
      webpush: vapidConfig ? (webpush as unknown as WebPushClient) : null,
      loadSubscriptions: async (cId, uId) => {
        const result = await pool.query<PushSubscriptionRow>(
          `select id, endpoint, p256dh, auth
             from push_subscriptions
            where company_id = $1 and clerk_user_id = $2
            order by last_seen_at desc`,
          [cId, uId],
        )
        return result.rows
      },
      pruneSubscription: async (subscriptionId) => {
        await pool.query(`delete from push_subscriptions where id = $1`, [subscriptionId])
      },
      logger,
    },
    companyId,
    clerkUserId,
  )
}

const dispatcher: NotificationDispatcher = new DefaultNotificationDispatcher({
  channels: {
    push: staticPushChannel,
    sms: smsChannel,
    email: emailChannel,
    console: consoleChannel,
  },
  buildPushChannel: vapidConfig ? buildPushChannel : null,
  hydrateEmail:
    NOTIFICATIONS_ENABLED && clerkResolver
      ? async (clerkUserId) => {
          const resolution = await clerkResolver!.resolveEmailForClerkUser(clerkUserId)
          return resolution.kind === 'email' ? resolution.email : null
        }
      : null,
  logger,
})

logger.info(
  {
    push: vapidConfig ? 'configured' : 'disabled',
    sms: twilioConfig ? 'configured' : 'disabled',
    email: emailConfig.provider,
  },
  '[notification-channels] dispatcher ready',
)

/**
 * Wrapper that opens a tx, calls into the extracted batch drainer, and commits.
 * The batch drainer holds the per-row logic (claim / hydrate / send / DLQ); see
 * `notifications.ts`.
 */
async function drainNotifications(limit = notificationBatchLimit): Promise<{
  processed: number
  sent: number
  failed: number
  shortCircuited: boolean
  deferred: number
  hydrated: number
}> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await drainNotificationsBatch(
      { client, sendEmail, logger },
      {
        limit,
        providerFailureThreshold: NOTIFICATION_PROVIDER_FAILURE_THRESHOLD,
        maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
        emailConfig,
        clerkResolver,
        dispatcher,
      },
    )
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

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
// QBO circuit breaker. Three consecutive 5xx (or network) failures on any
// QBO push open the circuit for QBO_CIRCUIT_COOLDOWN_MS (default 5 min);
// while open, push wrappers throw CircuitOpenError immediately and the
// worker defers the row's next_attempt_at instead of incrementing
// attempt_count. One success closes the circuit.
const qboCircuitThreshold = Number(process.env.QBO_CIRCUIT_THRESHOLD ?? 3)
const qboCircuitCooldownMs = Number(process.env.QBO_CIRCUIT_COOLDOWN_MS ?? 5 * 60_000)
/**
 * Persist circuit-breaker state to `integration_circuit_state` so the
 * API's /api/metrics endpoint can publish the
 * `sitelayer_circuit_breaker_state{integration}` gauge. Best-effort:
 * a DB hiccup mustn't block the breaker transition.
 */
async function persistCircuitState(
  integration: string,
  state: 'open' | 'closed',
  info?: { failureCount?: number; lastError?: string | null },
): Promise<void> {
  try {
    await pool.query(
      `insert into integration_circuit_state (integration, state, failure_count, last_error, opened_at, updated_at)
         values ($1, $2, coalesce($3, 0), $4, case when $2 = 'open' then now() else null end, now())
       on conflict (integration) do update set
         state = excluded.state,
         failure_count = coalesce(excluded.failure_count, integration_circuit_state.failure_count),
         last_error = coalesce(excluded.last_error, integration_circuit_state.last_error),
         opened_at = case when excluded.state = 'open' then coalesce(integration_circuit_state.opened_at, now()) else null end,
         updated_at = now()`,
      [integration, state, info?.failureCount ?? null, info?.lastError ?? null],
    )
  } catch (err) {
    logger.warn({ err, integration, state }, '[circuit-breaker] failed to persist state')
  }
}

const qboCircuit = new CircuitBreaker({
  threshold: qboCircuitThreshold,
  cooldownMs: qboCircuitCooldownMs,
  onOpen: (key, info) => {
    logger.warn({ key, ...info }, '[circuit-breaker] open — halting QBO drain')
    captureMessageWithEntityContext(`circuit breaker open: ${key}`, {
      level: 'warning',
      scope: 'circuit_breaker',
      extra_tags: { integration: key },
      extra: { failureCount: info.failureCount, lastError: info.lastError },
    })
    void persistCircuitState(key, 'open', { failureCount: info.failureCount, lastError: info.lastError })
  },
  onClose: (key) => {
    logger.info({ key }, '[circuit-breaker] closed — resuming drain')
    void persistCircuitState(key, 'closed', { failureCount: 0, lastError: null })
  },
})

// Seed the row at boot so the gauge is non-absent even before the
// breaker ever trips. Wrapped in try/catch — migration 074 may not
// yet be applied on older deployments and we shouldn't block startup.
void (async () => {
  await persistCircuitState('qbo', 'closed', { failureCount: 0, lastError: null })
})()

// Drop outbox rows once attempt_count crosses this cap. Prevents a permanently
// broken row (bad payload, dead idempotency target) from hammering QBO forever.
const mutationMaxRetries = Number(process.env.MUTATION_MAX_RETRIES ?? 10)

const stubRentalBillingInvoicePush: RentalBillingInvoicePushFn = async ({ runId }) => {
  return { qbo_invoice_id: `STUB-INV-${runId.slice(0, 8)}-${Date.now()}` }
}

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

async function drainRentalBillingInvoicePushes(companyId: string): Promise<RentalBillingInvoicePushSummary> {
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

const stubEstimatePush: EstimatePushFn = async ({ pushId }) => {
  return { qbo_estimate_id: `STUB-EST-${pushId.slice(0, 8)}-${Date.now()}` }
}

const liveEstimatePushEnabled = process.env.QBO_LIVE_ESTIMATE_PUSH === '1'
const estimatePushBase: EstimatePushFn = liveEstimatePushEnabled ? createQboEstimatePush() : stubEstimatePush
const estimatePush: EstimatePushFn = (input) => withCircuitBreaker(qboCircuit, 'qbo', () => estimatePushBase(input))

if (liveEstimatePushEnabled) {
  logger.info('[estimate-push] live QBO estimate push enabled')
} else {
  logger.info('[estimate-push] stub QBO estimate push (set QBO_LIVE_ESTIMATE_PUSH=1 to go live)')
}

async function drainEstimatePushes(companyId: string): Promise<EstimatePushSummary> {
  // See drainRentalBillingInvoicePushes — same transaction-scope
  // contract.
  const client = await pool.connect()
  try {
    return await processEstimatePush(client, companyId, estimatePush, 5)
  } finally {
    client.release()
  }
}

async function drainLockLaborEntries(companyId: string): Promise<LockLaborEntriesSummary> {
  // The lock_labor_entries handler manages its own per-row transactions
  // internally so a stuck row can't strand earlier work. We just hand it
  // a connection. See packages/queue/src/lock-labor-entries.ts.
  const client = await pool.connect()
  try {
    return await processLockLaborEntries(client, companyId, 25)
  } finally {
    client.release()
  }
}

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

async function drainFieldEventNotifications(companyId: string) {
  // Drains notify_worker_resolution + notify_estimator_escalation outbox
  // rows emitted by worker_issues PATCH (RESOLVE/ESCALATE workflow events).
  // Inserts notifications rows; push-channel delivery is a follow-up.
  const client = await pool.connect()
  try {
    return await processFieldEventNotifications(client, companyId)
  } finally {
    client.release()
  }
}

interface AgentDrainSummary {
  processed: number
  insightsCreated: number
  failed: number
}

/**
 * Generic ai-insight outbox drain. Claims rows of the given mutation
 * type, runs the per-row processor, marks 'applied' on success or
 * reschedules with backoff on failure (parking at status='failed'
 * after 5 attempts so a structurally-broken row stops looping). Each
 * row runs in its own transaction so a stuck row can't strand the
 * rest of the batch.
 */
async function drainAgentMutations<TPayload>(
  mutationType: string,
  companyId: string,
  scope: string,
  process: (client: PoolClient, companyId: string, payload: TPayload) => Promise<{ insightsCreated: number }>,
): Promise<AgentDrainSummary> {
  const summary: AgentDrainSummary = { processed: 0, insightsCreated: 0, failed: 0 }
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const claimed = await client.query<{ id: string; payload: TPayload }>(
      `update mutation_outbox
         set status = 'processing',
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + interval '5 minutes',
             error = null
       where id in (
         select id from mutation_outbox
         where company_id = $1
           and mutation_type = $2
           and (
             (status = 'pending' and next_attempt_at <= now())
             or (status = 'processing' and next_attempt_at <= now())
           )
         order by next_attempt_at asc, created_at asc
         limit 5
         for update skip locked
       )
       returning id, payload`,
      [companyId, mutationType],
    )
    await client.query('commit')

    for (const row of claimed.rows) {
      summary.processed++
      await client.query('begin')
      await setCompanyGuc(client, companyId)
      try {
        const result = await process(client, companyId, row.payload)
        summary.insightsCreated += result.insightsCreated
        await client.query(
          `update mutation_outbox
             set status = 'applied', applied_at = now(), updated_at = now()
           where id = $1`,
          [row.id],
        )
        await client.query('commit')
      } catch (err) {
        summary.failed++
        await client.query('rollback').catch(() => {})
        const message = err instanceof Error ? err.message : String(err)
        await pool
          .query(
            `update mutation_outbox
               set status = case when attempt_count >= 5 then 'failed' else 'pending' end,
                   error = $2,
                   next_attempt_at = now() + interval '2 minutes',
                   updated_at = now()
             where id = $1`,
            [row.id, message],
          )
          .catch(() => {})
        captureWithEntityContext(err, {
          scope,
          company_id: companyId,
          extra_tags: { outbox_id: row.id, mutation_type: mutationType },
        })
      }
    }
  } finally {
    client.release()
  }
  return summary
}

async function drainTakeoffToBid(companyId: string): Promise<AgentDrainSummary> {
  return drainAgentMutations<TakeoffToBidPayload>('takeoff_to_bid', companyId, 'takeoff_to_bid', processTakeoffToBidRun)
}

async function drainDamageChargeInvoicePushes(companyId: string): Promise<AgentDrainSummary> {
  return drainAgentMutations<Record<string, unknown>>(
    'damage_charge_invoice_push',
    companyId,
    'damage_charge_invoice_push',
    async (client, cid, payload) => {
      await processDamageChargeInvoicePush(client, cid, payload as Parameters<typeof processDamageChargeInvoicePush>[2])
      return { insightsCreated: 0 }
    },
  )
}

async function drainVoiceToLog(companyId: string): Promise<AgentDrainSummary> {
  return drainAgentMutations<VoiceToLogPayload>('voice_to_log', companyId, 'voice_to_log', processVoiceToLogRun)
}

/**
 * Stuck-workflow alerting. A row in 'posting' state for too long means
 * either the worker crashed mid-push (recovery should have caught it,
 * but defense-in-depth) or QBO returned 200 without us recognizing it.
 * Either way the human needs to know.
 *
 * Threshold: WORKFLOW_STUCK_POSTING_MINUTES (default 30 min). Each
 * stuck row produces one Sentry event tagged with workflow + entity_id
 * so Sentry's fingerprinting groups recurring alerts on the same row
 * but separates distinct stuck rows. Cheap query (indexed on
 * (company_id, status)), runs each heartbeat.
 */
const WORKFLOW_STUCK_POSTING_MINUTES = (() => {
  const n = Number(process.env.WORKFLOW_STUCK_POSTING_MINUTES ?? 30)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30
})()

type StuckWorkflowRow = {
  id: string
  age_minutes: number
  state_version: number
  updated_at: string
}

async function checkStuckPostingWorkflows(companyId: string): Promise<{
  rentalBillingStuck: number
  estimatePushStuck: number
}> {
  const ageMinutes = WORKFLOW_STUCK_POSTING_MINUTES
  const [rental, estimate] = await Promise.all([
    pool
      .query<StuckWorkflowRow>(
        `select id,
                state_version,
                updated_at,
                extract(epoch from (now() - updated_at)) / 60 as age_minutes
         from rental_billing_runs
         where company_id = $1
           and status = 'posting'
           and deleted_at is null
           and updated_at < now() - ($2 || ' minutes')::interval
         order by updated_at asc
         limit 50`,
        [companyId, String(ageMinutes)],
      )
      .catch((err) => {
        logger.error({ err }, '[worker] stuck-posting check failed for rental_billing_runs')
        return { rows: [] as StuckWorkflowRow[] }
      }),
    pool
      .query<StuckWorkflowRow>(
        `select id,
                state_version,
                updated_at,
                extract(epoch from (now() - updated_at)) / 60 as age_minutes
         from estimate_pushes
         where company_id = $1
           and status = 'posting'
           and deleted_at is null
           and updated_at < now() - ($2 || ' minutes')::interval
         order by updated_at asc
         limit 50`,
        [companyId, String(ageMinutes)],
      )
      .catch((err) => {
        logger.error({ err }, '[worker] stuck-posting check failed for estimate_pushes')
        return { rows: [] as StuckWorkflowRow[] }
      }),
  ])

  for (const row of rental.rows) {
    fireStuckPostingAlert('rental_billing_run', companyId, row)
  }
  for (const row of estimate.rows) {
    fireStuckPostingAlert('estimate_push', companyId, row)
  }

  return { rentalBillingStuck: rental.rows.length, estimatePushStuck: estimate.rows.length }
}

function fireStuckPostingAlert(workflow: string, companyId: string, row: StuckWorkflowRow): void {
  const ageMinutes = Math.round(Number(row.age_minutes))
  const message = `Workflow stuck in posting: ${workflow} ${row.id} (${ageMinutes}m old, state_version=${row.state_version})`
  logger.error(
    {
      workflow,
      company_id: companyId,
      entity_id: row.id,
      state_version: row.state_version,
      age_minutes: ageMinutes,
      updated_at: row.updated_at,
    },
    message,
  )
  Sentry.captureMessage(message, {
    level: 'error',
    tags: {
      scope: 'workflow_stuck_posting',
      workflow_name: workflow,
      entity_type: workflow,
      entity_id: row.id,
      company_id: companyId,
    },
    extra: {
      state_version: row.state_version,
      age_minutes: ageMinutes,
      updated_at: row.updated_at,
      threshold_minutes: WORKFLOW_STUCK_POSTING_MINUTES,
    },
    // Group all alerts for the same (workflow, entity_id) under one
    // Sentry issue. New stuck rows still create separate issues.
    fingerprint: ['workflow_stuck_posting', workflow, row.id],
  })
}

async function heartbeat(): Promise<{ idle: boolean }> {
  const companyId = await getCompanyId()
  if (!companyId) {
    logger.info({ company_slug: activeCompanySlug }, '[worker] waiting for company slug')
    return { idle: true }
  }

  // Dead-letter outbox rows whose attempt_count has crossed the retry cap.
  // Runs before any drain so a broken row never gets re-claimed. Logs the
  // count when non-zero — operators can investigate via /api/system/mutation-outbox.
  try {
    const deadClient = await pool.connect()
    try {
      const dead = await deadLetterStaleOutbox(deadClient, companyId, mutationMaxRetries)
      if (dead > 0) {
        logger.warn(
          { company_id: companyId, dead, cap: mutationMaxRetries },
          '[worker] dead-lettered stale outbox rows',
        )
        captureMessageWithEntityContext('outbox rows dead-lettered', {
          level: 'warning',
          scope: 'mutation_outbox_dead_letter',
          entity_type: 'mutation_outbox',
          company_id: companyId,
          extra: { dead, cap: mutationMaxRetries },
        })
      }
    } finally {
      deadClient.release()
    }
  } catch (err) {
    // Dead-letter is best-effort; a transient DB hiccup shouldn't halt the heartbeat.
    logger.warn({ err }, '[worker] dead-letter sweep failed')
  }

  // If the QBO circuit is open, defer all pending QBO-bound outbox rows by
  // the cooldown window. Otherwise their next_attempt_at fires every 5min
  // and burns failures (and attempt_count) at the breaker.
  if (qboCircuit.isOpen('qbo')) {
    try {
      await pool.query(
        `update mutation_outbox
           set next_attempt_at = greatest(next_attempt_at, now() + ($2 || ' milliseconds')::interval)
           where company_id = $1
             and mutation_type in ('post_qbo_invoice', 'post_qbo_estimate', 'post_qbo_time_activity')
             and status in ('pending', 'processing')`,
        [companyId, String(qboCircuitCooldownMs)],
      )
    } catch (err) {
      logger.warn({ err }, '[worker] failed to defer QBO outbox under open circuit')
    }
  }

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
    drainNotifications().catch((error) => {
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

  const rentalSummary = await drainRentalInvoices(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] rental drain failed')
    captureWithEntityContext(error, {
      scope: 'rental_drain',
      entity_type: 'rental',
      company_id: companyId,
    })
    return { processed: 0, billed: 0, skipped: 0, amount: 0 }
  })

  const rentalBillingPushSummary = await drainRentalBillingInvoicePushes(companyId).catch((error) => {
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

  const estimatePushSummary = await drainEstimatePushes(companyId).catch((error) => {
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

  const lockLaborSummary = await drainLockLaborEntries(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] lock_labor_entries drain failed')
    captureWithEntityContext(error, {
      scope: 'lock_labor_entries',
      entity_type: 'labor_entry',
      company_id: companyId,
      workflow_name: 'time_review_run',
    })
    return { processed: 0, locked: 0, unlocked: 0, failed: 0 } as LockLaborEntriesSummary
  })

  await drainGenerateLaborPayrollRunBridge(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] generate_labor_payroll_run drain failed')
    captureWithEntityContext(error, {
      scope: 'generate_labor_payroll_run',
      entity_type: 'labor_payroll_run',
      company_id: companyId,
      workflow_name: 'labor_payroll_run',
    })
  })

  await drainLaborPayrollPushes(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] labor payroll push drain failed')
    captureWithEntityContext(error, {
      scope: 'labor_payroll_push',
      entity_type: 'labor_payroll_run',
      company_id: companyId,
      workflow_name: 'labor_payroll_run',
    })
  })

  await drainFieldEventNotifications(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] field event notification drain failed')
    captureWithEntityContext(error, {
      scope: 'field_event_notifications',
      entity_type: 'field_event',
      company_id: companyId,
      workflow_name: 'field_event',
    })
  })

  // Durable-timer pattern — auto-escalate worker_issues stuck open at
  // severity='stopped' beyond the configured threshold. Each heartbeat
  // claims a small batch with FOR UPDATE SKIP LOCKED so it's safe under
  // multiple worker replicas. The reducer's ESCALATE event is the same
  // path a foreman would trigger; only the actor id differs.
  await (async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const summary = await processFieldEventAutoEscalation(client, companyId, {
        ...DEFAULT_AUTO_ESCALATE_CONFIG,
        ageMinutes: Number(process.env.FIELD_EVENT_AUTO_ESCALATE_AGE_MIN ?? DEFAULT_AUTO_ESCALATE_CONFIG.ageMinutes),
      })
      await client.query('commit')
      if (summary.escalated > 0 || summary.failed > 0) {
        logger.info({ company_id: companyId, ...summary }, '[worker] field-event auto-escalation tick')
      }
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      logger.error({ err }, '[worker] field-event auto-escalation failed')
      captureWithEntityContext(err, {
        scope: 'field_event_auto_escalation',
        entity_type: 'field_event',
        company_id: companyId,
        workflow_name: 'field_event',
      })
    } finally {
      client.release()
    }
  })()

  const takeoffToBidSummary = await drainTakeoffToBid(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] takeoff_to_bid drain failed')
    captureWithEntityContext(error, {
      scope: 'takeoff_to_bid',
      entity_type: 'ai_insight',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

  const damageChargePushSummary = await drainDamageChargeInvoicePushes(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] damage_charge_invoice_push drain failed')
    captureWithEntityContext(error, {
      scope: 'damage_charge_invoice_push',
      entity_type: 'damage_charge',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
  })

  const companyCamSummary = await drainCompanyCamPolls(pool, companyId).catch((error) => {
    logger.error({ err: error }, '[worker] companycam poll failed')
    captureWithEntityContext(error, {
      scope: 'companycam_poll',
      entity_type: 'companycam_import',
      company_id: companyId,
    })
    return { processed: 0, imported: 0, skipped: 0, failed: 0 }
  })

  const voiceToLogSummary = await drainVoiceToLog(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] voice_to_log drain failed')
    captureWithEntityContext(error, {
      scope: 'voice_to_log',
      entity_type: 'ai_insight',
      company_id: companyId,
    })
    return { processed: 0, insightsCreated: 0, failed: 0 } as AgentDrainSummary
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

  if (pendingOutbox || pendingSyncEvents) {
    const processed = await processQueue(companyId)
    logger.info(
      {
        company_slug: activeCompanySlug,
        pending_outbox: pendingOutbox,
        pending_sync_events: pendingSyncEvents,
        processed_outbox: processed.processedOutbox,
        processed_sync_events: processed.processedSyncEvents,
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
        rental_billing_stuck_posting: stuckSummary.rentalBillingStuck,
        estimate_push_stuck_posting: stuckSummary.estimatePushStuck,
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
    companyCamSummary.processed > 0
  ) {
    logger.info(
      {
        company_slug: activeCompanySlug,
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
        rental_billing_stuck_posting: stuckSummary.rentalBillingStuck,
        estimate_push_stuck_posting: stuckSummary.estimatePushStuck,
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

let shutdownStarted = false
let heartbeatInFlight: Promise<{ idle: boolean } | undefined> | null = null
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

// Adaptive backoff: when a heartbeat finds no work, stretch the next tick to
// `idlePollIntervalMs` (default 3x active). The first non-idle tick resets to
// the active cadence. Saves CPU on busy hosts where the worker is mostly
// waiting around.
const idlePollIntervalMs = (() => {
  const raw = process.env.WORKER_IDLE_POLL_INTERVAL_MS
  const fallback = pollIntervalMs * 3
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
})()

async function runHeartbeat(): Promise<{ idle: boolean } | undefined> {
  if (shutdownStarted) return undefined
  if (heartbeatInFlight) {
    logger.warn('[worker] previous heartbeat still running; skipping overlap')
    return undefined
  }

  heartbeatInFlight = heartbeat()
    .catch((error) => {
      logger.error({ err: error }, '[worker] heartbeat failed')
      captureWithEntityContext(error, { scope: 'worker_heartbeat' })
      return undefined
    })
    .finally(() => {
      heartbeatInFlight = null
    })

  return await heartbeatInFlight
}

function scheduleNextHeartbeat(idle: boolean): void {
  if (shutdownStarted) return
  const delay = idle ? idlePollIntervalMs : pollIntervalMs
  heartbeatTimer = setTimeout(() => {
    void runHeartbeat()
      .then((result) => {
        const nextIdle = result?.idle ?? true
        scheduleNextHeartbeat(nextIdle)
      })
      .catch(() => {
        // runHeartbeat already logs/captures on failure; treat as idle so we
        // back off a bit before the next attempt.
        scheduleNextHeartbeat(true)
      })
  }, delay)
}

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return
  shutdownStarted = true
  logger.info({ signal }, '[worker] shutting down')
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer)
  }

  const forceExit = setTimeout(
    () => {
      logger.error({ signal }, '[worker] shutdown timed out')
      process.exit(1)
    },
    Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000),
  )
  forceExit.unref()

  try {
    if (heartbeatInFlight) {
      await heartbeatInFlight
    }
    await pool.end()
    await Sentry.flush(2_000)
    clearTimeout(forceExit)
    logger.info({ signal }, '[worker] shutdown complete')
    process.exit(0)
  } catch (error) {
    clearTimeout(forceExit)
    logger.error({ err: error, signal }, '[worker] shutdown failed')
    captureWithEntityContext(error, { scope: 'worker_shutdown' })
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

const initial = await runHeartbeat()
scheduleNextHeartbeat(initial?.idle ?? true)

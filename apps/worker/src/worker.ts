import { Sentry } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import {
  fetchDueRentals,
  processEstimatePush,
  processLockLaborEntries,
  processQueueWithClient,
  processRentalBillingInvoicePush,
  processRentalInvoice,
  recordLedger,
  type EstimatePushFn,
  type EstimatePushSummary,
  type LockLaborEntriesSummary,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'
import { spanForAppliedRow } from './trace.js'
import { loadEmailConfig, sendEmail } from './email.js'
import { createQboRentalInvoicePush } from './qbo-invoice-push.js'
import { createQboEstimatePush } from './qbo-estimate-push.js'
import { createClerkClient } from '@clerk/backend'
import { clerkUserFetcherFromClient, createClerkResolver, type ClerkResolver } from './clerk-hydrate.js'
import { drainNotifications as drainNotificationsBatch } from './notifications.js'
import { processTakeoffToBidRun, type TakeoffToBidPayload } from './takeoff-to-bid-agent.js'
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

async function processQueue(companyId: string, limit = 25) {
  const client = await pool.connect()
  try {
    await client.query('begin')
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
        Sentry.captureException(error, { tags: { scope: 'rental_invoice' } })
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
  hydrateEmail: NOTIFICATIONS_ENABLED && clerkResolver
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
const stubRentalBillingInvoicePush: RentalBillingInvoicePushFn = async ({ runId }) => {
  return { qbo_invoice_id: `STUB-INV-${runId.slice(0, 8)}-${Date.now()}` }
}

const liveRentalBillingInvoicePushEnabled = process.env.QBO_LIVE_RENTAL_INVOICE === '1'
const rentalBillingInvoicePush: RentalBillingInvoicePushFn = liveRentalBillingInvoicePushEnabled
  ? createQboRentalInvoicePush()
  : stubRentalBillingInvoicePush

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
const estimatePush: EstimatePushFn = liveEstimatePushEnabled ? createQboEstimatePush() : stubEstimatePush

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

interface TakeoffToBidSummary {
  processed: number
  insightsCreated: number
  failed: number
}

/**
 * Drain mutation_outbox rows for the takeoff-to-bid agent (Phase 5).
 * Each row claims a project, runs the agent (LLM stub today), and
 * lands one ai_insights row containing the proposed bid lines. Rows
 * are processed in their own transactions so a failed run doesn't
 * strand sibling work.
 */
async function drainTakeoffToBid(companyId: string): Promise<TakeoffToBidSummary> {
  const summary: TakeoffToBidSummary = { processed: 0, insightsCreated: 0, failed: 0 }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const claimed = await client.query<{ id: string; payload: TakeoffToBidPayload }>(
      `update mutation_outbox
         set status = 'processing',
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + interval '5 minutes',
             error = null
       where id in (
         select id from mutation_outbox
         where company_id = $1
           and mutation_type = 'takeoff_to_bid'
           and (
             (status = 'pending' and next_attempt_at <= now())
             or (status = 'processing' and next_attempt_at <= now())
           )
         order by next_attempt_at asc, created_at asc
         limit 5
         for update skip locked
       )
       returning id, payload`,
      [companyId],
    )
    await client.query('commit')

    for (const row of claimed.rows) {
      summary.processed++
      await client.query('begin')
      try {
        const result = await processTakeoffToBidRun(client, companyId, row.payload)
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
        Sentry.captureException(err, { tags: { scope: 'takeoff_to_bid', outbox_id: row.id } })
      }
    }
  } finally {
    client.release()
  }
  return summary
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
      workflow,
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
      Sentry.captureException(error)
      return { processed: 0, sent: 0, failed: 0, shortCircuited: false, deferred: 0, hydrated: 0 }
    }),
  ])

  const pendingOutbox = outboxResult.rows[0]?.pending_count ?? 0
  const pendingSyncEvents = syncResult.rows[0]?.pending_count ?? 0

  const rentalSummary = await drainRentalInvoices(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] rental drain failed')
    Sentry.captureException(error, { tags: { scope: 'rental_drain' } })
    return { processed: 0, billed: 0, skipped: 0, amount: 0 }
  })

  const rentalBillingPushSummary = await drainRentalBillingInvoicePushes(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] rental billing invoice push drain failed')
    Sentry.captureException(error, { tags: { scope: 'rental_billing_invoice_push' } })
    return { processed: 0, posted: 0, failed: 0, skipped: 0 }
  })

  const estimatePushSummary = await drainEstimatePushes(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] estimate push drain failed')
    Sentry.captureException(error, { tags: { scope: 'estimate_push' } })
    return { processed: 0, posted: 0, failed: 0, skipped: 0 }
  })

  const lockLaborSummary = await drainLockLaborEntries(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] lock_labor_entries drain failed')
    Sentry.captureException(error, { tags: { scope: 'lock_labor_entries' } })
    return { processed: 0, locked: 0, unlocked: 0, failed: 0 } as LockLaborEntriesSummary
  })

  const takeoffToBidSummary = await drainTakeoffToBid(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] takeoff_to_bid drain failed')
    Sentry.captureException(error, { tags: { scope: 'takeoff_to_bid' } })
    return { processed: 0, insightsCreated: 0, failed: 0 } as TakeoffToBidSummary
  })

  // Defense-in-depth alert: any workflow row stuck in 'posting' beyond
  // the threshold means the worker crashed mid-push or QBO succeeded
  // silently and the worker missed the response. Surface to Sentry so
  // a human can investigate.
  const stuckSummary = await checkStuckPostingWorkflows(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] stuck-posting check failed')
    Sentry.captureException(error, { tags: { scope: 'workflow_stuck_check' } })
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
    takeoffToBidSummary.processed > 0
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
      Sentry.captureException(error)
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
    Sentry.captureException(error)
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

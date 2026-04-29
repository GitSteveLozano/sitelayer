import { Sentry } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import {
  fetchDueRentals,
  processEstimatePush,
  processQueueWithClient,
  processRentalBillingInvoicePush,
  processRentalInvoice,
  recordLedger,
  type EstimatePushFn,
  type EstimatePushSummary,
  type RentalBillingInvoicePushFn,
  type RentalBillingInvoicePushSummary,
} from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'
import { spanForAppliedRow } from './trace.js'
import { loadEmailConfig, sendEmail } from './email.js'
import { createQboRentalInvoicePush } from './qbo-invoice-push.js'

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

type PendingNotificationRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  body_text: string
  body_html: string | null
  attempt_count: number
}

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

/**
 * Claim up to `limit` pending notifications with `FOR UPDATE SKIP LOCKED` and
 * send them. On failure we increment `attempt_count`, back off exponentially
 * (5 minutes * 2^attempt_count), and mark `failed` after `NOTIFICATION_MAX_ATTEMPTS`.
 *
 * Includes a tiny per-batch circuit breaker: after
 * `NOTIFICATION_PROVIDER_FAILURE_THRESHOLD` consecutive send failures we stop
 * processing the batch and let the surviving rows go back into the pool with
 * their original next_attempt_at intact.
 */
async function drainNotifications(limit = notificationBatchLimit): Promise<{
  processed: number
  sent: number
  failed: number
  shortCircuited: boolean
}> {
  const client = await pool.connect()
  let processed = 0
  let sent = 0
  let failed = 0
  let consecutiveFailures = 0
  let shortCircuited = false
  try {
    await client.query('begin')
    const claimed = await client.query<PendingNotificationRow>(
      `
      select id, company_id, recipient_clerk_user_id, recipient_email, kind, subject, body_text, body_html, attempt_count
      from notifications
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc, created_at asc
      limit $1
      for update skip locked
      `,
      [limit],
    )
    for (const row of claimed.rows) {
      if (consecutiveFailures >= NOTIFICATION_PROVIDER_FAILURE_THRESHOLD) {
        shortCircuited = true
        break
      }
      processed += 1
      const recipient = row.recipient_email ?? row.recipient_clerk_user_id
      // Broadcast rows with no email: log via console provider and mark sent
      // so they don't loop. Real email lookup (Clerk → email) is TODO.
      if (!recipient) {
        await client.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [row.id])
        sent += 1
        consecutiveFailures = 0
        logger.info({ id: row.id, kind: row.kind, recipient: 'broadcast' }, '[notifications] logged broadcast')
        continue
      }
      try {
        const message: { to: string; subject: string; text: string; html?: string } = {
          to: recipient,
          subject: row.subject,
          text: row.body_text,
        }
        if (row.body_html) message.html = row.body_html
        await sendEmail(message, { config: emailConfig })
        await client.query(`update notifications set status = 'sent', sent_at = now(), error = null where id = $1`, [
          row.id,
        ])
        sent += 1
        consecutiveFailures = 0
      } catch (err) {
        const nextAttemptCount = row.attempt_count + 1
        const message = err instanceof Error ? err.message : String(err)
        const exceededMax = nextAttemptCount >= NOTIFICATION_MAX_ATTEMPTS
        const nextStatus = exceededMax ? 'failed' : 'pending'
        // Exponential backoff: 5m * 2^attempt_count, clamped by Postgres interval math.
        // After attempt 1 -> 10m, attempt 2 -> 20m, attempt 3 -> 40m, attempt 4 -> 80m.
        const backoffSeconds = Math.min(60 * 60 * 24, 300 * Math.pow(2, nextAttemptCount))
        await client.query(
          `
          update notifications
          set status = $2,
              attempt_count = $3,
              next_attempt_at = now() + ($4 || ' seconds')::interval,
              error = $5
          where id = $1
          `,
          [row.id, nextStatus, nextAttemptCount, backoffSeconds, message.slice(0, 2000)],
        )
        failed += 1
        consecutiveFailures += 1
        logger.warn(
          {
            id: row.id,
            kind: row.kind,
            attempt_count: nextAttemptCount,
            next_status: nextStatus,
            err: message,
          },
          '[notifications] send failed',
        )
      }
    }
    if (shortCircuited) {
      logger.warn(
        {
          consecutive_failures: consecutiveFailures,
          processed,
          sent,
          failed,
          remaining: claimed.rows.length - processed,
        },
        '[notifications] short-circuited batch (suspected provider outage)',
      )
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return { processed, sent, failed, shortCircuited }
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
  const client = await pool.connect()
  try {
    await client.query('begin')
    const summary = await processRentalBillingInvoicePush(client, companyId, rentalBillingInvoicePush, 5)
    await client.query('commit')
    return summary
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const stubEstimatePush: EstimatePushFn = async ({ pushId }) => {
  return { qbo_estimate_id: `STUB-EST-${pushId.slice(0, 8)}-${Date.now()}` }
}

const liveEstimatePushEnabled = process.env.QBO_LIVE_ESTIMATE_PUSH === '1'
const estimatePush: EstimatePushFn = liveEstimatePushEnabled ? stubEstimatePush : stubEstimatePush
// NOTE: live estimate push impl lives in qbo-estimate-push.ts when added.
// Until then both branches use the stub; the env flag is plumbed so
// flipping to live is a one-line wire-up.

if (liveEstimatePushEnabled) {
  logger.info('[estimate-push] live QBO estimate push flag set (still stubbed until qbo-estimate-push.ts ships)')
} else {
  logger.info('[estimate-push] stub QBO estimate push (set QBO_LIVE_ESTIMATE_PUSH=1 once live impl ships)')
}

async function drainEstimatePushes(companyId: string): Promise<EstimatePushSummary> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const summary = await processEstimatePush(client, companyId, estimatePush, 5)
    await client.query('commit')
    return summary
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
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
      return { processed: 0, sent: 0, failed: 0, shortCircuited: false }
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
      },
      '[worker] tick',
    )
    return { idle: false }
  }

  if (
    notifications.processed > 0 ||
    rentalSummary.processed > 0 ||
    rentalBillingPushSummary.processed > 0 ||
    estimatePushSummary.processed > 0
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

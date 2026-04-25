import { Sentry } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import { fetchDueRentals, processQueueWithClient, processRentalInvoice } from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'
import { spanForAppliedRow } from './trace.js'
import { loadEmailConfig, sendEmail } from './email.js'

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

/**
 * Claim up to `limit` pending notifications with `FOR UPDATE SKIP LOCKED` and
 * send them. On failure we increment `attempt_count`, back off exponentially
 * (5 minutes * 2^attempt_count), and mark `failed` after `NOTIFICATION_MAX_ATTEMPTS`.
 */
async function drainNotifications(limit = notificationBatchLimit): Promise<{
  processed: number
  sent: number
  failed: number
}> {
  const client = await pool.connect()
  let processed = 0
  let sent = 0
  let failed = 0
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
      processed += 1
      const recipient = row.recipient_email ?? row.recipient_clerk_user_id
      // Broadcast rows with no email: log via console provider and mark sent
      // so they don't loop. Real email lookup (Clerk → email) is TODO.
      if (!recipient) {
        await client.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [row.id])
        sent += 1
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
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return { processed, sent, failed }
}

async function heartbeat() {
  const companyId = await getCompanyId()
  if (!companyId) {
    logger.info({ company_slug: activeCompanySlug }, '[worker] waiting for company slug')
    return
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
      return { processed: 0, sent: 0, failed: 0 }
    }),
  ])

  const pendingOutbox = outboxResult.rows[0]?.pending_count ?? 0
  const pendingSyncEvents = syncResult.rows[0]?.pending_count ?? 0

  const rentalSummary = await drainRentalInvoices(companyId).catch((error) => {
    logger.error({ err: error }, '[worker] rental drain failed')
    Sentry.captureException(error, { tags: { scope: 'rental_drain' } })
    return { processed: 0, billed: 0, skipped: 0, amount: 0 }
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
      },
      '[worker] tick',
    )
    return
  }

  if (notifications.processed > 0 || rentalSummary.processed > 0) {
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
      },
      '[worker] background tick',
    )
    return
  }

  logger.debug(
    {
      company_slug: activeCompanySlug,
      pending_outbox: pendingOutbox,
      pending_sync_events: pendingSyncEvents,
    },
    '[worker] idle',
  )
}

let shutdownStarted = false
let heartbeatInFlight: Promise<void> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

async function runHeartbeat() {
  if (shutdownStarted) return
  if (heartbeatInFlight) {
    logger.warn('[worker] previous heartbeat still running; skipping overlap')
    return
  }

  heartbeatInFlight = heartbeat()
    .catch((error) => {
      logger.error({ err: error }, '[worker] heartbeat failed')
      Sentry.captureException(error)
    })
    .finally(() => {
      heartbeatInFlight = null
    })

  await heartbeatInFlight
}

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return
  shutdownStarted = true
  logger.info({ signal }, '[worker] shutting down')
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
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

await runHeartbeat()
heartbeatTimer = setInterval(() => {
  void runHeartbeat()
}, pollIntervalMs)

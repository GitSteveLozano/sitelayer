import { Sentry } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger } from '@sitelayer/logger'
import { fetchDueRentals, processQueueWithClient, processRentalInvoice } from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'
import { spanForAppliedRow } from './trace.js'

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

async function heartbeat() {
  const companyId = await getCompanyId()
  if (!companyId) {
    logger.info({ company_slug: activeCompanySlug }, '[worker] waiting for company slug')
    return
  }

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
        rentals_processed: rentalSummary.processed,
        rentals_billed: rentalSummary.billed,
        rentals_skipped: rentalSummary.skipped,
        rentals_billed_amount: rentalSummary.amount,
      },
      '[worker] tick',
    )
    return
  }

  if (rentalSummary.processed > 0) {
    logger.info(
      {
        company_slug: activeCompanySlug,
        rentals_processed: rentalSummary.processed,
        rentals_billed: rentalSummary.billed,
        rentals_skipped: rentalSummary.skipped,
        rentals_billed_amount: rentalSummary.amount,
      },
      '[worker] rental tick',
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

await heartbeat()
setInterval(() => {
  void heartbeat().catch((error) => {
    logger.error({ err: error }, '[worker] heartbeat failed')
    Sentry.captureException(error)
  })
}, pollIntervalMs)

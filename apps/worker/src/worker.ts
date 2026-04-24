import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { processQueue as processDatabaseQueue } from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'

let appConfig: ReturnType<typeof loadAppConfig>
try {
  appConfig = loadAppConfig()
} catch (err) {
  if (err instanceof TierConfigError) {
    console.error(`[tier] refusing to start: ${err.message}`)
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
  const result = await processDatabaseQueue(pool, companyId, limit)
  return {
    processedOutbox: result.processedOutboxCount,
    processedSyncEvents: result.processedSyncEventCount,
  }
}

async function getCompanyId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    'select id from companies where slug = $1 limit 1',
    [activeCompanySlug],
  )
  return result.rows[0]?.id ?? null
}

async function heartbeat() {
  const companyId = await getCompanyId()
  if (!companyId) {
    console.log(`[worker] waiting for company slug ${activeCompanySlug}`)
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

  if (pendingOutbox || pendingSyncEvents) {
    const processed = await processQueue(companyId)
    console.log(
      `[worker] company=${activeCompanySlug} pending_outbox=${pendingOutbox} pending_sync_events=${pendingSyncEvents} processed_outbox=${processed.processedOutbox} processed_sync_events=${processed.processedSyncEvents}`,
    )
    return
  }

  console.log(
    `[worker] company=${activeCompanySlug} pending_outbox=${pendingOutbox} pending_sync_events=${pendingSyncEvents} processed_outbox=0 processed_sync_events=0`,
  )
}

await heartbeat()
setInterval(() => {
  void heartbeat().catch((error) => {
    console.error('[worker] heartbeat failed', error)
  })
}, pollIntervalMs)

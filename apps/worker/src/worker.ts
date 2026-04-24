import { Pool, type PoolConfig } from 'pg'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
const activeCompanySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 10_000)
const appTier = parseAppTier(process.env.APP_TIER)

type AppTier = 'local' | 'dev' | 'preview' | 'prod'

function parseAppTier(raw: string | undefined): AppTier {
  const normalized = raw?.trim().toLowerCase() || 'local'
  if (normalized === 'local' || normalized === 'dev' || normalized === 'preview' || normalized === 'prod') return normalized
  throw new Error(`APP_TIER must be one of local|dev|preview|prod (got "${raw}")`)
}

function getDatabaseName(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

function assertDatabaseMatchesTier(tier: AppTier, connectionString: string) {
  const dbName = getDatabaseName(connectionString)
  if (tier === 'prod' && !/sitelayer_prod\b/.test(dbName)) {
    throw new Error(`APP_TIER=prod but DATABASE_URL database name is "${dbName}"`)
  }
  if (tier !== 'prod' && /sitelayer_prod\b/.test(dbName) && !dbName.endsWith('_ro')) {
    throw new Error(`APP_TIER=${tier} but DATABASE_URL points at prod database "${dbName}"`)
  }
}

function withTierOptions(config: PoolConfig): PoolConfig {
  return { ...config, options: `-c app.tier=${appTier}` }
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

assertDatabaseMatchesTier(appTier, databaseUrl)

const pool = new Pool(getPoolConfig(databaseUrl))

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
      `select count(*)::int as pending_count from mutation_outbox where company_id = $1 and status = 'pending'`,
      [companyId],
    ),
    pool.query<{ pending_count: number }>(
      `select count(*)::int as pending_count from sync_events where company_id = $1 and status = 'pending'`,
      [companyId],
    ),
  ])

  const pendingOutbox = outboxResult.rows[0]?.pending_count ?? 0
  const pendingSyncEvents = syncResult.rows[0]?.pending_count ?? 0

  let processedOutbox = 0
  let processedSyncEvents = 0
  if (pendingOutbox || pendingSyncEvents) {
    const drainedOutbox = await pool.query(
      `
      update mutation_outbox
      set status = 'applied', applied_at = coalesce(applied_at, now()), error = null
      where id in (
        select id
        from mutation_outbox
        where company_id = $1 and status = 'pending'
        order by created_at asc
        limit 25
      )
      returning id
      `,
      [companyId],
    )
    const drainedSync = await pool.query(
      `
      update sync_events
      set status = 'applied'
      where id in (
        select id
        from sync_events
        where company_id = $1 and status = 'pending'
        order by created_at asc
        limit 25
      )
      returning id
      `,
      [companyId],
    )
    processedOutbox = drainedOutbox.rowCount ?? 0
    processedSyncEvents = drainedSync.rowCount ?? 0

    await pool.query(
      `
      update integration_connections
      set last_synced_at = now(), status = 'connected'
      where company_id = $1 and provider in ('qbo', 'demo')
      `,
      [companyId],
    )
  }

  console.log(
    `[worker] company=${activeCompanySlug} pending_outbox=${pendingOutbox} pending_sync_events=${pendingSyncEvents} processed_outbox=${processedOutbox} processed_sync_events=${processedSyncEvents}`,
  )
}

await heartbeat()
setInterval(() => {
  void heartbeat().catch((error) => {
    console.error('[worker] heartbeat failed', error)
  })
}, pollIntervalMs)

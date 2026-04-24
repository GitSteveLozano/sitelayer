import { Pool, type PoolClient, type PoolConfig } from 'pg'

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

async function processOutboxBatch(client: PoolClient, companyId: string, limit: number) {
  const claimed = await client.query(
    `
    update mutation_outbox
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      next_attempt_at = now() + interval '5 minutes',
      error = null
    where id in (
      select id
      from mutation_outbox
      where company_id = $1
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return 0

  const applied = await client.query(
    `
    update mutation_outbox
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id
    `,
    [companyId, ids],
  )
  return applied.rowCount ?? 0
}

async function processSyncEventBatch(client: PoolClient, companyId: string, limit: number) {
  const claimed = await client.query(
    `
    update sync_events
    set
      status = 'processing',
      attempt_count = attempt_count + 1,
      next_attempt_at = now() + interval '5 minutes',
      error = null
    where id in (
      select id
      from sync_events
      where company_id = $1
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and next_attempt_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      limit $2
      for update skip locked
    )
    returning id
    `,
    [companyId, limit],
  )

  const ids = claimed.rows.map((row) => row.id)
  if (!ids.length) return 0

  const applied = await client.query(
    `
    update sync_events
    set status = 'applied', applied_at = now(), error = null
    where company_id = $1 and id = any($2::uuid[])
    returning id
    `,
    [companyId, ids],
  )
  return applied.rowCount ?? 0
}

async function processQueue(companyId: string, limit = 25) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const processedOutbox = await processOutboxBatch(client, companyId, limit)
    const processedSyncEvents = await processSyncEventBatch(client, companyId, limit)

    if (processedOutbox || processedSyncEvents) {
      await client.query(
        `
        update integration_connections
        set last_synced_at = now(), status = 'connected', version = version + 1
        where company_id = $1 and provider in ('qbo', 'demo')
        `,
        [companyId],
      )
    }

    await client.query('commit')
    return { processedOutbox, processedSyncEvents }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
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

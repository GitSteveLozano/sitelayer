import { Sentry } from './instrument.js'
import { loadAppConfig, postgresOptionsForTier, TierConfigError } from '@sitelayer/config'
import { createLogger, runWithRequestContext } from '@sitelayer/logger'
import { processQueueWithClient, type ProcessedOutboxRow, type ProcessedSyncEventRow } from '@sitelayer/queue'
import { Pool, type PoolConfig } from 'pg'

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

type RowWithTrace = Pick<
  ProcessedOutboxRow | ProcessedSyncEventRow,
  'id' | 'entity_type' | 'sentry_trace' | 'sentry_baggage' | 'request_id'
> & { kind: 'outbox' | 'sync_event' }

function spanForAppliedRow(row: RowWithTrace) {
  const continueParams = {
    sentryTrace: row.sentry_trace ?? undefined,
    baggage: row.sentry_baggage ?? undefined,
  }
  const ctx = { requestId: row.request_id ?? `worker-${row.id}` }
  Sentry.continueTrace(continueParams, () => {
    runWithRequestContext(ctx, () => {
      Sentry.startSpan(
        {
          name: `queue.apply ${row.kind} ${row.entity_type}`,
          op: 'queue.process',
          attributes: {
            'queue.kind': row.kind,
            'queue.row_id': row.id,
            'queue.entity_type': row.entity_type,
            request_id: row.request_id ?? undefined,
          },
        },
        () => {
          logger.info(
            { queue_kind: row.kind, row_id: row.id, entity_type: row.entity_type, request_id: row.request_id },
            'queue row applied',
          )
        },
      )
    })
  })
}

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

  if (pendingOutbox || pendingSyncEvents) {
    const processed = await processQueue(companyId)
    logger.info(
      {
        company_slug: activeCompanySlug,
        pending_outbox: pendingOutbox,
        pending_sync_events: pendingSyncEvents,
        processed_outbox: processed.processedOutbox,
        processed_sync_events: processed.processedSyncEvents,
      },
      '[worker] tick',
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

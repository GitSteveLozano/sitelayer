import { Pool, type PoolConfig } from 'pg'
import { postgresOptionsForTier, type loadAppConfig } from '@sitelayer/config'

type AppConfig = ReturnType<typeof loadAppConfig>

export interface BuildPoolOptions {
  databaseUrl: string
  appConfig: AppConfig
  rejectUnauthorized: boolean
}

export function buildPool({ databaseUrl, appConfig, rejectUnauthorized }: BuildPoolOptions): Pool {
  // Close pg backends that have sat idle for this long. Without it the
  // worker's pool clings to managed-Postgres connections forever — and
  // DO bills connection-hours on its managed instances. 30s default is
  // a sweet spot: long enough that a steady tick reuses the same
  // backend, short enough that an actually-idle worker releases its
  // slot back to PG within seconds. Reconnects are cheap (sub-ms over
  // unix socket, ~5ms over TLS).
  const idleTimeoutMillis = (() => {
    const raw = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000
  })()

  // Cap the worker's backends explicitly. Without a `max` pg defaults to 10,
  // which stacks on top of the API pool against a ~22-connection managed
  // Postgres (worker + API + preview/dev share one db-s-1vcpu-1gb). The worker
  // is a serial tick loop — a handful of connections is plenty. Env override
  // (WORKER_PG_POOL_MAX) wins.
  const max = (() => {
    const raw = Number(process.env.WORKER_PG_POOL_MAX ?? 4)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4
  })()

  const withTierOptions = (config: PoolConfig): PoolConfig => ({
    ...config,
    options: postgresOptionsForTier(appConfig.tier, config.options || process.env.PGOPTIONS),
    idleTimeoutMillis,
    max,
  })

  const getPoolConfig = (connectionString: string): PoolConfig => {
    try {
      const url = new URL(connectionString)
      const sslMode = url.searchParams.get('sslmode')
      if (!rejectUnauthorized && sslMode && sslMode !== 'disable') {
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

  return new Pool(getPoolConfig(databaseUrl))
}

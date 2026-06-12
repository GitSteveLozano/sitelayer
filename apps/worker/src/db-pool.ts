import { Pool, type PoolConfig } from 'pg'
import { postgresOptionsForTier, resolveDatabasePoolSsl, type loadAppConfig } from '@sitelayer/config'

type AppConfig = ReturnType<typeof loadAppConfig>

export interface BuildPoolOptions {
  databaseUrl: string
  appConfig: AppConfig
  /** Caller-resolved legacy DATABASE_SSL_REJECT_UNAUTHORIZED flag. A
   *  DATABASE_CA_CERT in the env wins over this (verified TLS). */
  rejectUnauthorized: boolean
  /** Injectable env for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

export function buildPool({ databaseUrl, appConfig, rejectUnauthorized, env }: BuildPoolOptions): Pool {
  // Close pg backends that have sat idle for this long. Without it the
  // worker's pool clings to managed-Postgres connections forever — and
  // DO bills connection-hours on its managed instances. 30s default is
  // a sweet spot: long enough that a steady tick reuses the same
  // backend, short enough that an actually-idle worker releases its
  // slot back to PG within seconds. Reconnects are cheap (sub-ms over
  // unix socket, ~5ms over TLS).
  const environment = env ?? process.env
  const idleTimeoutMillis = (() => {
    const raw = Number(environment.PG_IDLE_TIMEOUT_MS ?? 30_000)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000
  })()

  // Cap the worker's backends explicitly. Without a `max` pg defaults to 10,
  // which stacks on top of the API pool against a ~22-connection managed
  // Postgres (worker + API + preview/dev share one db-s-1vcpu-1gb). The worker
  // is a serial tick loop — a handful of connections is plenty. Env override
  // (WORKER_PG_POOL_MAX) wins.
  const max = (() => {
    const raw = Number(environment.WORKER_PG_POOL_MAX ?? 4)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4
  })()

  const withTierOptions = (config: PoolConfig): PoolConfig => ({
    ...config,
    options: postgresOptionsForTier(appConfig.tier, config.options || environment.PGOPTIONS),
    idleTimeoutMillis,
    max,
  })

  // TLS shape comes from @sitelayer/config: DATABASE_CA_CERT -> verified TLS
  // against the managed-PG CA bundle (wins over the legacy flag);
  // rejectUnauthorized:false -> legacy no-verify; default -> pass through.
  const { connectionString, ssl } = resolveDatabasePoolSsl(databaseUrl, { env: environment, rejectUnauthorized })
  return new Pool(withTierOptions(ssl ? { connectionString, ssl } : { connectionString }))
}

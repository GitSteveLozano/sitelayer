import { Pool, type PoolConfig } from 'pg'
import { postgresOptionsForTier, type loadAppConfig } from '@sitelayer/config'

type AppConfig = ReturnType<typeof loadAppConfig>

export interface BuildPoolOptions {
  databaseUrl: string
  appConfig: AppConfig
  rejectUnauthorized: boolean
}

export function buildPool({ databaseUrl, appConfig, rejectUnauthorized }: BuildPoolOptions): Pool {
  const withTierOptions = (config: PoolConfig): PoolConfig => ({
    ...config,
    options: postgresOptionsForTier(appConfig.tier, config.options || process.env.PGOPTIONS),
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

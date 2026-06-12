import { describe, expect, it } from 'vitest'
import { loadAppConfig } from '@sitelayer/config'
import { buildPool, type BuildPoolOptions } from './db-pool.js'

/**
 * buildPool TLS wiring: the worker pool must route its ssl shape through
 * @sitelayer/config's resolveDatabasePoolSsl so DATABASE_CA_CERT enables
 * verified TLS, while the legacy rejectUnauthorized:false escape hatch and
 * the no-TLS dev/preview pass-through keep working unchanged.
 *
 * We never connect — pg's Pool exposes its resolved config as `options`,
 * which is all these assertions need.
 */

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
const TLS_URL = 'postgres://app:pw@db.example.com:25060/sitelayer?sslmode=require'
const PLAIN_URL = 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

const appConfig = loadAppConfig({ APP_TIER: 'local', DATABASE_URL: PLAIN_URL })

type PoolInternals = { options: { connectionString?: string; ssl?: unknown; max?: number; idleTimeoutMillis?: number } }

function build(overrides: Partial<BuildPoolOptions> = {}) {
  const pool = buildPool({
    databaseUrl: PLAIN_URL,
    appConfig,
    rejectUnauthorized: true,
    env: {},
    ...overrides,
  })
  const options = (pool as unknown as PoolInternals).options
  void pool.end()
  return options
}

describe('buildPool ssl wiring', () => {
  it('attaches verified TLS (ca + rejectUnauthorized:true) when DATABASE_CA_CERT is set', () => {
    const options = build({ databaseUrl: TLS_URL, env: { DATABASE_CA_CERT: CA } })
    expect(options.ssl).toEqual({ ca: CA, rejectUnauthorized: true })
    expect(options.connectionString).not.toContain('sslmode')
  })

  it('CA bundle wins over rejectUnauthorized:false (the legacy escape hatch)', () => {
    const options = build({ databaseUrl: TLS_URL, env: { DATABASE_CA_CERT: CA }, rejectUnauthorized: false })
    expect(options.ssl).toEqual({ ca: CA, rejectUnauthorized: true })
  })

  it('keeps the legacy no-verify behavior when rejectUnauthorized:false and no CA', () => {
    const options = build({ databaseUrl: TLS_URL, rejectUnauthorized: false })
    expect(options.ssl).toEqual({ rejectUnauthorized: false })
    expect(options.connectionString).not.toContain('sslmode')
  })

  it('passes a TLS URL through untouched by default (pg owns sslmode)', () => {
    const options = build({ databaseUrl: TLS_URL })
    expect(options.ssl).toBeUndefined()
    expect(options.connectionString).toBe(TLS_URL)
  })

  it('never touches a URL without sslmode, even with a CA set', () => {
    const options = build({ env: { DATABASE_CA_CERT: CA } })
    expect(options.ssl).toBeUndefined()
    expect(options.connectionString).toBe(PLAIN_URL)
  })

  it('keeps the idle-timeout and max-connection caps', () => {
    const options = build({ env: { PG_IDLE_TIMEOUT_MS: '10000', WORKER_PG_POOL_MAX: '2' } })
    expect(options.idleTimeoutMillis).toBe(10_000)
    expect(options.max).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAppConfig, loadLocalEnv, parseEnvLine, postgresOptionsForTier, TierConfigError } from './index.js'

const localDatabaseUrl = 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
const prodDatabaseUrl = 'postgres://sitelayer_prod_app:secret@db.example.com:25060/sitelayer_prod?sslmode=require'
const devDatabaseUrl = 'postgres://sitelayer_dev_app:secret@db.example.com:25060/sitelayer_dev?sslmode=require'
const previewDatabaseUrl =
  'postgres://sitelayer_preview_app:secret@db.example.com:25060/sitelayer_preview?sslmode=require'
const demoDatabaseUrl = 'postgres://sitelayer_demo_app:secret@db.example.com:25060/sitelayer_demo?sslmode=require'
const prodReadOnlyUrl = 'postgres://sitelayer_prod_ro:secret@db.example.com:25060/sitelayer_prod?sslmode=require'

describe('loadAppConfig', () => {
  it('defaults to local outside production', () => {
    const config = loadAppConfig({ DATABASE_URL: localDatabaseUrl })
    expect(config.tier).toBe('local')
    expect(config.ribbon?.label).toContain('LOCAL')
  })

  it('requires APP_TIER in production', () => {
    expect(() => loadAppConfig({ NODE_ENV: 'production', DATABASE_URL: prodDatabaseUrl })).toThrow(TierConfigError)
  })

  it('requires the prod tier to use the prod database', () => {
    expect(() => loadAppConfig({ APP_TIER: 'prod', DATABASE_URL: devDatabaseUrl })).toThrow(TierConfigError)
  })

  it('refuses prod database access from non-prod tiers', () => {
    expect(() => loadAppConfig({ APP_TIER: 'preview', DATABASE_URL: prodDatabaseUrl })).toThrow(TierConfigError)
  })

  it('accepts preview tier with preview database', () => {
    const config = loadAppConfig({ APP_TIER: 'preview', DATABASE_URL: previewDatabaseUrl })
    expect(config.tier).toBe('preview')
    expect(config.ribbon?.label).toContain('PREVIEW')
  })

  it('accepts demo tier with demo database and shows a distinct ribbon', () => {
    const config = loadAppConfig({ APP_TIER: 'demo', DATABASE_URL: demoDatabaseUrl })
    expect(config.tier).toBe('demo')
    expect(config.ribbon?.label).toContain('DEMO')
    expect(config.ribbon?.tone).toBe('demo')
  })

  it('requires the demo tier to use the demo database when not on a local host', () => {
    expect(() => loadAppConfig({ APP_TIER: 'demo', DATABASE_URL: devDatabaseUrl })).toThrow(TierConfigError)
  })

  it('refuses prod database access from the demo tier', () => {
    expect(() => loadAppConfig({ APP_TIER: 'demo', DATABASE_URL: prodDatabaseUrl })).toThrow(TierConfigError)
  })

  it('accepts the demo tier with the demo spaces bucket', () => {
    const config = loadAppConfig({
      APP_TIER: 'demo',
      DATABASE_URL: demoDatabaseUrl,
      DO_SPACES_BUCKET: 'sitelayer-blueprints-demo',
    })
    expect(config.spacesBucket).toBe('sitelayer-blueprints-demo')
  })

  it('accepts the demo tier with the local-storage fallback (no spaces bucket)', () => {
    const config = loadAppConfig({ APP_TIER: 'demo', DATABASE_URL: demoDatabaseUrl })
    expect(config.spacesBucket).toBeNull()
  })

  it('requires a read-only prod user for read-prod-ro', () => {
    expect(() =>
      loadAppConfig({
        APP_TIER: 'preview',
        DATABASE_URL: previewDatabaseUrl,
        FEATURE_FLAGS: 'read-prod-ro',
        DATABASE_URL_PROD_RO: prodDatabaseUrl,
      }),
    ).toThrow(TierConfigError)

    const config = loadAppConfig({
      APP_TIER: 'preview',
      DATABASE_URL: previewDatabaseUrl,
      FEATURE_FLAGS: 'read-prod-ro',
      DATABASE_URL_PROD_RO: prodReadOnlyUrl,
    })
    expect(config.databaseUrlProdRo).toBe(prodReadOnlyUrl)
  })
})

describe('postgresOptionsForTier', () => {
  it('adds tier options without discarding existing options', () => {
    expect(postgresOptionsForTier('preview')).toBe('-c app.tier=preview')
    expect(postgresOptionsForTier('prod', '-c statement_timeout=5000')).toBe(
      '-c statement_timeout=5000 -c app.tier=prod',
    )
  })
})

describe('local env loading', () => {
  it('parses shell-style env lines', () => {
    expect(parseEnvLine('export SENTRY_ORG="sandolabs"')).toEqual(['SENTRY_ORG', 'sandolabs'])
    expect(parseEnvLine("DEBUG_TRACE_TOKEN='abc123'")).toEqual(['DEBUG_TRACE_TOKEN', 'abc123'])
    expect(parseEnvLine('# comment')).toBeNull()
    expect(parseEnvLine('not valid')).toBeNull()
  })

  it('loads supported local env files from parent directories without overriding existing values', () => {
    const root = mkdtempSync(join(tmpdir(), 'sitelayer-config-'))
    const child = join(root, 'apps', 'api')
    mkdirSync(child, { recursive: true })
    writeFileSync(join(root, '.env'), 'SENTRY_ORG=from-env\nSENTRY_DSN=from-env\n')
    writeFileSync(join(root, '.env.sentry.local'), 'SENTRY_AUTH_TOKEN=token\nSENTRY_DSN=from-sentry\n')
    writeFileSync(join(root, '.env.qbo.local'), 'QBO_CLIENT_ID=qbo\n')

    const env: NodeJS.ProcessEnv = { SENTRY_DSN: 'existing' }
    loadLocalEnv(child, env)

    expect(env.SENTRY_ORG).toBe('from-env')
    expect(env.SENTRY_AUTH_TOKEN).toBe('token')
    expect(env.QBO_CLIENT_ID).toBe('qbo')
    expect(env.SENTRY_DSN).toBe('existing')
  })
})

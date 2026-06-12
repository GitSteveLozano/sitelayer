import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isProdPointedAtQboSandbox,
  loadAppConfig,
  loadLocalEnv,
  parseEnvLine,
  postgresOptionsForTier,
  resolveDatabasePoolSsl,
  resolveDatabaseSslConfig,
  TierConfigError,
  warnIfProdPointedAtQboSandbox,
} from './index.js'

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

describe('QBO sandbox-in-prod guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects prod tier pointed at the sandbox base URL', () => {
    expect(
      isProdPointedAtQboSandbox({
        APP_TIER: 'prod',
        QBO_BASE_URL: 'https://sandbox-quickbooks.api.intuit.com',
      }),
    ).toBe(true)
  })

  it('treats an unset QBO_BASE_URL with sandbox/blank QBO_ENVIRONMENT as sandbox', () => {
    expect(isProdPointedAtQboSandbox({ APP_TIER: 'prod' })).toBe(true)
    expect(isProdPointedAtQboSandbox({ APP_TIER: 'prod', QBO_ENVIRONMENT: 'sandbox' })).toBe(true)
  })

  it('does not flag prod against the production base URL', () => {
    expect(
      isProdPointedAtQboSandbox({
        APP_TIER: 'prod',
        QBO_BASE_URL: 'https://quickbooks.api.intuit.com',
        QBO_ENVIRONMENT: 'production',
      }),
    ).toBe(false)
  })

  it('does not flag non-prod tiers even on the sandbox URL', () => {
    expect(
      isProdPointedAtQboSandbox({
        APP_TIER: 'dev',
        QBO_BASE_URL: 'https://sandbox-quickbooks.api.intuit.com',
      }),
    ).toBe(false)
  })

  it('emits a loud console.warn when prod is wired to the sandbox', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fired = warnIfProdPointedAtQboSandbox({
      APP_TIER: 'prod',
      QBO_BASE_URL: 'https://sandbox-quickbooks.api.intuit.com',
    })
    expect(fired).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/APP_TIER=prod but QBO_BASE_URL points at the QBO SANDBOX/)
  })

  it('stays silent for a correctly configured prod', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fired = warnIfProdPointedAtQboSandbox({
      APP_TIER: 'prod',
      QBO_BASE_URL: 'https://quickbooks.api.intuit.com',
      QBO_ENVIRONMENT: 'production',
    })
    expect(fired).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fires the warning through loadAppConfig at boot for a prod+sandbox config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadAppConfig({
      APP_TIER: 'prod',
      DATABASE_URL: prodDatabaseUrl,
      DO_SPACES_BUCKET: 'sitelayer-blueprints-prod',
      QBO_BASE_URL: 'https://sandbox-quickbooks.api.intuit.com',
    })
    expect(warn.mock.calls.some((call) => /QBO SANDBOX/.test(String(call[0])))).toBe(true)
  })
})

describe('resolveDatabaseSslConfig', () => {
  it('prefers a CA bundle and verifies the cert', () => {
    const ssl = resolveDatabaseSslConfig({
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    })
    expect(ssl).toEqual({
      mode: 'verify-ca',
      ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    })
  })

  it('un-escapes \\n in a single-line CA bundle', () => {
    const ssl = resolveDatabaseSslConfig({
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
    })
    expect(ssl.mode).toBe('verify-ca')
    if (ssl.mode === 'verify-ca') {
      expect(ssl.ca).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')
    }
  })

  it('falls back to no-verify when the reject flag is false and no CA is set', () => {
    expect(resolveDatabaseSslConfig({ DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' })).toEqual({
      mode: 'no-verify',
      rejectUnauthorized: false,
    })
  })

  it('prefers the CA bundle even when the reject flag is false', () => {
    const ssl = resolveDatabaseSslConfig({
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    })
    expect(ssl.mode).toBe('verify-ca')
  })

  it('defaults to rejectUnauthorized:true', () => {
    expect(resolveDatabaseSslConfig({})).toEqual({ mode: 'reject-unauthorized', rejectUnauthorized: true })
  })
})

describe('resolveDatabasePoolSsl', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
  const TLS_URL = 'postgres://app:pw@db.example.com:25060/sitelayer_prod?sslmode=require'
  const PLAIN_URL = 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

  it('attaches verified TLS (ca + rejectUnauthorized:true) and strips sslmode when DATABASE_CA_CERT is set', () => {
    const result = resolveDatabasePoolSsl(TLS_URL, { env: { DATABASE_CA_CERT: CA } })
    expect(result.ssl).toEqual({ ca: CA, rejectUnauthorized: true })
    expect(result.connectionString).not.toContain('sslmode')
  })

  it('CA bundle wins over the no-verify flag AND over an explicit rejectUnauthorized:false option', () => {
    const result = resolveDatabasePoolSsl(TLS_URL, {
      env: { DATABASE_CA_CERT: CA, DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' },
      rejectUnauthorized: false,
    })
    expect(result.ssl).toEqual({ ca: CA, rejectUnauthorized: true })
  })

  it('keeps the legacy no-verify escape hatch when the env flag is false and no CA is set', () => {
    const result = resolveDatabasePoolSsl(TLS_URL, { env: { DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' } })
    expect(result.ssl).toEqual({ rejectUnauthorized: false })
    expect(result.connectionString).not.toContain('sslmode')
  })

  it('honors the caller-resolved rejectUnauthorized:false option (worker contract)', () => {
    const result = resolveDatabasePoolSsl(TLS_URL, { env: {}, rejectUnauthorized: false })
    expect(result.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('an explicit rejectUnauthorized:true option passes the URL through untouched', () => {
    const result = resolveDatabasePoolSsl(TLS_URL, {
      env: { DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' },
      rejectUnauthorized: true,
    })
    expect(result).toEqual({ connectionString: TLS_URL })
  })

  it('default env passes the URL through unchanged (pg owns sslmode)', () => {
    expect(resolveDatabasePoolSsl(TLS_URL, { env: {} })).toEqual({ connectionString: TLS_URL })
  })

  it('never touches a URL without sslmode (local docker Postgres), even with a CA set', () => {
    expect(resolveDatabasePoolSsl(PLAIN_URL, { env: { DATABASE_CA_CERT: CA } })).toEqual({
      connectionString: PLAIN_URL,
    })
  })

  it('never touches a URL with sslmode=disable', () => {
    const url = `${PLAIN_URL}?sslmode=disable`
    expect(resolveDatabasePoolSsl(url, { env: { DATABASE_CA_CERT: CA } })).toEqual({ connectionString: url })
  })

  it('passes an unparseable connection string through unchanged', () => {
    expect(resolveDatabasePoolSsl('not a url', { env: { DATABASE_CA_CERT: CA } })).toEqual({
      connectionString: 'not a url',
    })
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

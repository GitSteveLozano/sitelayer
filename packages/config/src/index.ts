import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type AppTier = 'local' | 'dev' | 'preview' | 'demo' | 'prod'

export const KNOWN_FEATURE_FLAGS = ['read-prod-ro', 'qbo-live', 'pdf-ocr-experimental'] as const

export const LOCAL_ENV_FILES = ['.env', '.env.local', '.env.sentry.local', '.env.qbo.local'] as const

export type KnownFeatureFlag = (typeof KNOWN_FEATURE_FLAGS)[number]

export type AppConfig = {
  tier: AppTier
  flags: Set<string>
  databaseUrl: string
  databaseUrlProdRo: string | null
  spacesBucket: string | null
  ribbon: { label: string; tone: 'info' | 'warn' | 'danger' | 'demo' } | null
}

export class TierConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TierConfigError'
  }
}

function candidateDirs(startDir: string): string[] {
  const dirs: string[] = []
  let current = resolve(startDir)
  while (!dirs.includes(current)) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

export function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
  const separatorIndex = normalized.indexOf('=')
  if (separatorIndex <= 0) return null

  const key = normalized.slice(0, separatorIndex).trim()
  let value = normalized.slice(separatorIndex + 1).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1)
  }

  return [key, value]
}

export function loadLocalEnv(startDir = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const originalKeys = new Set(Object.keys(env))
  const loadedFiles = new Set<string>()

  for (const dir of candidateDirs(startDir)) {
    for (const fileName of LOCAL_ENV_FILES) {
      const filePath = join(dir, fileName)
      if (loadedFiles.has(filePath) || !existsSync(filePath)) continue
      loadedFiles.add(filePath)

      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        const parsed = parseEnvLine(line)
        if (!parsed) continue
        const [key, value] = parsed
        if (originalKeys.has(key)) continue
        env[key] = value
      }
    }
  }
}

function parseTier(raw: string | undefined, nodeEnv = process.env.NODE_ENV): AppTier {
  if (!raw || raw.trim() === '') {
    if (nodeEnv === 'production') {
      throw new TierConfigError(
        'APP_TIER must be set explicitly when NODE_ENV=production (local|dev|preview|demo|prod)',
      )
    }
    console.warn('[tier] APP_TIER not set, defaulting to "local"')
    return 'local'
  }
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'local' ||
    normalized === 'dev' ||
    normalized === 'preview' ||
    normalized === 'demo' ||
    normalized === 'prod'
  ) {
    return normalized
  }
  throw new TierConfigError(`APP_TIER must be one of local|dev|preview|demo|prod (got "${raw}")`)
}

function parseFlags(raw: string | undefined): Set<string> {
  const flags = new Set<string>()
  if (!raw) return flags
  for (const token of raw.split(',')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    if (!KNOWN_FEATURE_FLAGS.includes(trimmed as KnownFeatureFlag)) {
      console.warn(`[tier] ignoring unknown feature flag "${trimmed}"`)
      continue
    }
    flags.add(trimmed)
  }
  return flags
}

export function extractDatabaseName(connectionString: string): string | null {
  try {
    const url = new URL(connectionString)
    const name = url.pathname.replace(/^\//, '')
    return name || null
  } catch {
    return null
  }
}

function extractDatabaseHost(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname
  } catch {
    return null
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db'])

function assertDatabaseMatchesTier(tier: AppTier, databaseUrl: string) {
  const dbName = extractDatabaseName(databaseUrl) ?? ''
  const host = extractDatabaseHost(databaseUrl) ?? ''
  const isLocalHost = LOCAL_HOSTS.has(host)

  if (tier === 'prod') {
    if (!/sitelayer_prod\b/.test(dbName)) {
      throw new TierConfigError(
        `APP_TIER=prod but DATABASE_URL database name is "${dbName}" (expected to contain "sitelayer_prod")`,
      )
    }
    return
  }

  if (/sitelayer_prod\b/.test(dbName) && !dbName.endsWith('_ro')) {
    throw new TierConfigError(
      `APP_TIER=${tier} but DATABASE_URL points at prod database "${dbName}". Refusing to start.`,
    )
  }

  if (tier === 'preview' && !/sitelayer_preview\b/.test(dbName) && !isLocalHost) {
    throw new TierConfigError(
      `APP_TIER=preview but DATABASE_URL database name is "${dbName}" (expected "sitelayer_preview")`,
    )
  }

  if (tier === 'dev' && !/sitelayer_dev\b/.test(dbName) && !isLocalHost) {
    throw new TierConfigError(`APP_TIER=dev but DATABASE_URL database name is "${dbName}" (expected "sitelayer_dev")`)
  }

  if (tier === 'demo' && !/sitelayer_demo\b/.test(dbName) && !isLocalHost) {
    throw new TierConfigError(`APP_TIER=demo but DATABASE_URL database name is "${dbName}" (expected "sitelayer_demo")`)
  }
}

function assertSpacesMatchesTier(tier: AppTier, bucket: string | null) {
  if (!bucket) return
  if (tier === 'prod') {
    if (!/(-prod$|^sitelayer-blueprints$)/.test(bucket)) {
      throw new TierConfigError(
        `APP_TIER=prod but DO_SPACES_BUCKET="${bucket}" (expected suffix "-prod" or legacy "sitelayer-blueprints")`,
      )
    }
    return
  }
  if (/(^|-)prod(-|$)/.test(bucket) && bucket !== 'sitelayer-blueprints') {
    throw new TierConfigError(
      `APP_TIER=${tier} but DO_SPACES_BUCKET="${bucket}" looks like a prod bucket. Refusing to start.`,
    )
  }
}

function ribbonForTier(tier: AppTier): AppConfig['ribbon'] {
  switch (tier) {
    case 'prod':
      return null
    case 'preview':
      return { label: 'PREVIEW - isolated data', tone: 'info' }
    case 'demo':
      return { label: 'DEMO - sample data, public showcase', tone: 'demo' }
    case 'dev':
      return { label: 'DEV DATA - not real customers', tone: 'warn' }
    case 'local':
      return { label: 'LOCAL - your laptop only', tone: 'warn' }
  }
}

/**
 * Detect the "prod app pointed at the QBO sandbox" footgun.
 *
 * `QBO_BASE_URL` defaults to the sandbox base in several worker push paths and
 * in the production env manifest. If APP_TIER=prod boots with a sandbox base
 * URL, every QBO live-push silently targets the sandbox company — a pilot
 * blocker that produces no errors, just data that never reaches the customer's
 * real QuickBooks. This is intentionally a string match on `sandbox` so it
 * also catches `sandbox-quickbooks.api.intuit.com` and any sandbox host
 * variant.
 */
export function isProdPointedAtQboSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const tier = (env.APP_TIER ?? '').trim().toLowerCase()
  if (tier !== 'prod') return false
  const baseUrl = (env.QBO_BASE_URL ?? '').trim().toLowerCase()
  if (baseUrl) return baseUrl.includes('sandbox')
  // No explicit QBO_BASE_URL: fall back to QBO_ENVIRONMENT, which defaults to
  // 'sandbox' everywhere, so an unset environment is still the sandbox base.
  const qboEnv = (env.QBO_ENVIRONMENT ?? 'sandbox').trim().toLowerCase()
  return qboEnv !== 'production'
}

/**
 * Emit a loud, single boot-time warning when APP_TIER=prod is configured
 * against the QBO sandbox base URL. Returns true if the warning fired so
 * callers/tests can assert on it. Uses console.warn (not throw) because a
 * legitimate prod deployment may run with QBO live-push flags off while
 * sandbox creds are still wired — but the operator must SEE it.
 */
export function warnIfProdPointedAtQboSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isProdPointedAtQboSandbox(env)) return false
  const baseUrl = (env.QBO_BASE_URL ?? '').trim() || `(unset; QBO_ENVIRONMENT=${env.QBO_ENVIRONMENT ?? 'sandbox'})`
  console.warn(
    '************************************************************************\n' +
      '[qbo] *** WARNING: APP_TIER=prod but QBO_BASE_URL points at the QBO SANDBOX ***\n' +
      `[qbo] QBO_BASE_URL=${baseUrl}\n` +
      '[qbo] Every live QBO push will target the SANDBOX company, not the\n' +
      "[qbo] customer's real QuickBooks. Set QBO_BASE_URL to\n" +
      '[qbo] https://quickbooks.api.intuit.com (and QBO_ENVIRONMENT=production)\n' +
      '[qbo] before enabling any QBO_LIVE_* flag.\n' +
      '************************************************************************',
  )
  return true
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tier = parseTier(env.APP_TIER, env.NODE_ENV)
  const flags = parseFlags(env.FEATURE_FLAGS)
  const databaseUrl = env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
  const spacesBucket = env.DO_SPACES_BUCKET ?? null

  assertDatabaseMatchesTier(tier, databaseUrl)
  assertSpacesMatchesTier(tier, spacesBucket)
  warnIfProdPointedAtQboSandbox(env)

  let databaseUrlProdRo: string | null = null
  if (flags.has('read-prod-ro')) {
    if (tier === 'prod') {
      throw new TierConfigError('FEATURE_FLAGS cannot include "read-prod-ro" when APP_TIER=prod')
    }
    const url = env.DATABASE_URL_PROD_RO
    if (!url) {
      throw new TierConfigError('FEATURE_FLAGS contains "read-prod-ro" but DATABASE_URL_PROD_RO is not set')
    }
    const dbName = extractDatabaseName(url) ?? ''
    if (!/sitelayer_prod\b/.test(dbName)) {
      throw new TierConfigError(`DATABASE_URL_PROD_RO must point at the prod database (got "${dbName}")`)
    }
    try {
      const parsed = new URL(url)
      if (!/_ro$|readonly/i.test(parsed.username)) {
        throw new TierConfigError(
          `DATABASE_URL_PROD_RO user "${parsed.username}" must be a read-only role (suffix "_ro" or contain "readonly")`,
        )
      }
    } catch (err) {
      if (err instanceof TierConfigError) throw err
      throw new TierConfigError('DATABASE_URL_PROD_RO is not a valid URL')
    }
    databaseUrlProdRo = url
  }

  return {
    tier,
    flags,
    databaseUrl,
    databaseUrlProdRo,
    spacesBucket,
    ribbon: ribbonForTier(tier),
  }
}

/**
 * Resolved Postgres TLS config for the pg client `ssl` option.
 *
 * - `disabled`: no TLS handling injected (callers pass the connection string
 *   through unchanged — e.g. local docker Postgres with no sslmode).
 * - otherwise the shape maps directly onto pg's `ssl` PoolConfig field:
 *   `{ ca, rejectUnauthorized }`.
 */
export type DatabaseSslConfig =
  | { mode: 'disabled' }
  | { mode: 'verify-ca'; ca: string; rejectUnauthorized: true }
  | { mode: 'reject-unauthorized'; rejectUnauthorized: true }
  | { mode: 'no-verify'; rejectUnauthorized: false }

/**
 * Build the pg `ssl` config from env, preferring a CA bundle over the blunt
 * `rejectUnauthorized:false` escape hatch.
 *
 * Precedence:
 *   1. `DATABASE_CA_CERT` set  -> verify the managed-PG server cert against it
 *      (`ssl: { ca, rejectUnauthorized: true }`). This is the secure path and
 *      means `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is no longer required.
 *   2. `DATABASE_SSL_REJECT_UNAUTHORIZED=false` (and no CA) -> legacy
 *      no-verify TLS (`ssl: { rejectUnauthorized: false }`).
 *   3. default -> `rejectUnauthorized: true` (verify against the system trust
 *      store; the caller decides whether to attach `ssl` at all based on
 *      sslmode in the connection string).
 *
 * NOTE: the pg `Pool` is currently constructed in apps/api/src/server.ts
 * (`getPoolConfig`) and apps/worker/src/worker.ts, which read
 * `DATABASE_SSL_REJECT_UNAUTHORIZED` directly. To finish wiring the CA-bundle
 * path, those builders should call `resolveDatabaseSslConfig(process.env)` and
 * spread the resulting `{ ca, rejectUnauthorized }` into the pg `ssl` option
 * instead of hand-rolling `{ rejectUnauthorized: false }`.
 * TODO(pool-wiring): replace the inline ssl construction in server.ts /
 * worker.ts with this helper (those files are owned by other agents in the
 * current split; this helper + manifest + docs + .env.example are the
 * config-side contract).
 */
export function resolveDatabaseSslConfig(env: NodeJS.ProcessEnv = process.env): DatabaseSslConfig {
  const ca = env.DATABASE_CA_CERT?.trim()
  if (ca) {
    // CA cert may arrive with escaped newlines (single-line dotenv value).
    const normalizedCa = ca.replace(/\\n/g, '\n')
    return { mode: 'verify-ca', ca: normalizedCa, rejectUnauthorized: true }
  }
  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
    return { mode: 'no-verify', rejectUnauthorized: false }
  }
  return { mode: 'reject-unauthorized', rejectUnauthorized: true }
}

export function postgresOptionsForTier(tier: AppTier, currentOptions?: string): string {
  const tierOption = `-c app.tier=${tier}`
  const trimmed = currentOptions?.trim()
  return trimmed ? `${trimmed} ${tierOption}` : tierOption
}

export function logAppConfigBanner(config: AppConfig) {
  const bucket = config.spacesBucket ?? '(none)'
  const dbName = extractDatabaseName(config.databaseUrl) ?? '(unknown)'
  const flags = config.flags.size > 0 ? Array.from(config.flags).join(',') : '(none)'
  console.log(
    `[tier] APP_TIER=${config.tier} db=${dbName} spaces=${bucket} flags=${flags}${config.databaseUrlProdRo ? ' +prod-ro' : ''}`,
  )
}

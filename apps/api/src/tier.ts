export type AppTier = 'local' | 'dev' | 'preview' | 'prod'

export const KNOWN_FEATURE_FLAGS = [
  'read-prod-ro',
  'qbo-live',
  'pdf-ocr-experimental',
] as const

export type KnownFeatureFlag = (typeof KNOWN_FEATURE_FLAGS)[number]

export type AppConfig = {
  tier: AppTier
  flags: Set<string>
  databaseUrl: string
  databaseUrlProdRo: string | null
  spacesBucket: string | null
  ribbon: { label: string; tone: 'info' | 'warn' | 'danger' } | null
}

export class TierConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TierConfigError'
  }
}

function parseTier(raw: string | undefined, nodeEnv = process.env.NODE_ENV): AppTier {
  if (!raw || raw.trim() === '') {
    if (nodeEnv === 'production') {
      throw new TierConfigError(
        'APP_TIER must be set explicitly when NODE_ENV=production (local|dev|preview|prod)',
      )
    }
    console.warn('[tier] APP_TIER not set, defaulting to "local"')
    return 'local'
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'local' || normalized === 'dev' || normalized === 'preview' || normalized === 'prod') {
    return normalized
  }
  throw new TierConfigError(`APP_TIER must be one of local|dev|preview|prod (got "${raw}")`)
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

function extractDatabaseName(connectionString: string): string | null {
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

  // prod is the strictest — must be the prod DB
  if (tier === 'prod') {
    if (!/sitelayer_prod\b/.test(dbName)) {
      throw new TierConfigError(
        `APP_TIER=prod but DATABASE_URL database name is "${dbName}" (expected to contain "sitelayer_prod")`,
      )
    }
    return
  }

  // non-prod must never point at the prod DB
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
    throw new TierConfigError(
      `APP_TIER=dev but DATABASE_URL database name is "${dbName}" (expected "sitelayer_dev")`,
    )
  }

  // local permits anything localhost-like; no assertion needed
}

function assertSpacesMatchesTier(tier: AppTier, bucket: string | null) {
  if (!bucket) return // Spaces not configured yet — skip
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
      return { label: 'PREVIEW — isolated data', tone: 'info' }
    case 'dev':
      return { label: 'DEV DATA — not real customers', tone: 'warn' }
    case 'local':
      return { label: 'LOCAL — your laptop only', tone: 'warn' }
  }
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tier = parseTier(env.APP_TIER, env.NODE_ENV)
  const flags = parseFlags(env.FEATURE_FLAGS)
  const databaseUrl =
    env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
  const spacesBucket = env.DO_SPACES_BUCKET ?? null

  assertDatabaseMatchesTier(tier, databaseUrl)
  assertSpacesMatchesTier(tier, spacesBucket)

  let databaseUrlProdRo: string | null = null
  if (flags.has('read-prod-ro')) {
    if (tier === 'prod') {
      throw new TierConfigError('FEATURE_FLAGS cannot include "read-prod-ro" when APP_TIER=prod')
    }
    const url = env.DATABASE_URL_PROD_RO
    if (!url) {
      throw new TierConfigError(
        'FEATURE_FLAGS contains "read-prod-ro" but DATABASE_URL_PROD_RO is not set',
      )
    }
    const dbName = extractDatabaseName(url) ?? ''
    if (!/sitelayer_prod\b/.test(dbName)) {
      throw new TierConfigError(
        `DATABASE_URL_PROD_RO must point at the prod database (got "${dbName}")`,
      )
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

export function logAppConfigBanner(config: AppConfig) {
  const bucket = config.spacesBucket ?? '(none)'
  const dbName = extractDatabaseName(config.databaseUrl) ?? '(unknown)'
  const flags = config.flags.size > 0 ? Array.from(config.flags).join(',') : '(none)'
  console.log(
    `[tier] APP_TIER=${config.tier} db=${dbName} spaces=${bucket} flags=${flags}${config.databaseUrlProdRo ? ' +prod-ro' : ''}`,
  )
}

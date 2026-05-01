export type EnvValidationIssue = {
  var: string
  kind: 'missing' | 'sentinel_default'
  message: string
  value?: string
}

export type EnvValidationResult = {
  warnings: EnvValidationIssue[]
  errors: EnvValidationIssue[]
}

type EnvSpec = {
  name: string
  why: string
  sentinels?: readonly string[]
}

type LoggerLike =
  | { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
  | ((...args: unknown[]) => void)

export const SENTINELS = new Set(['127.0.0.1', 'localhost', 'unknown', '', 'PLACEHOLDER', 'CHANGEME'])

export const REQUIRED_ENV_VARS: readonly EnvSpec[] = [
  { name: 'DATABASE_URL', why: 'API must connect to the operational Postgres database.' },
  { name: 'CLERK_JWT_KEY', why: 'JWT auth must verify Clerk sessions.' },
  { name: 'CLERK_ISSUER', why: 'JWT auth must reject tokens from the wrong Clerk issuer.' },
  { name: 'CLERK_WEBHOOK_SECRET', why: 'Clerk webhook events must be signature-verified.' },
  { name: 'DO_SPACES_KEY', why: 'Blueprint uploads need DigitalOcean Spaces credentials.' },
  { name: 'DO_SPACES_SECRET', why: 'Blueprint uploads need DigitalOcean Spaces credentials.' },
  { name: 'DO_SPACES_BUCKET', why: 'Blueprint uploads need the target DigitalOcean Spaces bucket.' },
  { name: 'SENTRY_DSN', why: 'Operational errors must reach Sentry.' },
]

export const REQUIRED_PROD_ENV_VARS: readonly EnvSpec[] = [
  { name: 'QBO_CLIENT_ID', why: 'Production QBO OAuth must not use the demo fallback.', sentinels: ['demo'] },
  { name: 'QBO_CLIENT_SECRET', why: 'Production QBO OAuth must not use the demo fallback.', sentinels: ['demo'] },
  { name: 'QBO_REDIRECT_URI', why: 'Production QBO OAuth needs the public callback URL.' },
  { name: 'QBO_SUCCESS_REDIRECT_URI', why: 'Production QBO OAuth needs the public UI redirect URL.' },
]

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.APP_TIER === 'prod'
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function sentinelFor(value: string, extraSentinels: readonly string[] = []): string | null {
  const normalized = value.toLowerCase()
  for (const sentinel of [...SENTINELS, ...extraSentinels]) {
    if (!sentinel) continue
    const candidate = sentinel.toLowerCase()
    if (normalized === candidate) return sentinel
    if (['localhost', '127.0.0.1', 'placeholder', 'changeme'].includes(candidate) && normalized.includes(candidate)) {
      return sentinel
    }
  }
  return null
}

export function inspectEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const warnings: EnvValidationIssue[] = []
  const errors: EnvValidationIssue[] = []
  const specs = isProduction(env) ? [...REQUIRED_ENV_VARS, ...REQUIRED_PROD_ENV_VARS] : REQUIRED_ENV_VARS

  for (const spec of specs) {
    const value = readEnvValue(env, spec.name)
    if (!value) {
      errors.push({ var: spec.name, kind: 'missing', message: `${spec.name} is unset. ${spec.why}` })
      continue
    }

    const sentinel = sentinelFor(value, spec.sentinels)
    if (sentinel) {
      warnings.push({
        var: spec.name,
        value,
        kind: 'sentinel_default',
        message: `${spec.name}="${value}" matches sentinel "${sentinel}". ${spec.why}`,
      })
    }
  }

  return { warnings, errors }
}

function logIssue(logger: LoggerLike, level: 'warn' | 'error', issue: EnvValidationIssue): void {
  if (typeof logger === 'function') {
    logger(level, issue.message)
    return
  }
  const log = logger[level]
  if (typeof log === 'function') {
    log.call(logger, { env_var: issue.var, value: issue.value, kind: issue.kind, msg: issue.message })
  }
}

export function validateRequiredEnvVars(
  logger: LoggerLike = console,
  env: NodeJS.ProcessEnv = process.env,
): EnvValidationResult {
  const result = inspectEnv(env)
  for (const warning of result.warnings) logIssue(logger, 'warn', warning)
  for (const error of result.errors) logIssue(logger, 'error', error)

  if (result.errors.length > 0 && env.SITELAYER_ENV_ENFORCE === '1') {
    const summary = result.errors.map((error) => error.var).join(', ')
    throw new Error(
      `Sitelayer env validation failed: missing required config: ${summary}. ` +
        'Set the variable(s) or set SITELAYER_ENV_ENFORCE=0 to bypass phase-2 enforcement.',
    )
  }

  return result
}

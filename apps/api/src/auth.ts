import type { IncomingMessage } from 'node:http'
import { createPublicKey, createVerify } from 'node:crypto'

export type Identity = {
  /** The EFFECTIVE/subject user — every data-scoping consumer reads this. Under
   *  impersonation this is the impersonated user, not the actor. */
  userId: string
  source: 'clerk' | 'internal' | 'header' | 'default'
  role?: string
  /** The acting user when this request is on behalf of someone else (the dev
   *  act-as caller, or the prod impersonator from a Clerk `act` claim). Audit
   *  writes stamp this; data scoping never does. Absent for normal self-auth. */
  actorUserId?: string
  /** How `userId` was assumed. 'self' (or absent) = normal; 'act_as' = dev/demo
   *  RoleSwitcher override; 'impersonate' = prod Clerk actor-token session. */
  mode?: 'self' | 'act_as' | 'impersonate'
}

/**
 * Dev-only identity override. When `x-sitelayer-act-as: <user_id>` is
 * present on a request AND the running tier is not `prod`, the returned
 * user id wins over every other resolution path (Clerk JWT,
 * `x-sitelayer-user-id`, `ACTIVE_USER_ID`). This is the auth-bypass
 * primitive the RoleSwitcher panel in `apps/web` writes to so QA can flip
 * between admin/foreman/office/member/bookkeeper without standing up a
 * full Clerk org.
 *
 * In prod the header is treated as a hostile signal: ignored entirely
 * and logged via the supplied `warn` callback so operators can see if a
 * misconfigured client is leaking dev headers into production traffic.
 * Never returns a value when `tier === 'prod'`.
 */
export function resolveActAsOverride(
  req: IncomingMessage | undefined,
  tier: string,
  warn: (msg: string, ctx: Record<string, unknown>) => void = defaultWarn,
): string | null {
  const headerValue = readHeader(req, 'x-sitelayer-act-as')
  if (!headerValue) return null
  if (tier === 'prod') {
    warn('[auth] ignoring x-sitelayer-act-as in prod', { tier, header_value: headerValue })
    return null
  }
  return headerValue
}

function defaultWarn(msg: string, ctx: Record<string, unknown>): void {
  console.warn(msg, ctx)
}

export type AuthConfig = {
  clerkJwtKey?: string | null
  clerkIssuer?: string | null
  internalAuthToken?: string | null
  defaultUserId: string
  allowHeaderFallback: boolean
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const tier = env.APP_TIER ?? 'local'
  // Accept a single-line PEM with literal `\n` escapes — required so the key
  // survives env-file transports that can't carry multi-line values (the
  // preview/demo deploy passes envs via `docker compose --env-file`). A
  // real-newline PEM has no `\n` literals, so this is a no-op for it (prod-safe).
  const clerkJwtKey = env.CLERK_JWT_KEY?.trim().replace(/\\n/g, '\n') || null
  const internalAuthToken = env.INTERNAL_AUTH_TOKEN?.trim() || null
  const authConfigured = Boolean(clerkJwtKey || internalAuthToken)
  // Fail closed on EVERY tier once an auth provider is configured. The header
  // fallback (x-sitelayer-user-id / ACTIVE_USER_ID default user) is a
  // no-real-auth convenience for a local box that has no Clerk key / internal
  // token wired — NOT a non-prod-wide default. Previously the unset default was
  // `!authConfigured || tier !== 'prod'`, so a `dev`/`preview` tier that DID
  // have a real Clerk key still defaulted the fallback ON — turning the public
  // dev copy into a fully unauthenticated, header-impersonatable mirror of the
  // app. The corrected default is `!authConfigured`: a tier with a (even
  // shared) Clerk session requirement now demands a real session by default,
  // while a key-less local box keeps the RoleSwitcher QA path. `prod` is
  // unchanged (it always has auth configured, so the default was already off),
  // and an explicit `AUTH_ALLOW_HEADER_FALLBACK=1` still works where it's
  // deliberately wanted (and is still refused in prod without break-glass).
  const allowHeaderFallback = env.AUTH_ALLOW_HEADER_FALLBACK
    ? env.AUTH_ALLOW_HEADER_FALLBACK === '1' || env.AUTH_ALLOW_HEADER_FALLBACK === 'true'
    : !authConfigured
  const breakGlassHeaderFallback =
    env.AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS === '1' || env.AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS === 'true'

  if (tier === 'prod' && !authConfigured) {
    throw new AuthConfigError('APP_TIER=prod requires CLERK_JWT_KEY or INTERNAL_AUTH_TOKEN')
  }
  if (tier === 'prod' && allowHeaderFallback && !breakGlassHeaderFallback) {
    throw new AuthConfigError(
      'APP_TIER=prod refuses AUTH_ALLOW_HEADER_FALLBACK without AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS=1',
    )
  }

  return {
    clerkJwtKey,
    clerkIssuer: env.CLERK_ISSUER?.trim() || null,
    internalAuthToken,
    defaultUserId: env.ACTIVE_USER_ID?.trim() || 'demo-user',
    allowHeaderFallback,
  }
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
}

function verifyClerkJwt(token: string, config: AuthConfig): Identity {
  if (!config.clerkJwtKey) {
    throw new AuthError(401, 'clerk verification unavailable')
  }
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError(401, 'malformed token')
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string]
  const header = decodeJwtSegment(headerSeg)
  const alg = String(header.alg ?? '')
  if (alg !== 'RS256') throw new AuthError(401, `unsupported alg ${alg}`)

  const signingInput = `${headerSeg}.${payloadSeg}`
  const signature = Buffer.from(
    signatureSeg
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(signatureSeg.length / 4) * 4, '='),
    'base64',
  )

  let publicKey: ReturnType<typeof createPublicKey>
  try {
    publicKey = createPublicKey(config.clerkJwtKey)
  } catch {
    throw new AuthError(500, 'invalid CLERK_JWT_KEY')
  }
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingInput)
  verifier.end()
  if (!verifier.verify(publicKey, signature)) {
    throw new AuthError(401, 'invalid signature')
  }

  const payload = decodeJwtSegment(payloadSeg)
  const now = Math.floor(Date.now() / 1000)
  // `exp` is mandatory. Clerk session tokens are always short-lived and carry
  // it; treating it as optional meant a token without an `exp` claim would be
  // accepted forever. Fail closed if it's missing or in the past.
  if (typeof payload.exp !== 'number') {
    throw new AuthError(401, 'token missing exp')
  }
  if (payload.exp < now) {
    throw new AuthError(401, 'token expired')
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) {
    throw new AuthError(401, 'token not yet valid')
  }
  if (config.clerkIssuer && payload.iss !== config.clerkIssuer) {
    throw new AuthError(401, 'unexpected issuer')
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : null
  if (!sub) throw new AuthError(401, 'token missing sub')
  // Clerk actor-token sessions carry an `act` claim identifying the impersonator
  // (the real admin). `sub` stays the impersonated subject so data scoping is
  // unchanged; we surface the actor so the audit layer can stamp impersonated_by
  // and the SPA can show the "viewing as X" banner. Accept both the object form
  // ({ sub }) and a bare string, fail-open to normal self-auth when absent.
  const actClaim = payload.act
  let actorUserId: string | undefined
  if (actClaim && typeof actClaim === 'object' && typeof (actClaim as { sub?: unknown }).sub === 'string') {
    actorUserId = (actClaim as { sub: string }).sub
  } else if (typeof actClaim === 'string' && actClaim.trim()) {
    actorUserId = actClaim.trim()
  }
  if (actorUserId) {
    return { userId: sub, source: 'clerk', actorUserId, mode: 'impersonate' }
  }
  return { userId: sub, source: 'clerk' }
}

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function readHeader(req: IncomingMessage | undefined, key: string): string | null {
  const value = req?.headers[key]
  if (Array.isArray(value)) return value[0]?.trim() || null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function resolveIdentity(req: IncomingMessage, config: AuthConfig): Identity {
  const bearer = readBearer(req)

  if (bearer && config.internalAuthToken && bearer === config.internalAuthToken) {
    const headerUser = readHeader(req, 'x-sitelayer-user-id')
    return { userId: headerUser ?? 'service', source: 'internal' }
  }

  if (bearer && config.clerkJwtKey) {
    return verifyClerkJwt(bearer, config)
  }

  if (config.clerkJwtKey && !config.allowHeaderFallback) {
    if (bearer) {
      throw new AuthError(401, 'token rejected')
    }
    throw new AuthError(401, 'authentication required')
  }

  if (config.allowHeaderFallback) {
    const headerUser = readHeader(req, 'x-sitelayer-user-id')
    if (headerUser) return { userId: headerUser, source: 'header' }
    return { userId: config.defaultUserId, source: 'default' }
  }

  throw new AuthError(401, 'authentication required')
}

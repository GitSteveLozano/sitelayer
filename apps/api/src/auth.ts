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
  /**
   * Allowlist of authorized parties for Clerk's `azp` claim (and, when a JWT
   * template adds one, the `aud` claim). Parsed from the comma-separated
   * `CLERK_AUTHORIZED_PARTIES` env var — typically the SPA origins that are
   * allowed to mint sessions against this API (e.g.
   * `https://sitelayer.sandolab.xyz`). When null/empty, azp/aud are NOT
   * enforced (legacy deployments without the var keep working; a loud
   * startup warning fires instead).
   */
  clerkAuthorizedParties?: readonly string[] | null
  internalAuthToken?: string | null
  defaultUserId: string
  allowHeaderFallback: boolean
  /**
   * Whether the first authenticated user hitting a company slug with ZERO
   * memberships may self-claim `admin` (apps/api/src/auto-onboard.ts). This is
   * a convenience for fresh installs where the Clerk membership-mirroring
   * webhook isn't wired, but it's a privilege-escalation footgun: the slug is
   * attacker-controllable (`x-sitelayer-company-slug`), so any flow that leaves
   * a company memberless (admin removal, manual row delete, scenario seed)
   * re-opens an admin self-claim. DEFAULT OFF in prod (tier==='prod' ⇒ off
   * unless AUTH_ALLOW_FIRST_USER_ADMIN is explicitly enabled); default ON in
   * dev/preview/demo/local so local onboarding flows keep working.
   */
  allowFirstUserAdmin: boolean
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

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string, ctx: Record<string, unknown>) => void = defaultWarn,
): AuthConfig {
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

  // First-user admin self-claim (auto-onboard). DEFAULT OFF in prod, ON in
  // every non-prod tier so local/dev/preview/demo onboarding keeps working.
  // An explicit AUTH_ALLOW_FIRST_USER_ADMIN=1/0 overrides the default on any
  // tier (so prod CAN opt in for a deliberate first-onboard window, and a
  // non-prod box CAN opt out).
  const allowFirstUserAdmin =
    env.AUTH_ALLOW_FIRST_USER_ADMIN !== undefined && env.AUTH_ALLOW_FIRST_USER_ADMIN !== ''
      ? env.AUTH_ALLOW_FIRST_USER_ADMIN === '1' || env.AUTH_ALLOW_FIRST_USER_ADMIN === 'true'
      : tier !== 'prod'

  if (tier === 'prod' && !authConfigured) {
    throw new AuthConfigError('APP_TIER=prod requires CLERK_JWT_KEY or INTERNAL_AUTH_TOKEN')
  }
  if (tier === 'prod' && allowHeaderFallback && !breakGlassHeaderFallback) {
    throw new AuthConfigError(
      'APP_TIER=prod refuses AUTH_ALLOW_HEADER_FALLBACK without AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS=1',
    )
  }

  const clerkIssuer = env.CLERK_ISSUER?.trim() || null
  // Comma-separated allowlist of authorized parties (azp / aud). Empty
  // entries are dropped so a trailing comma can't allowlist "".
  const clerkAuthorizedParties =
    env.CLERK_AUTHORIZED_PARTIES?.split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0) ?? []

  // Issuer is MANDATORY in prod once Clerk verification is configured: a
  // signature-valid token minted by a DIFFERENT Clerk instance (same alg,
  // attacker-controlled key would still fail the signature — but a leaked /
  // reused PEM across instances would not) must never be accepted because
  // the issuer check was silently skipped. The prod env manifest
  // (ops/env/production.env.json) already marks CLERK_ISSUER required, so
  // this fail-closed startup error only fires on a genuinely misrendered
  // prod env. Non-prod tiers keep the gated behavior (enforced only when
  // set) so a key-only demo/dev droplet doesn't brick — but warn LOUDLY.
  if (tier === 'prod' && clerkJwtKey && !clerkIssuer) {
    throw new AuthConfigError(
      'APP_TIER=prod requires CLERK_ISSUER when CLERK_JWT_KEY is set (issuer verification must not be skippable in prod). ' +
        'Set CLERK_ISSUER to the Clerk Frontend API origin, e.g. https://clerk.sandolab.xyz.',
    )
  }
  if (clerkJwtKey && !clerkIssuer) {
    warn('[auth] CLERK_ISSUER is unset — Clerk JWT issuer verification is DISABLED on this tier. Set CLERK_ISSUER.', {
      tier,
    })
  }
  if (clerkJwtKey && clerkAuthorizedParties.length === 0) {
    warn(
      '[auth] CLERK_AUTHORIZED_PARTIES is unset — Clerk JWT azp/aud verification is DISABLED. ' +
        'Set it to the comma-separated SPA origin(s) allowed to mint sessions (e.g. https://sitelayer.sandolab.xyz).',
      { tier },
    )
  }

  return {
    clerkJwtKey,
    clerkIssuer,
    clerkAuthorizedParties: clerkAuthorizedParties.length > 0 ? clerkAuthorizedParties : null,
    internalAuthToken,
    defaultUserId: env.ACTIVE_USER_ID?.trim() || 'demo-user',
    allowHeaderFallback,
    allowFirstUserAdmin,
  }
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  // A bearer that LOOKS like a JWT (three dot-separated segments) but whose
  // base64 / JSON is garbage is a malformed *credential*, not a server bug:
  // the caller sent us junk. Buffer.from(..,'base64') is lenient, but
  // JSON.parse throws SyntaxError on invalid JSON, and a successfully-parsed
  // non-object (a bare number / string / array / null) is equally unusable.
  // Both must surface as AuthError(401) so the auth gate in server.ts maps
  // them to a 401 reject instead of escaping the AuthError catch and becoming
  // a 500. It still REJECTS in every case — the only change is the status code.
  let decoded: unknown
  try {
    const padded = segment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(segment.length / 4) * 4, '=')
    decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    throw new AuthError(401, 'malformed token')
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new AuthError(401, 'malformed token')
  }
  return decoded as Record<string, unknown>
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
  // Authorized-party verification, per the Clerk model: `azp` carries the
  // origin that minted the session. When an allowlist is configured
  // (CLERK_AUTHORIZED_PARTIES), a token whose azp is present but NOT
  // allowlisted is rejected — this is the cross-instance / cross-app token
  // reuse defence the 2026-05-28 audit flagged. A token WITHOUT azp is
  // accepted (Clerk omits it for non-browser sessions, e.g. Backend-API
  // minted sign-in tokens before first handshake), matching Clerk's own
  // authorizedParties semantics. `aud` is absent from standard Clerk session
  // tokens but can be added by a JWT template; when present it must also
  // intersect the allowlist.
  const authorizedParties = config.clerkAuthorizedParties
  if (authorizedParties && authorizedParties.length > 0) {
    const azp = typeof payload.azp === 'string' ? payload.azp.trim() : null
    if (azp && !authorizedParties.includes(azp)) {
      throw new AuthError(401, 'unauthorized party (azp)')
    }
    const audRaw = payload.aud
    if (audRaw !== undefined && audRaw !== null) {
      const audiences = (Array.isArray(audRaw) ? audRaw : [audRaw]).filter(
        (a): a is string => typeof a === 'string' && a.trim().length > 0,
      )
      if (audiences.length === 0 || !audiences.some((a) => authorizedParties.includes(a.trim()))) {
        throw new AuthError(401, 'unauthorized audience (aud)')
      }
    }
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

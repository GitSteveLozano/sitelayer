import type { IncomingMessage } from 'node:http'
import { createPublicKey, createVerify } from 'node:crypto'

export type Identity = {
  userId: string
  source: 'clerk' | 'internal' | 'header' | 'default'
  role?: string
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
  const clerkJwtKey = env.CLERK_JWT_KEY?.trim() || null
  const internalAuthToken = env.INTERNAL_AUTH_TOKEN?.trim() || null
  const authConfigured = Boolean(clerkJwtKey || internalAuthToken)
  const allowHeaderFallback = env.AUTH_ALLOW_HEADER_FALLBACK
    ? env.AUTH_ALLOW_HEADER_FALLBACK === '1' || env.AUTH_ALLOW_HEADER_FALLBACK === 'true'
    : !authConfigured || tier !== 'prod'
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
  if (typeof payload.exp === 'number' && payload.exp < now) {
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
  return { userId: sub, source: 'clerk' }
}

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function readHeader(req: IncomingMessage, key: string): string | null {
  const value = req.headers[key]
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

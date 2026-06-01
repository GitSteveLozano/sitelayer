import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Teammate-invite token + helper surface. No DB access here — this module is
 * pure so it can be unit-tested without a pool. The route handler
 * (`routes/invites.ts`) owns the SQL; the acceptance transaction body is the
 * one DB-touching helper exported here (`acceptInviteTx`) and takes a client so
 * it can be exercised against a fake client.
 */

export const INVITE_TOKEN_BYTES = 32 // 256 bits

export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url')
}

/**
 * Defensive constant-time compare for the token presented at accept/view time.
 * The DB unique-index lookup is the primary guard; this avoids a length/byte
 * timing side-channel on the comparison surface.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const INVITE_ROLES = ['admin', 'foreman', 'office', 'member', 'bookkeeper'] as const
export type InviteRole = (typeof INVITE_ROLES)[number]
export function isInviteRole(v: unknown): v is InviteRole {
  return typeof v === 'string' && (INVITE_ROLES as readonly string[]).includes(v)
}

// Email normalization for the one-pending-per-email guard + clerk_users match.
export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase()
}
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

// Shape returned to a public viewer — NO token, NO accepted_by/invited_by.
export type PublicInviteView = {
  company_name: string
  email: string
  role: string
  status: InviteStatus
  expires_at: string
}

export function inviteAcceptBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_PUBLIC_BASE_URL?.trim() || 'https://sitelayer.sandolab.xyz').replace(/\/$/, '')
}

export function buildInviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/invite/accept/${encodeURIComponent(token)}`
}

// Clamp the optional expires_in_days request value into [1, 90].
export const INVITE_EXPIRES_DEFAULT_DAYS = 14
export const INVITE_EXPIRES_MIN_DAYS = 1
export const INVITE_EXPIRES_MAX_DAYS = 90

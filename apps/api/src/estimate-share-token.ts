import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AppTier } from './tier.js'

/**
 * HMAC-signed share token derivation for estimate portal links.
 *
 * Token format: `<random_id>.<hmac>` where:
 *   - random_id is a 22-char base64url (≥ 16 random bytes, ≥ 128 bits)
 *   - hmac is the base64url-encoded SHA-256 HMAC of random_id under
 *     the configured secret
 *
 * The secret resolution mirrors validateQboStateSecret: prefer
 * `ESTIMATE_SHARE_SECRET`, fall back to `QBO_STATE_SECRET` so a single
 * env var can cover both surfaces in dev/preview, and require the
 * dedicated env in prod (the caller decides — see resolveShareSecret).
 *
 * The full row (with the signed token) is what the API persists; the
 * recipient receives the share_token verbatim. verifyShareToken()
 * recomputes the HMAC under the active secret and compares with a
 * constant-time helper so an attacker cannot mint tokens by guessing
 * random_id.
 */

const RANDOM_ID_BYTES = 18 // 24 base64url chars, padding stripped → 24 chars

export type VerifyShareTokenResult = { ok: true; id: string } | { ok: false }

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function hmac(secret: string, value: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(value).digest())
}

/**
 * Resolve the active share-token secret. Mirrors the QBO state-secret
 * resolution rule: prod must have a distinct value; non-prod may fall
 * back to QBO_STATE_SECRET so existing dev fixtures keep working without
 * adding a second secret.
 *
 * The caller is responsible for refusing to start when the prod secret
 * is missing — see resolveShareSecretConfig() for that gate.
 */
export function resolveShareSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ESTIMATE_SHARE_SECRET?.trim()
  if (explicit) return explicit
  const qbo = env.QBO_STATE_SECRET?.trim()
  if (qbo) return qbo
  return null
}

export type ShareSecretConfig =
  | { ok: true; secret: string; source: 'estimate' | 'qbo-fallback' }
  | { ok: false; reason: 'missing' }

/**
 * Validate the resolved secret for the active tier. Prod refuses to
 * start without ESTIMATE_SHARE_SECRET (or, by the caller's choice, a
 * shared QBO_STATE_SECRET). Non-prod tiers may fall back silently.
 */
export function resolveShareSecretConfig(input: { tier: AppTier; env?: NodeJS.ProcessEnv }): ShareSecretConfig {
  const env = input.env ?? process.env
  const explicit = env.ESTIMATE_SHARE_SECRET?.trim() || null
  const qbo = env.QBO_STATE_SECRET?.trim() || null
  if (explicit) return { ok: true, secret: explicit, source: 'estimate' }
  if (qbo) return { ok: true, secret: qbo, source: 'qbo-fallback' }
  if (input.tier === 'prod') return { ok: false, reason: 'missing' }
  // Non-prod: never going to be in scope without env, but fall through
  // for safety so callers can choose to accept null without a panic.
  return { ok: false, reason: 'missing' }
}

/**
 * Generate a fresh share token bound to `secret`. The returned `id`
 * is the random component that gets persisted on the share row; the
 * `token` is the value sent to the recipient.
 */
export function generateShareToken(secret: string): { id: string; token: string } {
  const id = base64urlEncode(randomBytes(RANDOM_ID_BYTES))
  const sig = hmac(secret, id)
  return { id, token: `${id}.${sig}` }
}

/**
 * Verify a recipient-presented token. Returns the random id portion
 * on success — the caller is expected to look that id up in
 * estimate_share_links by matching `share_token = <full token>` (we
 * still store the full token in the row so a future secret rotation
 * leaves existing rows verifiable as long as the rotated-out secret
 * is included in a verification fallback).
 */
export function verifyShareToken(token: string, secret: string): VerifyShareTokenResult {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) {
    return { ok: false }
  }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot >= token.length - 1) return { ok: false }
  const id = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  // Defensive: HMAC inputs must be ASCII-printable; reject anything else.
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(sig)) {
    return { ok: false }
  }
  const expected = hmac(secret, id)
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return { ok: false }
  if (!timingSafeEqual(a, b)) return { ok: false }
  return { ok: true, id }
}

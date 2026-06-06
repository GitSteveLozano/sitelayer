import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const RANDOM_ID_BYTES = 24
const TOKEN_PREFIX = 'fbiv1'
const DEFAULT_KID = 'default'

export type FeedbackInviteToken = {
  id: string
  kid: string
  token: string
}

export type VerifyFeedbackInviteTokenResult = { ok: true; id: string; kid: string } | { ok: false }

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function hmac(secret: string, kid: string, id: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(`feedback_invite:v1:${kid}:${id}`).digest())
}

export function generateFeedbackInviteToken(secret: string, kid = DEFAULT_KID): FeedbackInviteToken {
  if (!secret.trim()) throw new Error('feedback invite secret is required')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) throw new Error('feedback invite kid is invalid')
  const id = base64urlEncode(randomBytes(RANDOM_ID_BYTES))
  const mac = hmac(secret, kid, id)
  return { id, kid, token: `${TOKEN_PREFIX}.${kid}.${id}.${mac}` }
}

export function verifyFeedbackInviteToken(token: string, secrets: Readonly<Record<string, string>>) {
  if (typeof token !== 'string') return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  const [, kid, id, mac] = parts
  if (!kid || !id || !mac) return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  if (!/^[A-Za-z0-9_-]+$/.test(kid) || !/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(mac)) {
    return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  }
  const secret = secrets[kid]
  if (!secret) return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  const expected = hmac(secret, kid, id)
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  if (!timingSafeEqual(a, b)) return { ok: false } satisfies VerifyFeedbackInviteTokenResult
  return { ok: true, id, kid } satisfies VerifyFeedbackInviteTokenResult
}

export function feedbackInviteSecretMap(secret: string | null | undefined, kid = DEFAULT_KID): Record<string, string> {
  const trimmed = secret?.trim()
  return trimmed ? { [kid]: trimmed } : {}
}

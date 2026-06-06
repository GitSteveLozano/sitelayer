/**
 * HMAC-signed OAuth state token for the QBO connect round-trip.
 * Signed with QBO_STATE_SECRET; encodes companyId + userId + nonce +
 * expiry so the callback can verify the user is a member of the
 * company they're connecting before exchanging the auth code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { HttpError } from './http-utils.js'

export type QboOAuthState = {
  companyId: string
  userId: string
  exp: number
  nonce: string
}

function signQboStatePayload(payload: string, stateSecret: string) {
  return createHmac('sha256', stateSecret).update(payload).digest('base64url')
}

function isSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function encodeQboState(state: QboOAuthState, stateSecret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = signQboStatePayload(payload, stateSecret)
  return `${payload}.${signature}`
}

export function decodeQboState(rawState: string, stateSecret: string): QboOAuthState {
  const [payload, signature] = rawState.split('.', 2)
  if (!payload || !signature || !isSafeEqual(signQboStatePayload(payload, stateSecret), signature)) {
    throw new HttpError(400, 'invalid state')
  }

  let parsed: QboOAuthState
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as QboOAuthState
  } catch {
    throw new HttpError(400, 'invalid state')
  }

  if (!parsed.companyId || !parsed.userId || !parsed.exp || parsed.exp < Date.now()) {
    throw new HttpError(400, 'expired state')
  }
  return parsed
}

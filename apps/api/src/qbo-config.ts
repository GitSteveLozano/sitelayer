import type { AppTier } from './tier.js'

export type QboStateSecretInput = {
  tier: AppTier
  stateSecret: string | null
  clientSecret: string
}

export type QboStateSecretResult =
  | { ok: true; stateSecret: string }
  | { ok: false; reason: 'missing' | 'reused-client-secret' }

export function validateQboStateSecret(input: QboStateSecretInput): QboStateSecretResult {
  const trimmed = input.stateSecret?.trim() || null
  if (input.tier === 'prod') {
    if (!trimmed) return { ok: false, reason: 'missing' }
    if (trimmed === input.clientSecret) return { ok: false, reason: 'reused-client-secret' }
    return { ok: true, stateSecret: trimmed }
  }
  return { ok: true, stateSecret: trimmed ?? input.clientSecret }
}

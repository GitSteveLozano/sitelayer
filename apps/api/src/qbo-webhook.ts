import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * QuickBooks Online webhook payload shape.
 *
 * Intuit signs the raw request body with the app's "verifier token" (HMAC-SHA256)
 * and sends the base64 signature in the `intuit-signature` header. See
 * https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks
 */
export type QboWebhookEntity = {
  name: string
  id: string
  operation: string
  lastUpdated?: string
}

export type QboWebhookEventNotification = {
  realmId: string
  dataChangeEvent?: {
    entities?: QboWebhookEntity[]
  }
}

export type QboWebhookPayload = {
  eventNotifications?: QboWebhookEventNotification[]
}

export type QboWebhookVerifyResult = { ok: true } | { ok: false; status: number; error: string }

/**
 * Boot-time env-presence check for the QBO inbound webhook.
 *
 * The webhook handler returns 503 to Intuit when QBO_WEBHOOK_VERIFIER is unset
 * (it cannot HMAC-verify the signature without it). In prod that's a silent
 * outage: Intuit retries, gives up, and inbound entity changes stop arriving —
 * with no startup signal that the verifier was simply never configured. This
 * surfaces that misconfiguration as a WARNING at boot (NOT a crash — the rest
 * of the API is still healthy and other QBO paths work; only the inbound
 * webhook is degraded). Pure + injectable so it's unit-testable.
 *
 * Returns true when it warned (prod + verifier missing), false otherwise.
 */
export function warnIfQboWebhookVerifierMissing(
  env: { APP_TIER?: string; QBO_WEBHOOK_VERIFIER?: string },
  warn: (message: string) => void,
): boolean {
  const tier = (env.APP_TIER ?? '').trim().toLowerCase()
  const verifier = (env.QBO_WEBHOOK_VERIFIER ?? '').trim()
  if (tier === 'prod' && !verifier) {
    warn(
      '[qbo-webhook] QBO_WEBHOOK_VERIFIER is not set in prod — POST /api/webhooks/qbo will 503 and inbound QBO webhooks will silently stop. Set the verifier in /app/sitelayer/.env and restart.',
    )
    return true
  }
  return false
}

/**
 * Map a QBO entity name to the Sitelayer sync_events entity_type taxonomy.
 *
 * The mapped types below are mirrored explicitly so an inbound webhook records
 * a clean, well-known `entity_type` on the sync_events audit row; any other
 * entity name is passed through (lowercased) so we still retain the raw name.
 * A downstream worker can decide whether to ignore it.
 *
 * `Payment` is mapped to `payment` so an inbound QBO Payment notification lands
 * as a typed audit row. NOTE: there is NOT YET a worker that consumes inbound
 * `payment` sync_events to reconcile a billing-milestone's realized status from
 * QBO truth — that handler is a sized follow-up (see
 * docs/RUNBOOK_QBO_CIRCUIT.md / the project-billing-milestones note). Until
 * then a milestone's `paid` status is a MANUAL assertion, not QBO-confirmed
 * (see apps/api/src/routes/project-billing-milestones.ts).
 */
export function mapQboEntityType(qboName: string): string {
  switch (qboName) {
    case 'Customer':
      return 'customer'
    case 'Item':
      return 'service_item'
    case 'Bill':
      return 'material_bill'
    case 'Invoice':
      return 'invoice'
    case 'Payment':
      return 'payment'
    default:
      return qboName.toLowerCase()
  }
}

/**
 * Extract the `intuit-signature` header in a case-insensitive, array-tolerant way.
 *
 * Node lowercases incoming HTTP header names but exposes `req.headers` typed as
 * `IncomingHttpHeaders`, which permits arrays for some values. We pick the first
 * string when an array is presented, and return null otherwise.
 */
export function extractIntuitSignature(headers: Record<string, unknown>): string | null {
  const raw = headers['intuit-signature']
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null
  return typeof raw === 'string' ? raw : null
}

/**
 * Verify the Intuit webhook signature in constant time.
 *
 * QBO computes `base64(HMAC_SHA256(verifierToken, rawBody))`. We do the same
 * locally, and compare with `timingSafeEqual` on buffers of equal length to
 * avoid leaking info via early string-compare short-circuits.
 *
 * Returns:
 * - `{ ok: true }` when the signature matches.
 * - `{ ok: false, status: 400 }` for missing header / malformed signature shape.
 * - `{ ok: false, status: 401 }` when the computed HMAC does not match.
 */
export function verifyQboWebhook(
  rawBody: string,
  signatureHeader: string | null,
  verifierToken: string,
): QboWebhookVerifyResult {
  if (!signatureHeader) {
    return { ok: false, status: 401, error: 'missing intuit-signature header' }
  }
  if (!verifierToken) {
    return { ok: false, status: 500, error: 'verifier token not configured' }
  }
  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signatureHeader, 'base64')
  } catch {
    return { ok: false, status: 401, error: 'invalid signature encoding' }
  }
  // Length mismatch is itself a signature failure but we must not throw.
  // timingSafeEqual requires equal-length buffers, so short-circuit explicitly.
  //
  // Note: HMAC-SHA256 always produces a 32-byte digest, so `expected.length`
  // is invariant. A mismatched `provided.length` means a malformed or
  // truncated signature — not a different-length-but-valid signature. So
  // the early return here doesn't leak signature length to an attacker
  // (there's only one valid length). If we ever switch to a variable-length
  // HMAC variant this branch becomes a timing oracle and must be removed.
  if (provided.length !== expected.length) {
    return { ok: false, status: 401, error: 'signature mismatch' }
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: 'signature mismatch' }
  }
  return { ok: true }
}

/**
 * Parse and lightly validate a QBO webhook body.
 *
 * QBO guarantees `eventNotifications: []` shape; we treat anything else as
 * malformed and return 400 rather than silently dropping events. An empty
 * `eventNotifications` array is valid (QBO sometimes sends heartbeat-style
 * empty batches) and resolves to `{ ok: true, payload }`.
 */
export function parseQboWebhookPayload(
  rawBody: string,
): { ok: true; payload: QboWebhookPayload } | { ok: false; status: number; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, status: 400, error: 'payload must be an object' }
  }
  const payload = parsed as QboWebhookPayload
  if (!Array.isArray(payload.eventNotifications)) {
    return { ok: false, status: 400, error: 'eventNotifications must be an array' }
  }
  return { ok: true, payload }
}

/**
 * Flatten a QBO webhook payload into one row per entity for persistence.
 *
 * The caller is expected to fan these out as `sync_events` rows keyed by
 * `(realmId, entity)`. Unknown entity types pass through via `mapQboEntityType`.
 */
export function flattenQboWebhookPayload(payload: QboWebhookPayload): Array<{
  realmId: string
  entityType: string
  entityId: string
  operation: string
  lastUpdated: string | null
  raw: QboWebhookEntity
}> {
  const out: Array<{
    realmId: string
    entityType: string
    entityId: string
    operation: string
    lastUpdated: string | null
    raw: QboWebhookEntity
  }> = []
  for (const notification of payload.eventNotifications ?? []) {
    const realmId = notification.realmId
    if (!realmId) continue
    for (const entity of notification.dataChangeEvent?.entities ?? []) {
      if (!entity || !entity.name || !entity.id) continue
      out.push({
        realmId,
        entityType: mapQboEntityType(entity.name),
        entityId: entity.id,
        operation: entity.operation ?? 'Unknown',
        lastUpdated: entity.lastUpdated ?? null,
        raw: entity,
      })
    }
  }
  return out
}

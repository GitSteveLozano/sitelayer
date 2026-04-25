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
 * Map a QBO entity name to the Sitelayer sync_events entity_type taxonomy.
 *
 * Only the four entity types the WhatsApp thread calls out are mirrored; any
 * other entity name is passed through so we retain the raw name in the
 * sync_events row. A downstream worker can decide whether to ignore it.
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

import { Webhook, WebhookVerificationError } from 'svix'

export type ClerkWebhookEvent = {
  type: string
  data: Record<string, unknown>
  object?: string
}

export type ClerkWebhookHeaders = {
  svixId: string | null
  svixTimestamp: string | null
  svixSignature: string | null
}

export type ClerkWebhookResult = { ok: true; event: ClerkWebhookEvent } | { ok: false; status: number; error: string }

export function extractSvixHeaders(headers: Record<string, unknown>): ClerkWebhookHeaders {
  function pick(key: string): string | null {
    const raw = headers[key]
    if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null
    return typeof raw === 'string' ? raw : null
  }
  return {
    svixId: pick('svix-id'),
    svixTimestamp: pick('svix-timestamp'),
    svixSignature: pick('svix-signature'),
  }
}

/**
 * Verify a Clerk svix-signed webhook payload. Returns the parsed event on success
 * or an error tuple on failure. Caller is responsible for HTTP status mapping.
 */
export function verifyClerkWebhook(rawBody: string, headers: ClerkWebhookHeaders, secret: string): ClerkWebhookResult {
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
    return { ok: false, status: 400, error: 'missing svix-id / svix-timestamp / svix-signature header' }
  }
  const wh = new Webhook(secret)
  try {
    const event = wh.verify(rawBody, {
      'svix-id': headers.svixId,
      'svix-timestamp': headers.svixTimestamp,
      'svix-signature': headers.svixSignature,
    }) as ClerkWebhookEvent
    if (!event || typeof event.type !== 'string') {
      return { ok: false, status: 400, error: 'webhook payload missing type' }
    }
    return { ok: true, event }
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return { ok: false, status: 401, error: err.message }
    }
    return { ok: false, status: 400, error: err instanceof Error ? err.message : 'webhook verification failed' }
  }
}

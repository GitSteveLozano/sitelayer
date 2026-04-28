// Lightweight Sentry event scrubber. We can't take a hard dependency on the
// internal `Event` type without importing @sentry/node from a hook target, so
// this module operates on a structural shape and the live Sentry beforeSend
// hook is responsible for casting.

export type ScrubbableEvent = {
  request?: {
    data?: unknown
    headers?: Record<string, unknown>
    cookies?: unknown
  }
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-clerk-auth-token',
  'x-clerk-auth-status',
  'svix-id',
  'svix-signature',
  'svix-timestamp',
  'intuit-signature',
  'x-sitelayer-user-id',
])

const SENSITIVE_FIELD_PATTERN =
  /(access_token|refresh_token|client_secret|webhook_secret|password|api_key|state_secret|jwt)/i

const PDF_MAGIC = '%PDF-'
const MAX_BODY_PREVIEW_BYTES = 32 * 1024
const REDACTED = '[REDACTED]'

function isPdfPayload(value: unknown): boolean {
  if (typeof value === 'string' && value.startsWith(PDF_MAGIC)) return true
  if (value instanceof Uint8Array) {
    const head = Buffer.from(value.subarray(0, 5)).toString('utf8')
    return head === PDF_MAGIC
  }
  return false
}

function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (value.startsWith(PDF_MAGIC)) return '[REDACTED:pdf]'
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubObject(entry, depth + 1))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    for (const [key, val] of entries) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        result[key] = REDACTED
        continue
      }
      result[key] = scrubObject(val, depth + 1)
    }
    return result
  }
  return value
}

function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!headers) return headers
  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      result[name] = REDACTED
    } else {
      result[name] = value
    }
  }
  return result
}

function scrubBody(data: unknown): unknown {
  if (data === undefined || data === null) return data
  if (isPdfPayload(data)) return '[REDACTED:pdf]'
  if (data instanceof Uint8Array) {
    if (data.byteLength > MAX_BODY_PREVIEW_BYTES) return `[REDACTED:binary ${data.byteLength}b]`
    return data
  }
  if (typeof data === 'string') {
    if (data.length > MAX_BODY_PREVIEW_BYTES) return `[REDACTED:string ${data.length}b]`
    return data
  }
  return scrubObject(data)
}

export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const scrubbedHeaders = scrubHeaders(event.request.headers)
    if (scrubbedHeaders) {
      event.request.headers = scrubbedHeaders
    } else {
      delete event.request.headers
    }
    event.request.cookies = REDACTED
    if ('data' in event.request) {
      event.request.data = scrubBody(event.request.data)
    }
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as Record<string, unknown>
  }
  return event
}

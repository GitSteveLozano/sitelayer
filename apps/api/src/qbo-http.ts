/**
 * Low-level QBO HTTP client. Wraps `fetch` with retry-on-429/5xx and
 * Sentry `http.client` spans so QBO calls thread under the originating
 * request. Higher-level concerns (token refresh, mapping resolution,
 * sync run state) live in their own modules.
 */
import { Sentry } from './instrument.js'

const QBO_RETRY_DELAYS_MS = [200, 1000, 5000] as const

function qboShouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

/**
 * Sanitize a caller-supplied idempotency key into a value safe to use as
 * Intuit's `requestid` query parameter.
 *
 * Intuit dedupes create POSTs that carry the same `requestid` within a
 * rolling window: a crash/retry after Intuit accepted the create returns the
 * SAME object instead of minting a duplicate invoice/estimate/TimeActivity.
 * The token must be a non-empty string; Intuit caps it at 50 chars. We strip
 * everything that isn't URL-path-safe (`[A-Za-z0-9._-]`) so a UUID, an outbox
 * idempotency key like `rental_billing_run:post:<id>`, or a run id all reduce
 * to a stable, deterministic token. The SAME input always yields the SAME
 * output, which is the whole point — a retry must reproduce the key byte for
 * byte to be deduped upstream.
 */
export function sanitizeQboRequestId(key: string): string {
  return key
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

/**
 * Append Intuit's `?requestid=<key>` idempotency token to a QBO create URL.
 *
 * Pure + deterministic: a falsy/empty key (after sanitization) returns the
 * URL unchanged so callers that have no stable key degrade to today's
 * non-idempotent behavior rather than sending `?requestid=`. Preserves any
 * existing query string by switching the separator to `&`.
 */
export function appendQboRequestId(url: string, requestId: string | null | undefined): string {
  if (!requestId) return url
  const token = sanitizeQboRequestId(requestId)
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}requestid=${encodeURIComponent(token)}`
}

export async function qboFetch<T>(url: string, init: RequestInit): Promise<T> {
  let lastStatus = 0
  let lastStatusText = ''
  const method = (init.method ?? 'GET').toUpperCase()
  for (let attempt = 0; attempt <= QBO_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await Sentry.startSpan(
      {
        name: 'qbo.request',
        op: 'http.client',
        attributes: {
          'http.url': url,
          'http.method': method,
          'qbo.attempt': attempt,
        },
      },
      async (span) => {
        const r = await fetch(url, init)
        span?.setAttribute('http.status_code', r.status)
        if (!r.ok) {
          span?.setStatus({ code: 2, message: `qbo_${r.status}` })
        }
        return r
      },
    )
    if (response.ok) return (await response.json()) as T
    lastStatus = response.status
    lastStatusText = response.statusText
    if (!qboShouldRetry(response.status) || attempt === QBO_RETRY_DELAYS_MS.length) {
      throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
    }
    const delay = QBO_RETRY_DELAYS_MS[attempt] ?? 0
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`QBO API error: ${lastStatus} ${lastStatusText}`)
}

export async function qboGet<T>(baseUrl: string, endpoint: string, realmId: string, accessToken: string): Promise<T> {
  return qboFetch<T>(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
}

export async function qboPost<T>(
  baseUrl: string,
  endpoint: string,
  realmId: string,
  accessToken: string,
  body: unknown,
  /**
   * Optional deterministic idempotency key. When supplied it is appended as
   * Intuit's `?requestid=<key>` so a crash/retry after Intuit accepted the
   * create is deduped UPSTREAM at Intuit instead of minting a duplicate
   * invoice/estimate/TimeActivity. Pass the caller's stable key (e.g. the
   * mutation_outbox idempotency key or the run id) — NOT a per-attempt value.
   */
  requestId?: string | null,
): Promise<T> {
  const url = appendQboRequestId(`${baseUrl}/v3/company/${realmId}${endpoint}`, requestId)
  return qboFetch<T>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
}

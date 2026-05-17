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
): Promise<T> {
  return qboFetch<T>(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
}

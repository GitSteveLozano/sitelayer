import type { QueueClient } from '@sitelayer/queue'

// QBO access-token refresh-on-401 + proactive expiry refresh.
//
// Background:
//   QBO access tokens expire ~1h after issue at OAuth time. Without
//   refresh logic the worker push paths start 401ing 60min after the
//   operator clicks "Connect to QBO". The refresh_token has a much longer
//   life (~100 days) and rotates whenever it's used.
//
// Contract:
//   - All refresh work happens INSIDE the queue tx that's already
//     processing the outbox row, using the same QueueClient. That gives
//     us free row-locking semantics: a SELECT ... FOR UPDATE on
//     integration_connections in tx-A blocks tx-B until tx-A commits, so
//     two concurrent pushes for the same company never double-refresh.
//   - On any 401 from QBO we refresh once and retry. A second 401 after
//     refresh is reported as auth_error and the connection row is marked
//     so a human re-connects.
//   - QBO_CLIENT_ID and QBO_CLIENT_SECRET are required. Missing creds
//     fail loud (per repo operating rule #1: no silent localhost-style
//     defaults).

export type IntegrationConnectionTokens = {
  id: string
  provider_account_id: string | null
  access_token: string | null
  refresh_token: string | null
  status: string
  access_token_expires_at: string | null
}

export type RefreshedTokens = {
  access_token: string
  refresh_token: string
  access_token_expires_at: string
}

export type RefreshDeps = {
  fetchImpl?: typeof fetch
  /** Override env reads for tests. */
  envImpl?: NodeJS.ProcessEnv
  /** ms safety margin treated as "about to expire". Defaults to 60_000. */
  expirySafetyMarginMs?: number
}

const DEFAULT_SAFETY_MARGIN_MS = 60_000
const QBO_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

export class QboTokenRefreshError extends Error {
  readonly kind: 'auth_error' | 'config_error' | 'network_error' | 'no_refresh_token'
  readonly status: number | null
  constructor(
    message: string,
    kind: 'auth_error' | 'config_error' | 'network_error' | 'no_refresh_token',
    status: number | null = null,
  ) {
    super(message)
    this.name = 'QboTokenRefreshError'
    this.kind = kind
    this.status = status
  }
}

/**
 * Treat NULL expiry as "about to expire" — better to do a redundant
 * refresh once than to hand out a stale token. After the first refresh
 * the column is populated and subsequent calls take the fast path.
 */
export function isAccessTokenExpired(
  connection: Pick<IntegrationConnectionTokens, 'access_token_expires_at'>,
  now: Date = new Date(),
  safetyMarginMs: number = DEFAULT_SAFETY_MARGIN_MS,
): boolean {
  if (!connection.access_token_expires_at) return true
  const expiresAt = Date.parse(connection.access_token_expires_at)
  if (!Number.isFinite(expiresAt)) return true
  return now.getTime() + safetyMarginMs >= expiresAt
}

function readQboCreds(envImpl: NodeJS.ProcessEnv = process.env): {
  clientId: string
  clientSecret: string
} {
  const clientId = envImpl.QBO_CLIENT_ID
  const clientSecret = envImpl.QBO_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new QboTokenRefreshError(
      'QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set to refresh QBO tokens',
      'config_error',
    )
  }
  return { clientId, clientSecret }
}

/**
 * Refresh the access token, persist the new tokens to the DB row, and
 * return the fresh values. The caller MUST have already taken a row
 * lock on integration_connections (via SELECT ... FOR UPDATE) inside
 * the same QueueClient transaction, otherwise two concurrent pushes
 * could both refresh and Intuit will invalidate one of the rotated
 * refresh_tokens.
 */
export async function refreshAccessToken(
  connection: IntegrationConnectionTokens,
  client: QueueClient,
  deps: RefreshDeps = {},
): Promise<RefreshedTokens> {
  if (!connection.refresh_token) {
    throw new QboTokenRefreshError(
      `qbo connection ${connection.id} has no refresh_token; operator must reconnect`,
      'no_refresh_token',
    )
  }
  const { clientId, clientSecret } = readQboCreds(deps.envImpl)
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const fetchImpl = deps.fetchImpl ?? fetch

  let response: Response
  try {
    response = await fetchImpl(QBO_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connection.refresh_token,
      }).toString(),
    })
  } catch (err) {
    throw new QboTokenRefreshError(
      `qbo token refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
    )
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    // 4xx from the refresh endpoint means the refresh_token itself is
    // dead (revoked, expired, or rotated by another tab). Mark the
    // connection so the operator reconnects; do not retry forever.
    if (response.status >= 400 && response.status < 500) {
      await client.query(
        `update integration_connections
           set status = 'auth_error', version = version + 1
         where id = $1`,
        [connection.id],
      )
      throw new QboTokenRefreshError(
        `qbo refresh returned ${response.status}: ${errBody.slice(0, 500)} — connection marked auth_error`,
        'auth_error',
        response.status,
      )
    }
    throw new QboTokenRefreshError(
      `qbo refresh returned ${response.status}: ${errBody.slice(0, 500)}`,
      'network_error',
      response.status,
    )
  }

  const tokenData = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const expiresInSec = Number(tokenData.expires_in)
  if (!tokenData.access_token || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    throw new QboTokenRefreshError('qbo refresh response missing access_token or expires_in', 'network_error')
  }
  // Intuit rotates refresh_tokens periodically — fall back to the prior
  // token if the response omits it (older API versions).
  const newRefreshToken = tokenData.refresh_token ?? connection.refresh_token
  const updated = await client.query<{ access_token_expires_at: string }>(
    `update integration_connections
        set access_token = $2,
            refresh_token = $3,
            access_token_expires_at = now() + ($4::int * interval '1 second'),
            status = 'connected',
            version = version + 1
      where id = $1
      returning access_token_expires_at`,
    [connection.id, tokenData.access_token, newRefreshToken, Math.floor(expiresInSec)],
  )
  const expiresAt = updated.rows[0]?.access_token_expires_at
  if (!expiresAt) {
    throw new QboTokenRefreshError(
      `failed to persist refreshed qbo tokens for connection ${connection.id}`,
      'network_error',
    )
  }
  return {
    access_token: tokenData.access_token,
    refresh_token: newRefreshToken,
    access_token_expires_at: expiresAt,
  }
}

/**
 * Lock the connection row, return the latest tokens. Use FOR UPDATE so
 * concurrent worker txs serialize on the row.
 */
export async function lockConnectionForRefresh(
  client: QueueClient,
  connectionId: string,
): Promise<IntegrationConnectionTokens | null> {
  const result = await client.query<IntegrationConnectionTokens>(
    `select id, provider_account_id, access_token, refresh_token, status, access_token_expires_at
       from integration_connections
       where id = $1
       for update`,
    [connectionId],
  )
  return result.rows[0] ?? null
}

export type FreshTokenResult<T> = { ok: true; value: T } | { ok: false; error: QboTokenRefreshError }

/**
 * Run `fn(token)` with a fresh access token. Refresh proactively if the
 * stored token is expired/about-to-expire; if `fn` reports a 401 anyway,
 * refresh once and retry (a single retry — a second 401 means the
 * refresh itself produced a dead token and we mark auth_error).
 *
 * `fn` must report 401s by returning an `unauthorized: true` flag rather
 * than throwing — that way the helper can decide whether to retry vs
 * propagate the original error. Any other failure mode is the caller's
 * to throw.
 */
export async function withFreshToken<T>(
  initialConnection: IntegrationConnectionTokens,
  client: QueueClient,
  fn: (accessToken: string) => Promise<{ unauthorized: false; value: T } | { unauthorized: true }>,
  deps: RefreshDeps = {},
): Promise<T> {
  let connection = initialConnection
  let token = connection.access_token

  // Proactive refresh path.
  if (isAccessTokenExpired(connection, new Date(), deps.expirySafetyMarginMs)) {
    const locked = await lockConnectionForRefresh(client, connection.id)
    if (!locked) {
      throw new QboTokenRefreshError(`qbo connection ${connection.id} disappeared while refreshing`, 'auth_error')
    }
    // Re-check expiry after acquiring the lock; another tx may have
    // refreshed already, in which case we just use the new value.
    if (isAccessTokenExpired(locked, new Date(), deps.expirySafetyMarginMs)) {
      const refreshed = await refreshAccessToken(locked, client, deps)
      token = refreshed.access_token
      connection = {
        ...locked,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        access_token_expires_at: refreshed.access_token_expires_at,
      }
    } else {
      token = locked.access_token
      connection = locked
    }
  }

  if (!token) {
    throw new QboTokenRefreshError(
      `qbo connection ${connection.id} has no access_token after refresh attempt`,
      'auth_error',
    )
  }

  const first = await fn(token)
  if (!first.unauthorized) return first.value

  // Reactive refresh path: server said 401 even though our expiry math
  // claimed the token was good. Refresh once and retry.
  const locked = await lockConnectionForRefresh(client, connection.id)
  if (!locked) {
    throw new QboTokenRefreshError(`qbo connection ${connection.id} disappeared while handling 401`, 'auth_error')
  }
  // If the locked row already has a token newer than the one we tried,
  // some other tx refreshed in between — try that token first instead
  // of doing another network round-trip.
  let retryToken: string
  if (locked.access_token && locked.access_token !== token) {
    retryToken = locked.access_token
  } else {
    const refreshed = await refreshAccessToken(locked, client, deps)
    retryToken = refreshed.access_token
  }

  const second = await fn(retryToken)
  if (second.unauthorized) {
    await client.query(
      `update integration_connections
         set status = 'auth_error', version = version + 1
       where id = $1`,
      [connection.id],
    )
    throw new QboTokenRefreshError(
      `qbo returned 401 even after refresh for connection ${connection.id}`,
      'auth_error',
      401,
    )
  }
  return second.value
}

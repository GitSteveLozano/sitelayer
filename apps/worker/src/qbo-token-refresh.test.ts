import { describe, expect, it, vi } from 'vitest'
import type { QueueClient } from '@sitelayer/queue'
import {
  isAccessTokenExpired,
  refreshAccessToken,
  withFreshToken,
  QboTokenRefreshError,
  type IntegrationConnectionTokens,
} from './qbo-token-refresh.js'

// In-memory pg-shaped client. Records all queries and lets each test
// pre-stage row results for SELECT ... FOR UPDATE so we can simulate the
// row-lock behavior without standing up Postgres.

interface QueryCall {
  sql: string
  params: ReadonlyArray<unknown>
}

type RowSource = (sql: string, params: ReadonlyArray<unknown>) => unknown[]

function makeFakeClient(rowSource: RowSource = () => []): {
  client: QueueClient
  calls: QueryCall[]
} {
  const calls: QueryCall[] = []
  const client: QueueClient = {
    async query<T>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number; command: string; oid: number; fields: never[] }> {
      const safe = params ?? []
      calls.push({ sql, params: safe })
      const rows = rowSource(sql, safe) as T[]
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
    },
  }
  return { client, calls }
}

function makeConnection(overrides: Partial<IntegrationConnectionTokens> = {}): IntegrationConnectionTokens {
  return {
    id: 'conn-1',
    provider_account_id: 'realm-123',
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    status: 'connected',
    access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    ...overrides,
  }
}

const baseEnv: NodeJS.ProcessEnv = {
  QBO_CLIENT_ID: 'client-id-x',
  QBO_CLIENT_SECRET: 'client-secret-x',
}

describe('isAccessTokenExpired', () => {
  it('returns true when expires_at is null', () => {
    expect(isAccessTokenExpired({ access_token_expires_at: null })).toBe(true)
  })
  it('returns true when within safety margin', () => {
    const now = new Date('2026-04-30T12:00:00Z')
    const expires = new Date(now.getTime() + 30_000).toISOString()
    expect(isAccessTokenExpired({ access_token_expires_at: expires }, now)).toBe(true)
  })
  it('returns false when comfortably in the future', () => {
    const now = new Date('2026-04-30T12:00:00Z')
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString()
    expect(isAccessTokenExpired({ access_token_expires_at: expires }, now)).toBe(false)
  })
})

describe('refreshAccessToken', () => {
  it('fails loud when QBO_CLIENT_ID/SECRET are missing', async () => {
    const { client } = makeFakeClient()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      refreshAccessToken(makeConnection(), client, { fetchImpl, envImpl: {} as NodeJS.ProcessEnv }),
    ).rejects.toMatchObject({ kind: 'config_error' })
  })

  it('rejects when refresh_token is null', async () => {
    const { client } = makeFakeClient()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      refreshAccessToken(makeConnection({ refresh_token: null }), client, {
        fetchImpl,
        envImpl: baseEnv,
      }),
    ).rejects.toMatchObject({ kind: 'no_refresh_token' })
  })

  it('persists the rotated tokens and returns them', async () => {
    const newExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const { client, calls } = makeFakeClient((sql) => {
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: newExpiresAt }]
      }
      return []
    })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }
      },
    }) as unknown as typeof fetch
    const result = await refreshAccessToken(makeConnection(), client, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(result.access_token).toBe('access-new')
    expect(result.refresh_token).toBe('refresh-new')
    expect(result.access_token_expires_at).toBe(newExpiresAt)
    const update = calls.find((c) => c.sql.includes('returning access_token_expires_at'))
    expect(update).toBeDefined()
    expect(update!.params).toEqual(['conn-1', 'access-new', 'refresh-new', 3600])
  })

  it('marks the connection auth_error on a 4xx refresh response', async () => {
    const { client, calls } = makeFakeClient(() => [])
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      async text() {
        return 'invalid_grant'
      },
    }) as unknown as typeof fetch
    await expect(refreshAccessToken(makeConnection(), client, { fetchImpl, envImpl: baseEnv })).rejects.toMatchObject({
      kind: 'auth_error',
      status: 400,
    })
    const authErr = calls.find((c) => c.sql.includes("status = 'auth_error'"))
    expect(authErr).toBeDefined()
    expect(authErr!.params).toEqual(['conn-1'])
  })

  it('falls back to the prior refresh_token if Intuit omits a new one', async () => {
    const { client } = makeFakeClient((sql) => {
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: new Date().toISOString() }]
      }
      return []
    })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'access-new', expires_in: 3600 }
      },
    }) as unknown as typeof fetch
    const result = await refreshAccessToken(makeConnection({ refresh_token: 'old-rt' }), client, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(result.refresh_token).toBe('old-rt')
  })
})

describe('withFreshToken', () => {
  it('skips refresh when token is fresh and fn succeeds', async () => {
    const { client, calls } = makeFakeClient(() => [])
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const fn = vi.fn().mockResolvedValue({ unauthorized: false, value: 'OK' })
    const result = await withFreshToken(makeConnection(), client, fn, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(result).toBe('OK')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('access-old')
    // No refresh = no SELECT FOR UPDATE / UPDATE roundtrip.
    expect(calls.length).toBe(0)
  })

  it('refreshes proactively when expiry is null and uses the new token', async () => {
    const newExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const { client, calls } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        return [makeConnection({ access_token_expires_at: null })]
      }
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: newExpiresAt }]
      }
      return []
    })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_in: 3600,
        }
      },
    }) as unknown as typeof fetch
    const fn = vi.fn().mockResolvedValue({ unauthorized: false, value: 'OK' })
    const result = await withFreshToken(makeConnection({ access_token_expires_at: null }), client, fn, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(result).toBe('OK')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('access-fresh')
    // Lock + update were issued.
    expect(calls.some((c) => c.sql.includes('for update'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('returning access_token_expires_at'))).toBe(true)
  })

  it('retries exactly once on 401 and uses the refreshed token', async () => {
    const newExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const { client } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        return [makeConnection()]
      }
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: newExpiresAt }]
      }
      return []
    })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_in: 3600,
        }
      },
    }) as unknown as typeof fetch
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ unauthorized: true })
      .mockResolvedValueOnce({ unauthorized: false, value: 'OK-2' })
    const result = await withFreshToken(makeConnection(), client, fn, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(result).toBe('OK-2')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenNthCalledWith(1, 'access-old')
    expect(fn).toHaveBeenNthCalledWith(2, 'access-fresh')
    // Refresh endpoint hit exactly once — no third call.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('marks connection auth_error when the second 401 follows a refresh', async () => {
    const newExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const { client, calls } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        return [makeConnection()]
      }
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: newExpiresAt }]
      }
      return []
    })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_in: 3600,
        }
      },
    }) as unknown as typeof fetch
    const fn = vi.fn().mockResolvedValue({ unauthorized: true })
    await expect(withFreshToken(makeConnection(), client, fn, { fetchImpl, envImpl: baseEnv })).rejects.toMatchObject({
      kind: 'auth_error',
      status: 401,
    })
    expect(calls.some((c) => c.sql.includes("status = 'auth_error'"))).toBe(true)
  })

  it('serializes via SELECT FOR UPDATE when expiry forces refresh — second concurrent caller observes the already-refreshed token', async () => {
    // Two concurrent refresh attempts on the same connection. We simulate
    // tx-A holding the lock long enough for tx-B's SELECT FOR UPDATE to
    // see the row tx-A already updated. The fake client doesn't actually
    // block — we just feed tx-B a "freshly refreshed" connection on its
    // SELECT FOR UPDATE so it skips the network refresh and uses the
    // existing access_token. Verifies the after-lock recheck.
    const fetchImpl = vi.fn() as unknown as typeof fetch

    // tx-A: needs refresh.
    const newExpiresA = new Date(Date.now() + 3600 * 1000).toISOString()
    const { client: clientA } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        return [makeConnection({ access_token_expires_at: null })]
      }
      if (sql.includes('returning access_token_expires_at')) {
        return [{ access_token_expires_at: newExpiresA }]
      }
      return []
    })
    ;(fetchImpl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-fresh-A',
          refresh_token: 'refresh-fresh-A',
          expires_in: 3600,
        }
      },
    })
    const fnA = vi.fn().mockResolvedValue({ unauthorized: false, value: 'OK-A' })
    await withFreshToken(makeConnection({ access_token_expires_at: null }), clientA, fnA, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(fnA).toHaveBeenCalledWith('access-fresh-A')

    // tx-B: starts thinking it needs refresh, but after lock sees a fresh row.
    const { client: clientB, calls: callsB } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        // tx-A already committed; tx-B sees the refreshed row.
        return [makeConnection({ access_token: 'access-fresh-A', access_token_expires_at: newExpiresA })]
      }
      return []
    })
    const fnB = vi.fn().mockResolvedValue({ unauthorized: false, value: 'OK-B' })
    await withFreshToken(makeConnection({ access_token_expires_at: null }), clientB, fnB, {
      fetchImpl,
      envImpl: baseEnv,
    })
    expect(fnB).toHaveBeenCalledWith('access-fresh-A')
    // tx-B did NOT issue an UPDATE — it noticed the lock-time row was already fresh.
    expect(callsB.some((c) => c.sql.includes('returning access_token_expires_at'))).toBe(false)
    // And the refresh endpoint was hit only once across both tx (tx-A's call).
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('throws clear error when refresh_token is null and refresh is forced', async () => {
    const { client } = makeFakeClient((sql) => {
      if (sql.includes('for update')) {
        return [makeConnection({ access_token_expires_at: null, refresh_token: null })]
      }
      return []
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const fn = vi.fn()
    await expect(
      withFreshToken(makeConnection({ access_token_expires_at: null, refresh_token: null }), client, fn, {
        fetchImpl,
        envImpl: baseEnv,
      }),
    ).rejects.toBeInstanceOf(QboTokenRefreshError)
    expect(fn).not.toHaveBeenCalled()
  })
})

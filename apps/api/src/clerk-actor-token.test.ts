import { describe, expect, it } from 'vitest'
import { actorTokenMinterFromEnv, createClerkActorTokenMinter } from './clerk-actor-token.js'

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(response: { ok?: boolean; status?: number; body?: unknown }) {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    } as Response
  }) as typeof fetch
  return { impl, calls }
}

describe('createClerkActorTokenMinter', () => {
  it('POSTs to /actor_tokens with user_id + actor.sub + expiry and returns the token', async () => {
    const { impl, calls } = fakeFetch({ body: { token: 'actor-tok-1' } })
    const mint = createClerkActorTokenMinter({ secretKey: 'sk_test_x', fetchImpl: impl })
    const result = await mint({ userId: 'user_subject', actorSub: 'user_admin', expiresInSeconds: 600 })

    expect(result).toEqual({ token: 'actor-tok-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.clerk.com/v1/actor_tokens')
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk_test_x')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      user_id: 'user_subject',
      actor: { sub: 'user_admin' },
      expires_in_seconds: 600,
    })
  })

  it('honors a custom CLERK_API_URL base (trailing slash stripped)', async () => {
    const { impl, calls } = fakeFetch({ body: { token: 't' } })
    const mint = createClerkActorTokenMinter({
      secretKey: 'sk',
      apiUrl: 'https://clerk.example.com/v1/',
      fetchImpl: impl,
    })
    await mint({ userId: 'u', actorSub: 'a', expiresInSeconds: 60 })
    expect(calls[0]!.url).toBe('https://clerk.example.com/v1/actor_tokens')
  })

  it('throws on a non-2xx response', async () => {
    const { impl } = fakeFetch({ ok: false, status: 422, body: {} })
    const mint = createClerkActorTokenMinter({ secretKey: 'sk', fetchImpl: impl })
    await expect(mint({ userId: 'u', actorSub: 'a', expiresInSeconds: 60 })).rejects.toThrow(/422/)
  })

  it('throws when the response is missing a token', async () => {
    const { impl } = fakeFetch({ body: {} })
    const mint = createClerkActorTokenMinter({ secretKey: 'sk', fetchImpl: impl })
    await expect(mint({ userId: 'u', actorSub: 'a', expiresInSeconds: 60 })).rejects.toThrow(/missing token/)
  })
})

describe('actorTokenMinterFromEnv', () => {
  it('returns null without CLERK_SECRET_KEY', () => {
    expect(actorTokenMinterFromEnv({})).toBeNull()
  })

  it('builds a minter when CLERK_SECRET_KEY is set', () => {
    expect(typeof actorTokenMinterFromEnv({ CLERK_SECRET_KEY: 'sk_live_x' })).toBe('function')
  })
})

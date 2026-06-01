/**
 * Clerk actor-token minter (design §7, OQ2) — the prod impersonation primitive.
 *
 * The exact sibling of the demo tier's sign-in-token minter
 * (`routes/demo.ts` → POST /v1/sign_in_tokens), but hits
 * `POST {base}/actor_tokens` with `{ user_id, actor: { sub }, expires_in_seconds }`.
 * The resulting Clerk session JWT carries an `act` claim that
 * `verifyClerkJwt` (auth.ts) reads into `Identity.actorUserId` — so a session
 * minted here is an audited impersonation: data scopes to `user_id`, every
 * mutation is tagged `impersonated_by = actor.sub`.
 *
 * `fetchImpl` is injectable so the endpoint + tests don't make real network
 * calls; production passes the global `fetch`.
 */

export interface ActorTokenResult {
  token: string
}

export interface ActorTokenMinterOptions {
  secretKey: string
  apiUrl?: string | null
  fetchImpl?: typeof fetch
}

export interface ActorTokenRequest {
  /** The user to impersonate (the session subject; data scopes to this). */
  userId: string
  /** The real admin doing the impersonating (lands in the JWT `act` claim). */
  actorSub: string
  expiresInSeconds: number
}

export type ActorTokenMinter = (req: ActorTokenRequest) => Promise<ActorTokenResult>

export function createClerkActorTokenMinter(opts: ActorTokenMinterOptions): ActorTokenMinter {
  const base = (opts.apiUrl?.trim() || 'https://api.clerk.com/v1').replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  return async ({ userId, actorSub, expiresInSeconds }) => {
    const res = await fetchImpl(`${base}/actor_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        actor: { sub: actorSub },
        expires_in_seconds: expiresInSeconds,
      }),
    })
    if (!res.ok) {
      throw new Error(`clerk actor_tokens failed: ${res.status}`)
    }
    const minted = (await res.json()) as { token?: unknown }
    if (typeof minted.token !== 'string' || !minted.token) {
      throw new Error('clerk actor_token response missing token')
    }
    return { token: minted.token }
  }
}

/**
 * Build a minter from the environment, or null if CLERK_SECRET_KEY is unset
 * (impersonation is simply unavailable then — the endpoint returns 501).
 */
export function actorTokenMinterFromEnv(env: NodeJS.ProcessEnv = process.env): ActorTokenMinter | null {
  const secretKey = env.CLERK_SECRET_KEY?.trim()
  if (!secretKey) return null
  return createClerkActorTokenMinter({ secretKey, apiUrl: env.CLERK_API_URL })
}

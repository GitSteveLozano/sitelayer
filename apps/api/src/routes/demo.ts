import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AppTier } from '@sitelayer/config'

/**
 * Demo-tier magic-link sign-in.
 *
 * The demo tier (`APP_TIER=demo`, demo.preview.sitelayer.sandolab.xyz) runs
 * Clerk-ON, reusing the existing Clerk TEST instance whose CLERK_SECRET_KEY
 * lives in the droplet env. Because Clerk is configured, the dev
 * `x-sitelayer-act-as` bypass is inert (auth.ts only honours it when
 * `tier !== 'prod'` AND the SPA isn't on Clerk — and on the demo tier the SPA
 * IS on Clerk). So role-switching has to happen through real Clerk sessions.
 *
 * This route mints a Clerk **sign-in token** (Backend API
 * `POST /v1/sign_in_tokens`) for a seeded demo user mapped from a requested
 * role, then returns a redirect URL carrying `?__clerk_ticket=<token>`. The
 * SPA's ClerkProvider consumes the ticket on load and auto-signs-in as that
 * user. This is the supported "act as a seeded user without a password" path
 * when Clerk is configured (the dev header bypass is NOT available here).
 *
 * STRUCTURAL TIER GATE: every handler in this module returns `false`
 * (i.e. "not my route, keep walking → 404") unless `ctx.tier === 'demo'`.
 * On any other tier the `/api/demo/*` surface does not exist. The gate is
 * the first thing each branch checks and is unit-tested.
 *
 * The demo Clerk users themselves are created out-of-band by the operator
 * (phase 2). This code only looks them up by email and tolerates their
 * absence with a clear error.
 */

export type DemoRole = 'owner' | 'estimator' | 'foreman' | 'crew'

export const DEMO_ROLES: readonly DemoRole[] = ['owner', 'estimator', 'foreman', 'crew']
export const DEFAULT_DEMO_SIGN_IN_TOKEN_TTL_SECONDS = 24 * 60 * 60

/** A minted sign-in token, as returned by the Clerk Backend API. */
export type ClerkSignInToken = {
  /** The single-use ticket string to hand to the SPA via `?__clerk_ticket=`. */
  token: string
  /** Clerk user id the token signs in as (echoed back for diagnostics). */
  userId: string
}

/**
 * Inject-able seam so tests don't hit the network. Given a demo role, resolve
 * the seeded Clerk user (by email) and mint a sign-in token for them.
 * Returns `null` when the user does not exist (operator hasn't seeded yet) so
 * the route can surface a clear, actionable error instead of a 500.
 */
export type SignInTokenMinter = (role: DemoRole) => Promise<ClerkSignInToken | null>

export type DemoRouteCtx = {
  tier: AppTier
  /** Raw `DEMO_ACCESS_CODE` env value (may be null/empty when unset). */
  accessCode: string | null
  /**
   * App origin the SPA is served from (e.g.
   * https://demo.preview.sitelayer.sandolab.xyz). The returned ticket URL is
   * built against this so the browser lands back in-app with the ticket.
   */
  appOrigin: string
  /** Clerk sign-in token lifetime used by the minter, in seconds. */
  ticketTtlSeconds: number
  /** Mint a Clerk sign-in token for a role. Network-backed in prod, mocked in tests. */
  mintSignInToken: SignInTokenMinter
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<unknown>
  /** Stamp the X-Robots-Tag: noindex header on the response. */
  setNoIndexHeader: () => void
}

export function isDemoRole(value: unknown): value is DemoRole {
  return typeof value === 'string' && (DEMO_ROLES as readonly string[]).includes(value)
}

/** Human label for a demo role (shared by the email formatter + UI copy). */
export function demoRoleLabel(role: DemoRole): string {
  switch (role) {
    case 'owner':
      return 'Owner'
    case 'estimator':
      return 'Estimator'
    case 'foreman':
      return 'Foreman'
    case 'crew':
      return 'Crew'
  }
}

/** Constant-time access-code comparison. */
function accessCodeMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Build the env→email mapping for the demo roles. Each role maps to an env
 * override (`DEMO_USER_EMAIL_<ROLE>`) and falls back to
 * `demo-<role>@<DEMO_USER_EMAIL_DOMAIN>` (default domain
 * `demo.sitelayer.sandolab.xyz`).
 */
export function resolveDemoUserEmail(role: DemoRole, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`DEMO_USER_EMAIL_${role.toUpperCase()}`]?.trim()
  if (override) return override
  const domain = env.DEMO_USER_EMAIL_DOMAIN?.trim() || 'demo.sitelayer.sandolab.xyz'
  return `demo-${role}@${domain}`
}

export function resolveDemoSignInTokenTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEMO_SIGN_IN_TOKEN_TTL_SECONDS?.trim()
  if (!raw) return DEFAULT_DEMO_SIGN_IN_TOKEN_TTL_SECONDS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEMO_SIGN_IN_TOKEN_TTL_SECONDS

  return Math.max(DEFAULT_DEMO_SIGN_IN_TOKEN_TTL_SECONDS, Math.floor(parsed))
}

/**
 * Production minter: looks the seeded user up by email via the Clerk Backend
 * API, then mints a sign-in token. Returns `null` when no user matches the
 * mapped email (operator hasn't seeded the demo users yet).
 *
 * Implemented with a direct `fetch` (no SDK dependency in apps/api — matches
 * the no-framework house style) against `https://api.clerk.com/v1`.
 */
export function createClerkSignInTokenMinter(opts: {
  secretKey: string
  env?: NodeJS.ProcessEnv
  /** Token lifetime in seconds (default 24h for sendable demo emails). */
  expiresInSeconds?: number
  fetchImpl?: typeof fetch
}): SignInTokenMinter {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const expiresIn = opts.expiresInSeconds ?? DEFAULT_DEMO_SIGN_IN_TOKEN_TTL_SECONDS
  const base = (env.CLERK_API_URL?.trim() || 'https://api.clerk.com/v1').replace(/\/$/, '')
  const authHeaders = {
    authorization: `Bearer ${opts.secretKey}`,
    'content-type': 'application/json',
  }

  return async (role: DemoRole): Promise<ClerkSignInToken | null> => {
    const email = resolveDemoUserEmail(role, env)

    // 1. Resolve the seeded user by email.
    const lookupUrl = `${base}/users?email_address=${encodeURIComponent(email)}&limit=1`
    const lookupRes = await fetchImpl(lookupUrl, { method: 'GET', headers: authHeaders })
    if (!lookupRes.ok) {
      throw new Error(`clerk user lookup failed (${lookupRes.status})`)
    }
    const users = (await lookupRes.json()) as Array<{ id?: unknown }>
    const userId = Array.isArray(users) && typeof users[0]?.id === 'string' ? (users[0]!.id as string) : null
    if (!userId) {
      // Seeded user not found — let the route surface a clear 404.
      return null
    }

    // 2. Mint a single-use sign-in token for that user.
    const tokenRes = await fetchImpl(`${base}/sign_in_tokens`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ user_id: userId, expires_in_seconds: expiresIn }),
    })
    if (!tokenRes.ok) {
      throw new Error(`clerk sign_in_token mint failed (${tokenRes.status})`)
    }
    const minted = (await tokenRes.json()) as { token?: unknown }
    if (typeof minted.token !== 'string' || !minted.token) {
      throw new Error('clerk sign_in_token response missing token')
    }
    return { token: minted.token, userId }
  }
}

/**
 * Build the browser redirect URL. Clerk's `<SignIn>` component (mounted in
 * App.tsx's UnauthShell at `/sign-in`) auto-consumes a `__clerk_ticket` query
 * param on load and completes the sign-in with no password / email code, so
 * we hand the ticket to `/sign-in`. After the ticket is consumed Clerk's
 * `<SignedIn>` gate renders the app shell — the visitor lands in-app as the
 * mapped demo role.
 */
export function buildTicketRedirectUrl(appOrigin: string, token: string): string {
  const origin = appOrigin.replace(/\/$/, '')
  return `${origin}/sign-in?__clerk_ticket=${encodeURIComponent(token)}`
}

/**
 * Render a ready-to-send demo email (subject + body) from a minted link. Pure
 * so it can back both the `demo:email` CLI and the super-admin
 * `POST /api/admin/demo-link` surface. `now` is injectable for tests.
 */
export function formatDemoEmail(opts: {
  role: DemoRole
  name?: string | null
  link: string
  expiresInSeconds: number
  appOrigin: string
  accessCode: string | null
  now?: number
}): { subject: string; body: string; expiresAt: string; roleLabel: string } {
  const label = demoRoleLabel(opts.role)
  const nowMs = opts.now ?? Date.now()
  const expiresAtDate = new Date(nowMs + opts.expiresInSeconds * 1000)
  const greeting = opts.name?.trim() ? `Hi ${opts.name.trim()},` : 'Hi,'
  const hours = Math.round(opts.expiresInSeconds / 3600)
  const fallbackUrl = `${opts.appOrigin.replace(/\/$/, '')}/demo`
  const accessLine = opts.accessCode ? `Access code: ${opts.accessCode}\n` : ''

  const body = `${greeting}

Here is a one-click Sitelayer demo link as ${label}:
${opts.link}

It is valid for about ${hours} hours, until ${expiresAtDate.toLocaleString()}.

This is the demo environment with sample data only. Anything you change is disposable.

If the one-click link expires, use this fallback:
${fallbackUrl}
${accessLine}Choose: ${label}
`

  return { subject: 'Sitelayer demo link', body, expiresAt: expiresAtDate.toISOString(), roleLabel: label }
}

/**
 * The capability needed to mint sendable demo links from the super-admin
 * console. Only available on the demo tier (where the TEST-instance
 * `CLERK_SECRET_KEY` + seeded demo users live); `null` everywhere else, which
 * the admin route turns into a clear 409.
 */
export type DemoLinkCapability = {
  mintSignInToken: SignInTokenMinter
  appOrigin: string
  ttlSeconds: number
  accessCode: string | null
}

/**
 * Build the demo-link capability from the environment, mirroring the demo-tier
 * minter wired in `server.ts`. Returns `null` off the demo tier or when
 * `CLERK_SECRET_KEY` is unset (so the feature is structurally absent there).
 */
export function demoLinkCapabilityFromEnv(
  tier: AppTier | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DemoLinkCapability | null {
  if (tier !== 'demo') return null
  const secretKey = env.CLERK_SECRET_KEY?.trim()
  if (!secretKey) return null
  const ttlSeconds = resolveDemoSignInTokenTtlSeconds(env)
  return {
    mintSignInToken: createClerkSignInTokenMinter({ secretKey, env, expiresInSeconds: ttlSeconds }),
    appOrigin: env.DEMO_APP_ORIGIN?.trim() || 'https://demo.preview.sitelayer.sandolab.xyz',
    ttlSeconds,
    accessCode: env.DEMO_ACCESS_CODE?.trim() || null,
  }
}

/**
 * Demo-tier route handler. Structurally inert unless `ctx.tier === 'demo'`.
 *
 * Routes:
 *   POST /api/demo/sign-in-link  { role, accessCode } → { redirect_url }
 */
export async function handleDemoRoutes(req: http.IncomingMessage, url: URL, ctx: DemoRouteCtx): Promise<boolean> {
  // Hard tier gate: the entire /api/demo/* surface only exists on the demo
  // tier. On every other tier we return false so the dispatcher keeps
  // walking and the request ultimately 404s — the route is structurally
  // absent, not merely access-denied.
  if (ctx.tier !== 'demo') return false
  if (!url.pathname.startsWith('/api/demo/')) return false

  if (req.method === 'POST' && url.pathname === '/api/demo/sign-in-link') {
    ctx.setNoIndexHeader()

    // The access code must be configured for the route to do anything.
    const expected = ctx.accessCode?.trim()
    if (!expected) {
      ctx.sendJson(503, { error: 'demo sign-in not configured (DEMO_ACCESS_CODE unset)' })
      return true
    }

    let body: unknown
    try {
      body = await ctx.readBody()
    } catch {
      ctx.sendJson(400, { error: 'invalid JSON body' })
      return true
    }
    const payload = (body ?? {}) as { role?: unknown; accessCode?: unknown }

    const providedCode = typeof payload.accessCode === 'string' ? payload.accessCode : ''
    if (!providedCode || !accessCodeMatches(providedCode, expected)) {
      ctx.sendJson(401, { error: 'invalid access code' })
      return true
    }

    if (!isDemoRole(payload.role)) {
      ctx.sendJson(400, { error: `role must be one of ${DEMO_ROLES.join(', ')}` })
      return true
    }
    const role = payload.role

    let minted: ClerkSignInToken | null
    try {
      minted = await ctx.mintSignInToken(role)
    } catch {
      ctx.sendJson(502, { error: 'could not mint demo sign-in token' })
      return true
    }
    if (!minted) {
      ctx.sendJson(404, {
        error: `demo user for role "${role}" is not seeded yet — ask the operator to create it`,
      })
      return true
    }

    ctx.sendJson(200, {
      role,
      redirect_url: buildTicketRedirectUrl(ctx.appOrigin, minted.token),
      expires_in_seconds: ctx.ticketTtlSeconds,
    })
    return true
  }

  // Unknown /api/demo/* path on the demo tier — explicit 404 rather than
  // falling through to the authenticated cascade.
  ctx.setNoIndexHeader()
  ctx.sendJson(404, { error: 'not found' })
  return true
}

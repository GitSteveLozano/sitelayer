import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { handlePublicEstimateShareRoutes, type PublicEstimateShareCtx } from './estimate-shares-portal.js'
import type { PortalRateLimitKind, RateLimitRejection } from '../rate-limit.js'

// ---------------------------------------------------------------------------
// Per-share-token rate limiting on the public /api/portal/estimates/* surface.
//
// The surface is EXEMPT from the global per-user/per-IP limiter (a NAT-shared
// customer would collide with internal callers — see rate-limit.ts), so the
// only fairness lever is a per-token bucket applied inline in this handler. The
// check runs BEFORE token resolution / any DB work, so these tests assert the
// 429 short-circuit without standing up a working pool: a pool that throws on
// any query proves no DB call was made when the limiter blocks.
// ---------------------------------------------------------------------------

function throwingPool(): Pool {
  return {
    query: () => {
      throw new Error('pool.query must not run when the per-token limiter blocks')
    },
    connect: () => {
      throw new Error('pool.connect must not run when the per-token limiter blocks')
    },
  } as unknown as Pool
}

function makeCtx(rateLimitPortalToken?: (token: string, kind: PortalRateLimitKind) => RateLimitRejection | null): {
  ctx: PublicEstimateShareCtx
  responses: Array<{ status: number; body: unknown }>
  seenTokens: Array<{ token: string; kind: PortalRateLimitKind }>
} {
  const responses: Array<{ status: number; body: unknown }> = []
  const seenTokens: Array<{ token: string; kind: PortalRateLimitKind }> = []
  const ctx: PublicEstimateShareCtx = {
    pool: throwingPool(),
    shareSecret: 'test-secret',
    resolveClientIp: () => '203.0.113.9',
    readBody: async () => ({}),
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
  }
  if (rateLimitPortalToken) {
    ctx.rateLimitPortalToken = (token, kind) => {
      seenTokens.push({ token, kind })
      return rateLimitPortalToken(token, kind)
    }
  }
  return { responses, seenTokens, ctx }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function blockWith(scope: 'portal_read' | 'portal_write', retryAfterSeconds: number): RateLimitRejection {
  return { allowed: false, retryAfterSeconds, capacity: 1, scope, key: 'token' }
}

describe('handlePublicEstimateShareRoutes — per-token rate limiting', () => {
  it('429s accept (write) and never touches the DB', async () => {
    const { ctx, responses, seenTokens } = makeCtx((_t, kind) =>
      kind === 'write' ? blockWith('portal_write', 11) : null,
    )
    const handled = await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/portal/estimates/share-tok-1/accept'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]).toMatchObject({
      status: 429,
      body: { error: 'rate limit exceeded', scope: 'portal_write', retry_after_seconds: 11 },
    })
    expect(seenTokens).toEqual([{ token: 'share-tok-1', kind: 'write' }])
  })

  it('429s decline (write) and never touches the DB', async () => {
    const { ctx, responses } = makeCtx((_t, kind) => (kind === 'write' ? blockWith('portal_write', 5) : null))
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/portal/estimates/share-tok-1/decline'),
      ctx,
    )
    expect(responses[0]).toMatchObject({
      status: 429,
      body: { scope: 'portal_write', retry_after_seconds: 5 },
    })
  })

  it('429s a capture-session start (write)', async () => {
    const { ctx, responses } = makeCtx((_t, kind) => (kind === 'write' ? blockWith('portal_write', 9) : null))
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/portal/estimates/share-tok-1/capture-sessions'),
      ctx,
    )
    expect(responses[0]).toMatchObject({ status: 429, body: { scope: 'portal_write' } })
  })

  it('429s the GET portal view (read)', async () => {
    const { ctx, responses, seenTokens } = makeCtx((_t, kind) => (kind === 'read' ? blockWith('portal_read', 4) : null))
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/portal/estimates/share-tok-1'),
      ctx,
    )
    expect(responses[0]).toMatchObject({
      status: 429,
      body: { error: 'rate limit exceeded', scope: 'portal_read', retry_after_seconds: 4 },
    })
    expect(seenTokens).toEqual([{ token: 'share-tok-1', kind: 'read' }])
  })

  it('decodes the URL-encoded token before limiting (the same key the customer hits)', async () => {
    const { ctx, seenTokens } = makeCtx(() => blockWith('portal_write', 1))
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/portal/estimates/tok%2Bwith%2Fchars/accept'),
      ctx,
    )
    expect(seenTokens[0]?.token).toBe('tok+with/chars')
  })

  it('proceeds past the limiter when it allows (a token-verification 401, not a 429)', async () => {
    // limiter returns null → handler proceeds → the unsigned token is rejected
    // downstream with 401 (verifyShareToken fails before any DB query). The key
    // assertion is that the outcome is NOT a 429 — the limiter let it through.
    const { ctx, responses } = makeCtx(() => null)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/portal/estimates/unsigned-token'),
      ctx,
    )
    expect(responses[0]?.status).toBe(401)
  })

  it('is inert when no limiter is wired (route unit tests / non-portal deployments)', async () => {
    // No rateLimitPortalToken → the handler proceeds normally (here the unsigned
    // token 401s downstream), never silently 429.
    const { ctx, responses } = makeCtx(undefined)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/portal/estimates/unsigned-token'),
      ctx,
    )
    expect(responses[0]?.status).toBe(401)
  })
})

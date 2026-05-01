import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { isValidUuid } from '../http-utils.js'

export type PushSubscriptionRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /** From process.env.VAPID_PUBLIC_KEY. Null when push isn't configured. */
  vapidPublicKey: string | null
}

type PushSubscriptionRow = {
  id: string
  company_id: string
  clerk_user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

/**
 * Web Push subscription routes.
 *
 * - GET    /api/push/vapid-public-key       PWA reads this before subscribing
 * - POST   /api/push/subscriptions          upsert (clerk_user_id + endpoint)
 * - DELETE /api/push/subscriptions/:id      remove on logout / uninstall
 *
 * The worker (Phase 1C notification channel router) reads
 * push_subscriptions to deliver Web Push payloads. Endpoints stale
 * out naturally when the browser revokes — a 410 Gone from the push
 * service is the worker's signal to delete the row.
 */
export async function handlePushSubscriptionRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PushSubscriptionRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/push/vapid-public-key') {
    if (!ctx.vapidPublicKey) {
      ctx.sendJson(503, { error: 'push not configured' })
      return true
    }
    ctx.sendJson(200, { vapidPublicKey: ctx.vapidPublicKey })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/push/subscriptions') {
    const body = await ctx.readBody()
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
    const p256dh = typeof body.p256dh === 'string' ? body.p256dh.trim() : ''
    const auth = typeof body.auth === 'string' ? body.auth.trim() : ''
    const userAgent =
      typeof body.user_agent === 'string'
        ? body.user_agent.slice(0, 500)
        : (req.headers['user-agent']?.toString().slice(0, 500) ?? null)
    if (!endpoint || !p256dh || !auth) {
      ctx.sendJson(400, { error: 'endpoint, p256dh, and auth are required' })
      return true
    }
    if (endpoint.length > 2048) {
      ctx.sendJson(400, { error: 'endpoint too long' })
      return true
    }

    const upsert = await ctx.pool.query<PushSubscriptionRow>(
      `insert into push_subscriptions
         (company_id, clerk_user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (clerk_user_id, endpoint) do update
         set p256dh = excluded.p256dh,
             auth   = excluded.auth,
             user_agent = excluded.user_agent,
             last_seen_at = now()
       returning id, company_id, clerk_user_id, endpoint, p256dh, auth,
                 user_agent, created_at, last_seen_at`,
      [ctx.company.id, ctx.currentUserId, endpoint, p256dh, auth, userAgent],
    )
    ctx.sendJson(201, { subscription: upsert.rows[0] })
    return true
  }

  const deleteMatch = url.pathname.match(/^\/api\/push\/subscriptions\/([^/]+)$/)
  if (req.method === 'DELETE' && deleteMatch) {
    const id = deleteMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const deleted = await ctx.pool.query(
      `delete from push_subscriptions
         where company_id = $1 and id = $2 and clerk_user_id = $3
         returning id`,
      [ctx.company.id, id, ctx.currentUserId],
    )
    if (deleted.rowCount === 0) {
      ctx.sendJson(404, { error: 'subscription not found' })
      return true
    }
    ctx.sendJson(200, { ok: true })
    return true
  }

  return false
}

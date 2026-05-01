import type http from 'node:http'
import type { Pool } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { formatMoney } from '@sitelayer/domain'
import type { AppTier } from '@sitelayer/config'
import { CORS_ALLOW_HEADERS } from '../http-utils.js'
import { extractSvixHeaders, verifyClerkWebhook } from '../clerk-webhook.js'
import {
  extractIntuitSignature,
  flattenQboWebhookPayload,
  parseQboWebhookPayload,
  verifyQboWebhook,
} from '../qbo-webhook.js'
import { renderMetrics } from '../metrics.js'

const logger = createLogger('api:public')

/**
 * Pre-auth route handlers. These run BEFORE Clerk identity resolution and
 * rate limiting because:
 *   - OPTIONS is a CORS preflight; browsers send no Bearer.
 *   - /health is what Caddy probes; it must respond even if auth is wedged.
 *   - /api/version + /api/features are static metadata for the SPA bootstrap.
 *   - /api/metrics is gated by API_METRICS_TOKEN (Bearer realm separate from
 *     user JWTs).
 *   - /api/webhooks/clerk + /api/webhooks/qbo are HMAC/svix-verified, not
 *     Bearer; identity resolution would 401 their providers.
 *
 * Returning true means "the dispatcher should consider the request handled
 * and stop walking." Order is preserved from the inline cascade in
 * server.ts.
 */
export type PublicRouteCtx = {
  pool: Pool
  tier: AppTier
  buildSha: string
  startedAt: string
  metricsToken: string | null
  clerkWebhookSecret: string | null
  qboWebhookVerifier: string | null
  pgHealthProbeTimeoutMs: number
  /**
   * Snapshot of `appConfig.flags` + `appConfig.ribbon` for the
   * `/api/features` response. Resolved by server.ts so this module doesn't
   * need to import `tier.ts`.
   */
  features: {
    flags: Iterable<string>
    ribbon: unknown
  }
  /** Resolved CORS allow-origin for the current request. */
  getCorsOrigin: () => string
  sendJson: (status: number, body: unknown) => void
  /** Read the raw request body (no JSON parse) for HMAC/svix verification. */
  readRawBody: () => Promise<string>
}

export async function handlePublicRoutes(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  ctx: PublicRouteCtx,
): Promise<boolean> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ctx.getCorsOrigin(),
      'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': CORS_ALLOW_HEADERS,
    })
    res.end()
    return true
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    // Race the pg probe against PG_HEALTH_PROBE_TIMEOUT_MS so a wedged
    // pool can't pin /health open for the default 30s socket timeout.
    const probe = await Promise.race([
      ctx.pool
        .query('select 1 as ok')
        .then(() => ({ db: 'healthy' as const, error: null as string | null }))
        .catch((err) => ({
          db: 'down' as const,
          error: err instanceof Error ? err.message : String(err),
        })),
      new Promise<{ db: 'timeout'; error: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              db: 'timeout',
              error: `db probe exceeded ${ctx.pgHealthProbeTimeoutMs}ms`,
            }),
          ctx.pgHealthProbeTimeoutMs,
        ),
      ),
    ])
    const ok = probe.db === 'healthy'
    const status = ok ? 200 : 503
    if (req.method === 'HEAD') {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': ctx.getCorsOrigin(),
        'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': CORS_ALLOW_HEADERS,
      })
      res.end()
      return true
    }
    ctx.sendJson(status, {
      ok,
      service: 'api',
      tier: ctx.tier,
      build_sha: ctx.buildSha,
      started_at: ctx.startedAt,
      db: probe,
      money: formatMoney(1234.56),
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/version') {
    ctx.sendJson(200, {
      service: 'api',
      tier: ctx.tier,
      build_sha: ctx.buildSha,
      started_at: ctx.startedAt,
      node_version: process.version,
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    if (ctx.metricsToken) {
      const header = req.headers['authorization']
      const value = Array.isArray(header) ? header[0] : header
      const presented = value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null
      if (!presented || presented !== ctx.metricsToken) {
        res.setHeader('www-authenticate', 'Bearer realm="sitelayer-metrics"')
        ctx.sendJson(401, { error: 'metrics token required' })
        return true
      }
    }
    const { contentType, body } = await renderMetrics()
    res.writeHead(200, {
      'content-type': contentType,
      'access-control-allow-origin': ctx.getCorsOrigin(),
    })
    res.end(body)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/features') {
    // Static config response — let the SPA cache for a few minutes so a
    // refresh doesn't refetch the same flags. private because the body is
    // per-tier (and could differ per company once flags become company-scoped).
    res.setHeader('Cache-Control', 'private, max-age=300')
    ctx.sendJson(200, {
      tier: ctx.tier,
      flags: Array.from(ctx.features.flags).sort(),
      ribbon: ctx.features.ribbon,
    })
    return true
  }

  // /api/webhooks/clerk — Svix-signed Clerk webhook. No Bearer/JWT.
  // Must run before identity resolution.
  if (req.method === 'POST' && url.pathname === '/api/webhooks/clerk') {
    if (!ctx.clerkWebhookSecret) {
      ctx.sendJson(503, { error: 'CLERK_WEBHOOK_SECRET not configured' })
      return true
    }
    const raw = await ctx.readRawBody()
    const result = verifyClerkWebhook(raw, extractSvixHeaders(req.headers), ctx.clerkWebhookSecret)
    if (!result.ok) {
      logger.warn({ err: result.error }, '[clerk-webhook] verification failed')
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    const { type, data } = result.event
    const subjectId = typeof data.id === 'string' ? data.id : null
    logger.info({ event: type, subjectId }, '[clerk-webhook] received')
    switch (type) {
      case 'user.created':
      case 'user.updated':
        // Mirror table TBD; intentionally a no-op until the schema lands.
        break
      case 'user.deleted':
        // Don't cascade-delete memberships; preserve audit trail by leaving
        // company_memberships intact. Future: nullify actor on audit_events.
        logger.info({ subjectId }, '[clerk-webhook] user.deleted — no-op (audit trail preserved)')
        break
      case 'session.created':
        break
      default:
        logger.debug({ event: type }, '[clerk-webhook] ignored event type')
    }
    // 204 keeps the webhook fast and signals "received, nothing to send".
    res.writeHead(204, { 'access-control-allow-origin': ctx.getCorsOrigin() })
    res.end()
    return true
  }

  // /api/webhooks/qbo — Intuit HMAC-signed webhook. No Bearer/JWT.
  // Public path — runs before identity resolution so Intuit's
  // unauthenticated POSTs aren't rejected as 401.
  if (req.method === 'POST' && url.pathname === '/api/webhooks/qbo') {
    if (!ctx.qboWebhookVerifier) {
      ctx.sendJson(503, { error: 'QBO_WEBHOOK_VERIFIER not configured' })
      return true
    }
    const raw = await ctx.readRawBody()
    const signature = extractIntuitSignature(req.headers as Record<string, unknown>)
    const verify = verifyQboWebhook(raw, signature, ctx.qboWebhookVerifier)
    if (!verify.ok) {
      logger.warn({ err: verify.error, status: verify.status }, '[qbo-webhook] verification failed')
      ctx.sendJson(verify.status, { error: verify.error })
      return true
    }
    const parsed = parseQboWebhookPayload(raw)
    if (!parsed.ok) {
      logger.warn({ err: parsed.error }, '[qbo-webhook] payload parse failed')
      ctx.sendJson(parsed.status, { error: parsed.error })
      return true
    }
    const events = flattenQboWebhookPayload(parsed.payload)
    // We resolve each realm → integration_connection → company_id. If a
    // realm we've never connected sends us a webhook, we log and drop those
    // events rather than fabricating a company.
    const realmIds = Array.from(new Set(events.map((e) => e.realmId)))
    const connectionMap = new Map<string, { companyId: string; connectionId: string }>()
    for (const realmId of realmIds) {
      const result = await ctx.pool.query<{ company_id: string; id: string }>(
        `select company_id, id from integration_connections
         where provider = 'qbo' and provider_account_id = $1
         order by created_at desc limit 1`,
        [realmId],
      )
      const row = result.rows[0]
      if (row) connectionMap.set(realmId, { companyId: row.company_id, connectionId: row.id })
    }
    let persisted = 0
    let skipped = 0
    for (const event of events) {
      const conn = connectionMap.get(event.realmId)
      if (!conn) {
        skipped += 1
        continue
      }
      await ctx.pool.query(
        `insert into sync_events (
           company_id, integration_connection_id, direction, entity_type, entity_id, payload, status
         ) values ($1, $2, 'inbound', $3, $4, $5::jsonb, 'pending')`,
        [
          conn.companyId,
          conn.connectionId,
          event.entityType,
          event.entityId,
          JSON.stringify({
            source: 'qbo_webhook',
            realmId: event.realmId,
            operation: event.operation,
            lastUpdated: event.lastUpdated,
            raw: event.raw,
          }),
        ],
      )
      persisted += 1
    }
    logger.info({ persisted, skipped, realms: realmIds.length }, '[qbo-webhook] received')
    // 200 quickly; the worker will pull entity details asynchronously.
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ctx.getCorsOrigin(),
    })
    res.end(JSON.stringify({ ok: true, persisted, skipped }))
    return true
  }

  return false
}

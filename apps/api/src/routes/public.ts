import type http from 'node:http'
import { withMutationTx } from '../mutation-tx.js'
import type { Pool } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { formatMoney } from '@sitelayer/domain'
import type { AppTier } from '@sitelayer/config'
import { CORS_ALLOW_HEADERS } from '../http-utils.js'
import { extractSvixHeaders, verifyClerkWebhook } from '../clerk-webhook.js'
import { captureWithEntityContext } from '../instrument.js'
import {
  extractIntuitSignature,
  flattenQboWebhookPayload,
  parseQboWebhookPayload,
  verifyQboWebhook,
} from '../qbo-webhook.js'
import { renderMetrics } from '../metrics.js'

const logger = createLogger('api:public')

/**
 * Extract the primary email from a Clerk user payload. Clerk sends an
 * `email_addresses` array plus a `primary_email_address_id` pointing at the
 * preferred entry; fall back to the first address if the pointer is missing.
 */
function extractPrimaryEmail(data: Record<string, unknown>): string | null {
  const addresses = Array.isArray(data.email_addresses) ? data.email_addresses : []
  const primaryId = typeof data.primary_email_address_id === 'string' ? data.primary_email_address_id : null
  const rows = addresses.filter(
    (a): a is { id?: unknown; email_address?: unknown } => typeof a === 'object' && a !== null,
  )
  const primary = primaryId ? rows.find((a) => a.id === primaryId) : undefined
  const chosen = primary ?? rows[0]
  const email = chosen?.email_address
  return typeof email === 'string' && email.length > 0 ? email : null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Clerk reports created_at / updated_at as epoch milliseconds. Convert to an
 * ISO string Postgres can cast to timestamptz; null when absent/invalid.
 */
function clerkEpochToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Upsert a Clerk identity into the clerk_users mirror. Runs at the pool with
 * no company GUC — clerk_users is a global directory, not company-scoped.
 *
 * Expand/backfill/contract tolerance: if the migration hasn't applied yet the
 * table won't exist and the insert throws `42P01` (undefined_table). We log
 * and swallow that specific case so an in-flight rollout (new code, old
 * schema) returns 204 to Clerk instead of 500ing and triggering Svix retries.
 */
async function upsertClerkUser(pool: Pool, clerkUserId: string, data: Record<string, unknown>): Promise<void> {
  const email = extractPrimaryEmail(data)
  const firstName = asNullableString(data.first_name)
  const lastName = asNullableString(data.last_name)
  const imageUrl = asNullableString(data.image_url) ?? asNullableString(data.profile_image_url)
  const clerkCreatedAt = clerkEpochToIso(data.created_at)
  const clerkUpdatedAt = clerkEpochToIso(data.updated_at)
  try {
    await pool.query(
      `insert into clerk_users (
         clerk_user_id, email, first_name, last_name, image_url,
         clerk_created_at, clerk_updated_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (clerk_user_id) do update set
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         image_url = excluded.image_url,
         clerk_created_at = coalesce(excluded.clerk_created_at, clerk_users.clerk_created_at),
         clerk_updated_at = excluded.clerk_updated_at,
         updated_at = now(),
         deleted_at = null`,
      [clerkUserId, email, firstName, lastName, imageUrl, clerkCreatedAt, clerkUpdatedAt],
    )
  } catch (err) {
    if (isMissingClerkUsersTable(err)) {
      logger.warn({ clerkUserId }, '[clerk-webhook] clerk_users table absent — skipping mirror (rollout in progress)')
      return
    }
    throw err
  }
}

/**
 * Soft-delete a mirror row on user.deleted. Tolerant of the table being absent
 * during rollout, same as upsertClerkUser.
 */
async function softDeleteClerkUser(pool: Pool, clerkUserId: string): Promise<void> {
  try {
    await pool.query(
      `update clerk_users set deleted_at = now(), updated_at = now()
       where clerk_user_id = $1 and deleted_at is null`,
      [clerkUserId],
    )
  } catch (err) {
    if (isMissingClerkUsersTable(err)) {
      logger.warn(
        { clerkUserId },
        '[clerk-webhook] clerk_users table absent — skipping soft-delete (rollout in progress)',
      )
      return
    }
    throw err
  }
}

/** Postgres error code 42P01 = undefined_table (migration not yet applied). */
function isMissingClerkUsersTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42P01'
}

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
    /**
     * Whether the live blueprint AI sheet-read path is available on this API
     * (BLUEPRINT_VISION_MODE=live + ANTHROPIC_API_KEY). The SPA gates whether
     * to stream a multipart PDF for a real Claude-vision read on this; when
     * false it stays on the dry-run/demo capture path. Optional so an older
     * server.ts that doesn't resolve it still type-checks (defaults to false).
     */
    blueprintVisionLive?: boolean
    /**
     * Whether the in-app operator AI chat is configured on this deployment
     * (see mesh-dispatcher.ts isAiChatEnabled()). The operator-context chat
     * widget reads this to hide its composer when false, so a deployment
     * with no mesh access never offers a chat that would only ever time
     * out. Optional so an older server.ts still type-checks (defaults to
     * false — fail closed: a deployment that can't report the flag is
     * treated as not configured).
     */
    aiChatEnabled?: boolean
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
      // Live blueprint AI sheet-read availability (C1 follow-up). Additive —
      // the SPA reads this to decide whether to stream a multipart PDF for a
      // real Claude-vision read vs. the dry-run/demo path.
      blueprint_vision_live: ctx.features.blueprintVisionLive ?? false,
      // In-app operator AI chat availability. Additive — the
      // operator-context chat widget reads this to hide its composer when
      // the chat isn't configured (no mesh access), so it never offers a
      // chat that would only ever time out.
      ai_chat_enabled: ctx.features.aiChatEnabled ?? false,
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
      captureWithEntityContext(new Error(`clerk webhook verification failed: ${result.error}`), {
        scope: 'clerk_webhook_verification',
        entity_type: 'clerk_webhook',
      })
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    const { type, data } = result.event
    const subjectId = typeof data.id === 'string' ? data.id : null
    logger.info({ event: type, subjectId }, '[clerk-webhook] received')
    switch (type) {
      case 'user.created':
      case 'user.updated':
        // Mirror the Clerk identity into clerk_users so invited members are
        // known to the app before they manually onboard. This is the global
        // identity directory; per-company role still lives in
        // company_memberships and is written elsewhere.
        //
        // Welcome email is intentionally NOT enqueued here. It fires
        // from POST /api/companies once the user has finished onboarding
        // and we have a real company_id to scope the outbox row against
        // (mutation_outbox is keyed by company_id). Triggering here
        // would require a pre-tenancy outbox path and would also send a
        // welcome before the user has anything to welcome them to. See
        // routes/companies.ts → recordMutationOutbox(..., 'welcome_email', ...).
        if (subjectId) {
          await upsertClerkUser(ctx.pool, subjectId, data)
        }
        break
      case 'user.deleted':
        // Soft-delete the mirror row (set deleted_at) but DON'T cascade-delete
        // memberships; preserve the audit trail by leaving company_memberships
        // and audit_events intact. Future: nullify actor on audit_events.
        if (subjectId) {
          await softDeleteClerkUser(ctx.pool, subjectId)
        }
        logger.info({ subjectId }, '[clerk-webhook] user.deleted — soft-deleted mirror (memberships preserved)')
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
      // QBO webhook is inherently cross-company (the realmId resolves to a
      // company); the lookup runs at the pool without a company GUC set, so
      // RLS stays permissive for this admin-style lookup.
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
      // sync_events insert is scoped to the connection's resolved company.
      // Bind app.company_id explicitly so the row passes RLS once enforced.
      await withMutationTx(conn.companyId, (c) =>
        c.query(
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
        ),
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

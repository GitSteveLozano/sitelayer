import type http from 'node:http'
import type { Pool } from 'pg'
import { processQueue as processDatabaseQueue } from '@sitelayer/queue'
import type { ActiveCompany } from '../auth-types.js'

export type SyncRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

async function countQueueRows(pool: Pool, companyId: string) {
  const [outboxResult, syncResult] = await Promise.all([
    pool.query<{ pending_count: number }>(
      `
      select count(*)::int as pending_count
      from mutation_outbox
      where company_id = $1
        and status in ('pending', 'processing')
      `,
      [companyId],
    ),
    pool.query<{ pending_count: number }>(
      `
      select count(*)::int as pending_count
      from sync_events
      where company_id = $1
        and status in ('pending', 'processing')
      `,
      [companyId],
    ),
  ])
  return {
    pendingOutboxCount: outboxResult.rows[0]?.pending_count ?? 0,
    pendingSyncEventCount: syncResult.rows[0]?.pending_count ?? 0,
  }
}

export async function getSyncStatus(pool: Pool, companyId: string) {
  const queue = await countQueueRows(pool, companyId)
  const [connections, latestSyncEvent] = await Promise.all([
    pool.query(
      `
      select id, provider, provider_account_id, sync_cursor, last_synced_at, status, version, created_at
      from integration_connections
      where company_id = $1
      order by created_at asc
      `,
      [companyId],
    ),
    pool.query(
      `
      select created_at, entity_type, entity_id, direction, status, attempt_count, applied_at, error
      from sync_events
      where company_id = $1
      order by created_at desc
      limit 1
      `,
      [companyId],
    ),
  ])

  return {
    ...queue,
    connections: connections.rows,
    latestSyncEvent: latestSyncEvent.rows[0] ?? null,
  }
}

/**
 * Handle /api/sync/* requests:
 * - GET  /api/sync/status   — connection state, queue depths, latest event
 * - POST /api/sync/process  — manual queue drain (admin/office)
 * - GET  /api/sync/events   — recent sync_events ledger
 * - GET  /api/sync/outbox   — recent mutation_outbox ledger
 */
export async function handleSyncRoutes(req: http.IncomingMessage, url: URL, ctx: SyncRouteCtx): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/sync/status') {
    ctx.sendJson(200, {
      company: ctx.company,
      ...(await getSyncStatus(ctx.pool, ctx.company.id)),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/process') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 25)))
    ctx.sendJson(200, await processDatabaseQueue(ctx.pool, ctx.company.id, limit))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/events') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)))
    const result = await ctx.pool.query(
      `
      select id, integration_connection_id, direction, entity_type, entity_id, payload, status, attempt_count, next_attempt_at, applied_at, error, created_at
      from sync_events
      where company_id = $1
      order by created_at desc
      limit $2
      `,
      [ctx.company.id, limit],
    )
    ctx.sendJson(200, { events: result.rows })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/outbox') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)))
    const result = await ctx.pool.query(
      `
      select
        id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload,
        idempotency_key, status, attempt_count, next_attempt_at, applied_at, error, created_at
      from mutation_outbox
      where company_id = $1
      order by created_at desc
      limit $2
      `,
      [ctx.company.id, limit],
    )
    ctx.sendJson(200, { outbox: result.rows })
    return true
  }

  return false
}

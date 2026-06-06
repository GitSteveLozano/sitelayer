import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { buildPaginationMeta, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import { withCompanyClient } from '../mutation-tx.js'

export type AuditEventRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

type AuditFilters = {
  entityType?: string | null
  entityId?: string | null
  actorUserId?: string | null
  since?: string | null
  limit: number
  offset: number
}

async function listAuditEvents(_pool: Pool, companyId: string, filters: AuditFilters) {
  const clauses: string[] = ['company_id = $1']
  const values: unknown[] = [companyId]
  if (filters.entityType) {
    values.push(filters.entityType)
    clauses.push(`entity_type = $${values.length}`)
  }
  if (filters.entityId) {
    values.push(filters.entityId)
    clauses.push(`entity_id = $${values.length}`)
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId)
    clauses.push(`actor_user_id = $${values.length}`)
  }
  if (filters.since) {
    values.push(filters.since)
    clauses.push(`created_at >= $${values.length}::timestamptz`)
  }
  values.push(filters.limit)
  values.push(filters.offset)
  const result = await withCompanyClient(companyId, (c) =>
    c.query(
      `select id, actor_user_id, actor_role, entity_type, entity_id, action, before, after, request_id, sentry_trace, created_at
     from audit_events
     where ${clauses.join(' and ')}
     order by created_at desc
     limit $${values.length - 1} offset $${values.length}`,
      values,
    ),
  )
  return result
}

/**
 * Handle GET /api/audit-events. Admin-only; supports entity_type,
 * entity_id, actor_user_id, since, limit, offset query filters.
 *
 * Pagination defaults to limit=100, max=500 per the unbounded-list
 * hardening pass (the prior default of 1000 was halved in favor of the
 * shared cap; the higher ceiling is still reachable via ?limit=).
 */
export async function handleAuditEventRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AuditEventRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/audit-events') {
    if (!ctx.requireRole(['admin'])) return true
    const pagination = parsePagination(url.searchParams, { maxLimit: PAGINATION_MAX_LIMIT })
    if (!pagination.ok) {
      ctx.sendJson(400, { error: pagination.error })
      return true
    }
    const result = await listAuditEvents(ctx.pool, ctx.company.id, {
      entityType: url.searchParams.get('entity_type'),
      entityId: url.searchParams.get('entity_id'),
      actorUserId: url.searchParams.get('actor_user_id'),
      since: url.searchParams.get('since'),
      limit: pagination.value.limit,
      offset: pagination.value.offset,
    })
    ctx.sendJson(200, {
      events: result.rows,
      pagination: buildPaginationMeta(pagination.value, result.rowCount ?? result.rows.length),
    })
    return true
  }

  return false
}

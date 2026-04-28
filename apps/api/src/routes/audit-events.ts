import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'

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
  limit?: number
}

async function listAuditEvents(pool: Pool, companyId: string, filters: AuditFilters) {
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
  const limit = Math.max(1, Math.min(1000, filters.limit ?? 200))
  values.push(limit)
  const result = await pool.query(
    `select id, actor_user_id, actor_role, entity_type, entity_id, action, before, after, request_id, sentry_trace, created_at
     from audit_events
     where ${clauses.join(' and ')}
     order by created_at desc
     limit $${values.length}`,
    values,
  )
  return result.rows
}

/**
 * Handle GET /api/audit-events. Admin-only; supports entity_type,
 * entity_id, actor_user_id, since, limit query filters.
 */
export async function handleAuditEventRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AuditEventRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/audit-events') {
    if (!ctx.requireRole(['admin'])) return true
    const limitParam = url.searchParams.get('limit')
    const events = await listAuditEvents(ctx.pool, ctx.company.id, {
      entityType: url.searchParams.get('entity_type'),
      entityId: url.searchParams.get('entity_id'),
      actorUserId: url.searchParams.get('actor_user_id'),
      since: url.searchParams.get('since'),
      ...(limitParam ? { limit: Number(limitParam) } : {}),
    })
    ctx.sendJson(200, { events })
    return true
  }

  return false
}

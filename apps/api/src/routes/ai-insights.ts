import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'

export type AiInsightRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const INSIGHT_COLUMNS = `
  id, company_id, kind, entity_type, entity_id, payload, confidence,
  attribution, source_run_id, produced_by, applied_at, applied_by,
  dismissed_at, dismissed_by, dismiss_reason, created_at, updated_at
`

interface InsightRow {
  id: string
  company_id: string
  kind: string
  entity_type: string
  entity_id: string | null
  payload: unknown
  confidence: 'low' | 'med' | 'high'
  attribution: string
  source_run_id: string | null
  produced_by: string
  applied_at: string | null
  applied_by: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismiss_reason: string | null
  created_at: string
  updated_at: string
}

/**
 * AI Layer insight surfaces (Phase 5).
 *
 *   GET    /api/ai/insights?kind=&open=1            list per-company
 *   POST   /api/ai/insights/:id/dismiss             dismiss with reason
 *   POST   /api/ai/insights/:id/apply               mark applied
 *   POST   /api/ai/agents/takeoff-to-bid            enqueue agent run
 *
 * Dismiss-as-signal: every dismissal records the actor + reason so the
 * agent loop can train. Per the design rule, never silently drop.
 */
export async function handleAiInsightRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AiInsightRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/ai/insights') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const kind = String(url.searchParams.get('kind') ?? '').trim()
    const open = url.searchParams.get('open') === '1'
    const entityId = String(url.searchParams.get('entity_id') ?? '').trim()
    if (entityId && !isValidUuid(entityId)) {
      ctx.sendJson(400, { error: 'entity_id must be a valid uuid' })
      return true
    }
    const result = await ctx.pool.query<InsightRow>(
      `select ${INSIGHT_COLUMNS}
       from ai_insights
       where company_id = $1
         and ($2 = '' or kind = $2)
         and ($3 = '' or entity_id = $3::uuid)
         and ($4::boolean is false or (applied_at is null and dismissed_at is null))
       order by created_at desc
       limit 200`,
      [ctx.company.id, kind, entityId, open],
    )
    ctx.sendJson(200, { insights: result.rows })
    return true
  }

  const dismissMatch = url.pathname.match(/^\/api\/ai\/insights\/([^/]+)\/dismiss$/)
  if (req.method === 'POST' && dismissMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = dismissMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InsightRow>(
        `update ai_insights
           set dismissed_at = now(),
               dismissed_by = $3,
               dismiss_reason = $4,
               updated_at = now()
         where company_id = $1 and id = $2 and dismissed_at is null and applied_at is null
         returning ${INSIGHT_COLUMNS}`,
        [ctx.company.id, id, ctx.currentUserId, reason],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'ai_insight',
        entityId: row.id,
        action: 'dismiss',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'insight not found or already resolved' })
      return true
    }
    ctx.sendJson(200, { insight: updated })
    return true
  }

  const applyMatch = url.pathname.match(/^\/api\/ai\/insights\/([^/]+)\/apply$/)
  if (req.method === 'POST' && applyMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = applyMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InsightRow>(
        `update ai_insights
           set applied_at = now(),
               applied_by = $3,
               updated_at = now()
         where company_id = $1 and id = $2 and applied_at is null and dismissed_at is null
         returning ${INSIGHT_COLUMNS}`,
        [ctx.company.id, id, ctx.currentUserId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'ai_insight',
        entityId: row.id,
        action: 'apply',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'insight not found or already resolved' })
      return true
    }
    ctx.sendJson(200, { insight: updated })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/agents/takeoff-to-bid') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id is required and must be a valid uuid' })
      return true
    }
    const projectExists = await ctx.pool.query<{ id: string }>(
      `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
      [ctx.company.id, projectId],
    )
    if (!projectExists.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    // Enqueue an outbox row — the worker drains
    // mutation_type = 'takeoff_to_bid' rows and runs the agent.
    // Stable idempotency_key per project means re-triggering coalesces
    // into one run if a previous one is still pending.
    const outbox = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `insert into mutation_outbox
           (company_id, mutation_type, payload, idempotency_key)
         values ($1, 'takeoff_to_bid', $2::jsonb, $3)
         on conflict (idempotency_key) do update
           set payload = excluded.payload,
               updated_at = now()
         returning id`,
        [
          ctx.company.id,
          JSON.stringify({ project_id: projectId, requested_by: ctx.currentUserId }),
          `takeoff_to_bid:${projectId}`,
        ],
      )
      return result.rows[0]
    })
    ctx.sendJson(202, { run_id: outbox?.id, project_id: projectId, status: 'enqueued' })
    return true
  }

  return false
}

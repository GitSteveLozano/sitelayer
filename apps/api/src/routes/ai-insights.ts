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

  if (req.method === 'POST' && url.pathname === '/api/ai/agents/voice-to-log') {
    // Foreman dictates the day's narrative; the agent drafts the
    // structured fields. Foreman role can trigger; admin/office too.
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const body = await ctx.readBody()
    const dailyLogId = typeof body.daily_log_id === 'string' ? body.daily_log_id.trim() : ''
    const transcript = typeof body.transcript === 'string' ? body.transcript : ''
    const source = body.source === 'voice' ? 'voice' : 'text'
    if (!isValidUuid(dailyLogId)) {
      ctx.sendJson(400, { error: 'daily_log_id is required and must be a valid uuid' })
      return true
    }
    if (!transcript.trim()) {
      ctx.sendJson(400, { error: 'transcript is required' })
      return true
    }
    if (transcript.length > 16_000) {
      ctx.sendJson(413, { error: 'transcript capped at 16000 characters' })
      return true
    }

    // Foreman ownership: a foreman can only trigger the agent on their
    // own draft. Admin/office can trigger anywhere.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const exists = await ctx.pool.query<{ id: string }>(
      `select id from daily_logs
       where company_id = $1 and id = $2 and status = 'draft'
         and ($3 = '' or foreman_user_id = $3)
       limit 1`,
      [ctx.company.id, dailyLogId, ownerFilter],
    )
    if (!exists.rows[0]) {
      ctx.sendJson(404, { error: 'daily log not found, already submitted, or not yours' })
      return true
    }

    const outbox = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `insert into mutation_outbox
           (company_id, mutation_type, payload, idempotency_key)
         values ($1, 'voice_to_log', $2::jsonb, $3)
         on conflict (idempotency_key) do update
           set payload = excluded.payload,
               updated_at = now()
         returning id`,
        [
          ctx.company.id,
          JSON.stringify({
            daily_log_id: dailyLogId,
            transcript,
            source,
            requested_by: ctx.currentUserId,
          }),
          // Per-log key so re-triggering coalesces (the latest
          // transcript wins).
          `voice_to_log:${dailyLogId}`,
        ],
      )
      return result.rows[0]
    })
    ctx.sendJson(202, { run_id: outbox?.id, daily_log_id: dailyLogId, status: 'enqueued' })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/agents/bid-follow-up') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    const ageDaysRaw = Number(body.age_days)
    const ageDays =
      Number.isFinite(ageDaysRaw) && ageDaysRaw > 0 && ageDaysRaw < 365 ? Math.floor(ageDaysRaw) : 14

    // Find active projects whose bid has been on the wall for at least
    // age_days without going to 'completed' or 'closed'. One ai_insight
    // per stale project; idempotency key per (project, week-bucket) so
    // reruns within the same week don't pile up.
    const stale = await ctx.pool.query<{
      id: string
      name: string
      customer_name: string | null
      bid_total: string
      created_at: string
    }>(
      `select id, name, customer_name, bid_total, created_at
       from projects
       where company_id = $1
         and deleted_at is null
         and bid_total > 0
         and status in ('active', 'draft', 'pending')
         and created_at < now() - ($2 || ' days')::interval
       order by created_at asc
       limit 50`,
      [ctx.company.id, String(ageDays)],
    )
    if (stale.rows.length === 0) {
      ctx.sendJson(200, { proposals_created: 0, scanned: 0 })
      return true
    }

    let created = 0
    // Month-bucket dedupe: one follow-up insight per (project, UTC
    // year-month) so a re-triggered scan inside the same month is a
    // no-op. The partial unique index on (company_id, source_run_id)
    // (migration 041) makes the upsert race-safe — two concurrent
    // triggers will both succeed, but only one row lands.
    const bucket = monthBucketUtc(new Date())
    for (const project of stale.rows) {
      const key = `bid_follow_up:${project.id}:${bucket}`
      const draft = composeFollowUpDraft(project)
      const result = await ctx.pool.query<{ id: string }>(
        `insert into ai_insights
           (company_id, kind, entity_type, entity_id, payload, confidence,
            attribution, source_run_id, produced_by)
         values ($1, 'bid_follow_up', 'project', $2, $3::jsonb, $4, $5, $6, 'agent:bid_follow_up')
         on conflict (company_id, source_run_id) where source_run_id is not null do nothing
         returning id`,
        [
          ctx.company.id,
          project.id,
          JSON.stringify(draft),
          draft.confidence,
          `Bid issued ${draft.days_outstanding}d ago, no status change recorded`,
          key,
        ],
      )
      if ((result.rowCount ?? 0) > 0) created++
    }
    ctx.sendJson(200, { proposals_created: created, scanned: stale.rows.length, age_days: ageDays })
    return true
  }

  return false
}

interface FollowUpDraft {
  subject: string
  body: string
  days_outstanding: number
  bid_total: string
  customer_name: string | null
  confidence: 'low' | 'med' | 'high'
}

function monthBucketUtc(d: Date): string {
  // YYYY-MM in UTC — coarser than ISO week but immune to the year-
  // boundary edge cases in a hand-rolled week function. Two follow-up
  // triggers in the same calendar month coalesce.
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

function composeFollowUpDraft(project: {
  id: string
  name: string
  customer_name: string | null
  bid_total: string
  created_at: string
}): FollowUpDraft {
  const days = Math.max(
    1,
    Math.floor((Date.now() - Date.parse(project.created_at)) / (1000 * 60 * 60 * 24)),
  )
  const customer = project.customer_name ?? 'there'
  const subject = `Following up on ${project.name}`
  const body = `Hi ${customer},

Just checking in on the bid for ${project.name} (${days} days out). Happy to walk through the line items, adjust the scope, or sharpen the number — let me know what would be most useful.

Thanks,
The crew at Sitelayer`
  // Confidence stays medium — this is a heuristic, not a model output.
  // Call sites can tune as the pattern matures.
  return {
    subject,
    body,
    days_outstanding: days,
    bid_total: project.bid_total,
    customer_name: project.customer_name,
    confidence: 'med',
  }
}

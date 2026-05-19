import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { withCompanyClient } from '../mutation-tx.js'
import { parseJsonBody } from '../http-utils.js'

/**
 * Read-only GET endpoint for the workflow_event_log tail.
 *
 * Closes Probe TODO #1 from apps/web/src/lib/probe/estimate-push.ts: the
 * SiteLayer Probe (ADR-0019) needs the last N rows of workflow_event_log
 * for a given entity so the runner can answer causality questions
 * ("why is this stuck?") without round-tripping the API.
 *
 * Surface:
 *   GET /api/workflow-event-log?entity_type=...&entity_id=...&limit=...
 *
 * Auth: standard Clerk JWT + active-company resolution (handled by the
 * dispatch cascade upstream). Role gate is the same operator-tier set
 * used elsewhere for sensitive read paths — workers (`member`) are
 * excluded. Company scoping is enforced via `withCompanyClient` (sets
 * `app.company_id` so the row-level company_id filter is the only path
 * to data).
 *
 * Response shape mirrors `WorkflowEventLogRow` in
 * `apps/web/src/lib/probe/types.ts`. The DB schema stores the
 * pre-transition state_version and the post-transition snapshot_after;
 * we project both sides for the Probe.
 *
 *   - `from_state_version` = workflow_event_log.state_version
 *   - `to_state_version`   = snapshot_after->>state_version (== from + 1)
 *   - `to_state`           = snapshot_after->>state
 *   - `from_state`         = previous row's snapshot_after->>state in the
 *                            same entity stream, sourced via LAG()
 *                            (null for the first row).
 */

export const WorkflowEventLogQuerySchema = z.object({
  entity_type: z.string().min(1, 'entity_type is required'),
  entity_id: z.string().min(1, 'entity_id is required'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export type WorkflowEventLogQuery = z.infer<typeof WorkflowEventLogQuerySchema>

/**
 * Wire shape returned to the Probe. Matches `WorkflowEventLogRow` in
 * `apps/web/src/lib/probe/types.ts` field-for-field; any change here
 * must update the Probe type in the same turn.
 */
export const WorkflowEventLogRowSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  entity_id: z.string(),
  event_type: z.string(),
  from_state: z.string().nullable(),
  to_state: z.string(),
  from_state_version: z.number().int(),
  to_state_version: z.number().int(),
  actor_user_id: z.string().nullable(),
  created_at: z.string(),
  event_payload: z.unknown().nullable().optional(),
})

export type WorkflowEventLogRowResponse = z.infer<typeof WorkflowEventLogRowSchema>

export const WorkflowEventLogResponseSchema = z.object({
  events: z.array(WorkflowEventLogRowSchema),
})

export type WorkflowEventLogRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

/**
 * Roles that may read workflow_event_log. Operator tier (admin, office,
 * foreman, bookkeeper) — workers (`member`) are excluded since the log
 * carries cross-cutting workflow signal they don't need.
 */
const ALLOWED_ROLES = ['admin', 'office', 'foreman', 'bookkeeper'] as const

type WorkflowEventLogDbRow = {
  id: string
  workflow_name: string
  entity_id: string
  event_type: string
  state_version: number
  to_state: string | null
  to_state_version: number | null
  from_state: string | null
  actor_user_id: string | null
  applied_at: string
  event_payload: unknown
}

export async function handleWorkflowEventLogRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkflowEventLogRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/api/workflow-event-log') {
    return false
  }

  if (!ctx.requireRole(ALLOWED_ROLES)) return true

  // Validate query params via zod — same `parseJsonBody` helper used
  // for body validation (it just calls safeParse, so it works for any
  // shape).
  const rawQuery: Record<string, string> = {
    entity_type: url.searchParams.get('entity_type') ?? '',
    entity_id: url.searchParams.get('entity_id') ?? '',
  }
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null) rawQuery.limit = rawLimit

  const parsed = parseJsonBody(WorkflowEventLogQuerySchema, rawQuery)
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return true
  }

  const limit = parsed.value.limit ?? DEFAULT_LIMIT
  if (limit < 1 || limit > MAX_LIMIT) {
    ctx.sendJson(400, { error: `limit must be in [1, ${MAX_LIMIT}]` })
    return true
  }

  // Pull the rows for this entity stream and project the Probe shape.
  // LAG() yields the previous row's post-transition state (== this
  // row's pre-transition state) so the Probe can render the transition
  // edge without re-deriving from raw payloads. The unique
  // (entity_id, state_version) constraint guarantees a total order.
  //
  // We sort the inner query ascending for the LAG window, then re-sort
  // descending (newest first) at the outer SELECT so the response
  // matches the Probe's expected ordering.
  const sql = `
    with stream as (
      select
        id,
        workflow_name,
        entity_id,
        event_type,
        state_version,
        snapshot_after,
        actor_user_id,
        applied_at,
        event_payload,
        lag(snapshot_after->>'state') over (
          partition by entity_id order by state_version asc
        ) as from_state
      from workflow_event_log
      where company_id = $1
        and entity_type = $2
        and entity_id = $3::uuid
    )
    select
      id,
      workflow_name,
      entity_id::text as entity_id,
      event_type,
      state_version,
      snapshot_after->>'state' as to_state,
      (snapshot_after->>'state_version')::int as to_state_version,
      from_state,
      actor_user_id,
      applied_at,
      event_payload
    from stream
    order by state_version desc
    limit $4
  `

  let result: { rows: WorkflowEventLogDbRow[] }
  try {
    result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<WorkflowEventLogDbRow>(sql, [ctx.company.id, parsed.value.entity_type, parsed.value.entity_id, limit]),
    )
  } catch (err) {
    // Most likely: entity_id is not a valid uuid. Surface a 400 rather
    // than letting it bubble as a 500 — the Probe can then fall back to
    // an empty tail without polluting Sentry.
    const message = err instanceof Error ? err.message : 'invalid query'
    if (/invalid input syntax for type uuid/i.test(message)) {
      ctx.sendJson(400, { error: 'entity_id must be a uuid' })
      return true
    }
    throw err
  }

  const events: WorkflowEventLogRowResponse[] = result.rows.map((row) => ({
    id: row.id,
    workflow_name: row.workflow_name,
    entity_id: row.entity_id,
    event_type: row.event_type,
    from_state: row.from_state ?? null,
    to_state: row.to_state ?? '',
    from_state_version: row.state_version,
    to_state_version: row.to_state_version ?? row.state_version + 1,
    actor_user_id: row.actor_user_id,
    created_at: row.applied_at,
    event_payload: (row.event_payload as Record<string, unknown> | null) ?? null,
  }))

  ctx.sendJson(200, { events })
  return true
}

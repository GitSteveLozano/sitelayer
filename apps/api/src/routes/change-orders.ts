import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  CHANGE_ORDER_WORKFLOW_NAME,
  CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION,
  nextChangeOrderEvents,
  parseChangeOrderEventRequest,
  transitionChangeOrderWorkflow,
  type ChangeOrderHumanEventType,
  type ChangeOrderWorkflowEvent,
  type ChangeOrderWorkflowSnapshot,
  type ChangeOrderWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid } from '../http-utils.js'

export type ChangeOrderRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const CHANGE_ORDER_COLUMNS = `
  id, company_id, project_id, number, description, value_delta, schedule_impact_days,
  status, state_version, sent_at, accepted_at, rejected_at, voided_at, reject_reason,
  created_by, approved_by, version, created_at, updated_at
`

type ChangeOrderRow = {
  id: string
  company_id: string
  project_id: string
  number: number
  description: string
  value_delta: string
  schedule_impact_days: number
  status: ChangeOrderWorkflowState
  state_version: number
  sent_at: string | null
  accepted_at: string | null
  rejected_at: string | null
  voided_at: string | null
  reject_reason: string | null
  created_by: string | null
  approved_by: string | null
  version: number
  created_at: string
  updated_at: string
}

function rowToSnapshot(row: ChangeOrderRow): ChangeOrderWorkflowSnapshot {
  return {
    state: row.status,
    state_version: row.state_version,
    sent_at: row.sent_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    voided_at: row.voided_at,
    reject_reason: row.reject_reason,
    approved_by: row.approved_by,
  }
}

function rowToContext(row: ChangeOrderRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id,
    number: row.number,
    description: row.description,
    value_delta: Number(row.value_delta),
    schedule_impact_days: row.schedule_impact_days,
    status: row.status,
    sent_at: row.sent_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    voided_at: row.voided_at,
    reject_reason: row.reject_reason,
    created_by: row.created_by,
    approved_by: row.approved_by,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function snapshotResponse(row: ChangeOrderRow) {
  return {
    state: row.status,
    state_version: row.state_version,
    context: rowToContext(row),
    next_events: nextChangeOrderEvents(row.status),
  }
}

function buildReducerEvent(
  eventType: ChangeOrderHumanEventType,
  actorUserId: string,
  reason: string | undefined,
): ChangeOrderWorkflowEvent {
  // Routes stamp occurred_at at the boundary; the reducer is pure.
  const occurredAt = new Date().toISOString()
  if (eventType === 'REJECT') {
    return reason !== undefined
      ? { type: 'REJECT', actor_user_id: actorUserId, occurred_at: occurredAt, reason }
      : { type: 'REJECT', actor_user_id: actorUserId, occurred_at: occurredAt }
  }
  return { type: eventType, actor_user_id: actorUserId, occurred_at: occurredAt }
}

/**
 * Change-order routes (097_change_orders.sql + packages/workflows/change-order.ts):
 *   GET  /api/projects/:id/change-orders        list COs (newest first) + effective-value rollup
 *   POST /api/projects/:id/change-orders        create a draft CO
 *   GET  /api/change-orders/:id                 WorkflowSnapshot
 *   POST /api/change-orders/:id/events          { event, state_version, reason? }
 */
export async function handleChangeOrderRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ChangeOrderRouteCtx,
): Promise<boolean> {
  // --- list for a project -------------------------------------------------
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/change-orders$/)
  if (listMatch && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const projectId = listMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ChangeOrderRow>(
        `select ${CHANGE_ORDER_COLUMNS} from change_orders
         where company_id = $1 and project_id = $2 and deleted_at is null
         order by number desc`,
        [ctx.company.id, projectId],
      ),
    )
    const cos = rows.rows.map(rowToContext)
    const acceptedDelta = cos.filter((c) => c.status === 'accepted').reduce((sum, c) => sum + c.value_delta, 0)
    ctx.sendJson(200, { change_orders: cos, accepted_value_delta: acceptedDelta })
    return true
  }

  // --- create a draft CO --------------------------------------------------
  if (listMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = listMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const valueDelta = Number(body.value_delta)
    const scheduleImpact = Number.isFinite(Number(body.schedule_impact_days)) ? Number(body.schedule_impact_days) : 0
    if (!Number.isFinite(valueDelta)) {
      ctx.sendJson(400, { error: 'value_delta must be a number' })
      return true
    }
    try {
      const created = await withMutationTx(async (client: PoolClient) => {
        const proj = await client.query<{ id: string }>(
          `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, projectId],
        )
        if (!proj.rows[0]) return { kind: 'not_found' as const }
        // Per-project sequential CO number (gap-free; serialised by the row lock above).
        const nextNum = await client.query<{ next: number }>(
          `select coalesce(max(number), 0) + 1 as next from change_orders
           where company_id = $1 and project_id = $2`,
          [ctx.company.id, projectId],
        )
        const inserted = await client.query<ChangeOrderRow>(
          `insert into change_orders
             (company_id, project_id, number, description, value_delta, schedule_impact_days, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${CHANGE_ORDER_COLUMNS}`,
          [ctx.company.id, projectId, nextNum.rows[0]!.next, description, valueDelta, scheduleImpact, ctx.currentUserId],
        )
        const row = inserted.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: 'change_order.created',
          entityType: 'change_order',
          entityId: row.id,
          after: { project_id: projectId, number: row.number, value_delta: Number(row.value_delta) },
        })
        return { kind: 'ok' as const, row }
      })
      if (created.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      ctx.sendJson(201, snapshotResponse(created.row))
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to create change order' })
    }
    return true
  }

  // --- snapshot -----------------------------------------------------------
  const snapshotMatch = url.pathname.match(/^\/api\/change-orders\/([^/]+)$/)
  if (snapshotMatch && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const id = snapshotMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ChangeOrderRow>(
        `select ${CHANGE_ORDER_COLUMNS} from change_orders
         where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [ctx.company.id, id],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'change order not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(result.rows[0]))
    return true
  }

  // --- events -------------------------------------------------------------
  const eventMatch = url.pathname.match(/^\/api\/change-orders\/([^/]+)\/events$/)
  if (eventMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseChangeOrderEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion, reason } = parsed.value
    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const locked = await client.query<ChangeOrderRow>(
          `select ${CHANGE_ORDER_COLUMNS} from change_orders
           where company_id = $1 and id = $2 and deleted_at is null for update`,
          [ctx.company.id, id],
        )
        const current = locked.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'conflict' as const, row: current }
        }
        let nextSnapshot: ChangeOrderWorkflowSnapshot
        try {
          nextSnapshot = transitionChangeOrderWorkflow(
            rowToSnapshot(current),
            buildReducerEvent(eventType, ctx.currentUserId, reason),
          )
        } catch (err) {
          return { kind: 'illegal' as const, message: err instanceof Error ? err.message : 'illegal transition' }
        }
        const updated = await client.query<ChangeOrderRow>(
          `update change_orders set
             status = $3, state_version = $4, sent_at = $5, accepted_at = $6, rejected_at = $7,
             voided_at = $8, reject_reason = $9, approved_by = $10, version = version + 1, updated_at = now()
           where company_id = $1 and id = $2
           returning ${CHANGE_ORDER_COLUMNS}`,
          [
            ctx.company.id,
            id,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.sent_at ?? null,
            nextSnapshot.accepted_at ?? null,
            nextSnapshot.rejected_at ?? null,
            nextSnapshot.voided_at ?? null,
            nextSnapshot.reject_reason ?? null,
            nextSnapshot.approved_by ?? null,
          ],
        )
        const row = updated.rows[0]!
        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: CHANGE_ORDER_WORKFLOW_NAME,
          schemaVersion: CHANGE_ORDER_WORKFLOW_SCHEMA_VERSION,
          entityType: 'change_order',
          entityId: id,
          stateVersion: row.state_version,
          eventType,
          eventPayload: { event: eventType, reason: reason ?? null },
          snapshotAfter: rowToContext(row),
          actorUserId: ctx.currentUserId,
        })
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: `change_order.${eventType.toLowerCase()}`,
          entityType: 'change_order',
          entityId: id,
          before: { status: current.status },
          after: { status: row.status },
        })
        return { kind: 'ok' as const, row }
      })
      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'change order not found' })
        return true
      }
      if (result.kind === 'conflict') {
        ctx.sendJson(409, { error: 'stale state_version', ...snapshotResponse(result.row) })
        return true
      }
      if (result.kind === 'illegal') {
        ctx.sendJson(422, { error: result.message })
        return true
      }
      ctx.sendJson(200, snapshotResponse(result.row))
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to apply event' })
    }
    return true
  }

  return false
}

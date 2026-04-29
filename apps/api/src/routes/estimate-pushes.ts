import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { sumMoney } from '@sitelayer/domain'
import {
  ESTIMATE_PUSH_WORKFLOW_NAME,
  ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
  nextEstimatePushEvents,
  parseEstimatePushEventRequest,
  transitionEstimatePushWorkflow,
  type EstimatePushHumanEventType,
  type EstimatePushWorkflowEvent,
  type EstimatePushWorkflowSnapshot,
  type EstimatePushWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'

/**
 * Route handlers for the estimate-push workflow.
 *
 * Surface:
 *   POST /api/projects/:id/estimate-pushes        — capture current
 *                                                   estimate_lines snapshot
 *                                                   into a new estimate_push
 *                                                   row in state 'drafted'
 *   GET  /api/estimate-pushes                     — company-scoped list,
 *                                                   optional ?state=...
 *   GET  /api/estimate-pushes/:id                 — WorkflowSnapshot
 *   POST /api/estimate-pushes/:id/events          — { event, state_version }
 *
 * Mirrors rental-billing-runs in shape so the same UI/replay tooling
 * works without bespoke handling.
 */

export type EstimatePushRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type EstimatePushRow = {
  id: string
  company_id: string
  project_id: string
  customer_id: string | null
  status: EstimatePushWorkflowState
  state_version: number
  subtotal: string
  qbo_estimate_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type EstimatePushLineRow = {
  id: string
  company_id: string
  estimate_push_id: string
  source_estimate_line_id: string | null
  description: string
  service_item_code: string | null
  division_code: string | null
  quantity: string
  unit_price: string
  amount: string
  taxable: boolean
  sort_order: number
  created_at: string
}

const ESTIMATE_PUSH_COLUMNS = `
  id, company_id, project_id, customer_id, status, state_version, subtotal,
  qbo_estimate_id, reviewed_at, reviewed_by, approved_at, approved_by,
  posted_at, failed_at, error, workflow_engine, workflow_run_id,
  version, deleted_at, created_at, updated_at
`

const ESTIMATE_PUSH_LINE_COLUMNS = `
  id, company_id, estimate_push_id, source_estimate_line_id, description,
  service_item_code, division_code, quantity, unit_price, amount, taxable,
  sort_order, created_at
`

function rowToSnapshot(row: EstimatePushRow): EstimatePushWorkflowSnapshot {
  return {
    state: row.status,
    state_version: row.state_version,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error,
    qbo_estimate_id: row.qbo_estimate_id,
  }
}

function snapshotResponse(
  row: EstimatePushRow,
  lines: EstimatePushLineRow[],
): WorkflowSnapshot<
  EstimatePushWorkflowState,
  EstimatePushHumanEventType,
  {
    id: string
    project_id: string
    customer_id: string | null
    subtotal: string
    qbo_estimate_id: string | null
    reviewed_at: string | null
    reviewed_by: string | null
    approved_at: string | null
    approved_by: string | null
    posted_at: string | null
    failed_at: string | null
    error: string | null
    workflow_engine: string
    workflow_run_id: string | null
    lines: EstimatePushLineRow[]
  }
> {
  return {
    state: row.status,
    state_version: row.state_version,
    next_events: nextEstimatePushEvents(row.status),
    context: {
      id: row.id,
      project_id: row.project_id,
      customer_id: row.customer_id,
      subtotal: row.subtotal,
      qbo_estimate_id: row.qbo_estimate_id,
      reviewed_at: row.reviewed_at,
      reviewed_by: row.reviewed_by,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      posted_at: row.posted_at,
      failed_at: row.failed_at,
      error: row.error,
      workflow_engine: row.workflow_engine,
      workflow_run_id: row.workflow_run_id,
      lines,
    },
  }
}

function buildReducerEvent(eventType: EstimatePushHumanEventType, actorUserId: string): EstimatePushWorkflowEvent {
  const now = new Date().toISOString()
  switch (eventType) {
    case 'REVIEW':
      return { type: 'REVIEW', reviewed_at: now, reviewed_by: actorUserId }
    case 'APPROVE':
      return { type: 'APPROVE', approved_at: now, approved_by: actorUserId }
    case 'POST_REQUESTED':
      return { type: 'POST_REQUESTED' }
    case 'RETRY_POST':
      return { type: 'RETRY_POST' }
    case 'VOID':
      return { type: 'VOID' }
  }
}

async function fetchPushLines(
  client: Pool | PoolClient,
  companyId: string,
  pushId: string,
): Promise<EstimatePushLineRow[]> {
  const result = await client.query<EstimatePushLineRow>(
    `select ${ESTIMATE_PUSH_LINE_COLUMNS}
     from estimate_push_lines
     where company_id = $1 and estimate_push_id = $2
     order by sort_order asc, created_at asc`,
    [companyId, pushId],
  )
  return result.rows
}

export async function handleEstimatePushRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: EstimatePushRouteCtx,
): Promise<boolean> {
  // -------------------------------------------------------------------------
  // POST /api/projects/:id/estimate-pushes
  // Snapshot the project's current estimate_lines into a new estimate_push
  // row in state 'drafted'. Refuses to create a duplicate while a non-
  // terminal push exists for the project.
  // -------------------------------------------------------------------------
  const createMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate-pushes$/)
  if (req.method === 'POST' && createMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = createMatch[1]!

    try {
      const result = await withMutationTx(async (client) => {
        const projectResult = await client.query<{ id: string; customer_id: string | null }>(
          `select id, customer_id from projects
           where company_id = $1 and id = $2
           limit 1`,
          [ctx.company.id, projectId],
        )
        const project = projectResult.rows[0]
        if (!project) return { kind: 'not_found' as const }

        const openResult = await client.query<{ id: string; status: string }>(
          `select id, status from estimate_pushes
           where company_id = $1 and project_id = $2
             and deleted_at is null
             and status not in ('posted', 'voided')
           order by created_at desc
           limit 1`,
          [ctx.company.id, projectId],
        )
        if (openResult.rows[0]) {
          return { kind: 'conflict' as const, openId: openResult.rows[0].id }
        }

        // estimate_lines has no `description` column — derive a label from
        // service_item_code at snapshot time. estimate_push_lines.description
        // is the authoritative captured label going forward.
        const linesResult = await client.query<{
          id: string
          service_item_code: string | null
          quantity: string
          rate: string
          amount: string
          division_code: string | null
        }>(
          `select id, service_item_code, quantity, rate, amount, division_code
           from estimate_lines
           where company_id = $1 and project_id = $2
           order by created_at asc`,
          [ctx.company.id, projectId],
        )
        if (linesResult.rows.length === 0) {
          return { kind: 'no_lines' as const }
        }

        // Use integer-cents accumulation (sumMoney) — JS float
        // accumulation drifts on numeric(12,2) sums (0.1 + 0.2 != 0.3).
        // Per-row writes are still safe as JS numbers below; only the
        // running sum needs the helper.
        const subtotal = sumMoney(linesResult.rows.map((line) => line.amount))

        const insertResult = await client.query<EstimatePushRow>(
          `insert into estimate_pushes (
             company_id, project_id, customer_id, status, state_version, subtotal
           )
           values ($1, $2, $3, 'drafted', 1, $4)
           returning ${ESTIMATE_PUSH_COLUMNS}`,
          [ctx.company.id, projectId, project.customer_id, subtotal],
        )
        const created = insertResult.rows[0]!

        for (let i = 0; i < linesResult.rows.length; i++) {
          const src = linesResult.rows[i]!
          const qty = Number(src.quantity)
          const rate = Number(src.rate)
          const amt = Number(src.amount)
          await client.query(
            `insert into estimate_push_lines (
               company_id, estimate_push_id, source_estimate_line_id, description,
               service_item_code, division_code, quantity, unit_price, amount,
               taxable, sort_order
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              ctx.company.id,
              created.id,
              src.id,
              src.service_item_code ?? '',
              src.service_item_code,
              src.division_code,
              Number.isFinite(qty) ? qty : 0,
              Number.isFinite(rate) ? rate : 0,
              Number.isFinite(amt) ? amt : 0,
              true,
              i,
            ],
          )
        }

        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'estimate_push',
          entityId: created.id,
          action: 'created',
          row: created,
          idempotencyKey: `estimate_push:created:${created.id}`,
        })

        const lines = await fetchPushLines(client, ctx.company.id, created.id)
        return { kind: 'ok' as const, row: created, lines }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      if (result.kind === 'conflict') {
        ctx.sendJson(409, {
          error: 'an open estimate_push already exists for this project',
          open_estimate_push_id: result.openId,
        })
        return true
      }
      if (result.kind === 'no_lines') {
        ctx.sendJson(400, { error: 'project has no estimate_lines — recompute the estimate first' })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'estimate_push',
        entityId: result.row.id,
        action: 'created',
        after: result.row,
      })
      observeAudit('estimate_push', 'created')
      ctx.sendJson(201, snapshotResponse(result.row, result.lines))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/estimate-pushes — company-scoped list, optional ?state=
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/estimate-pushes') {
    const stateFilter = url.searchParams.get('state')
    const allowedStates: EstimatePushWorkflowState[] = [
      'drafted',
      'reviewed',
      'approved',
      'posting',
      'posted',
      'failed',
      'voided',
    ]
    const params: unknown[] = [ctx.company.id]
    let where = `company_id = $1 and deleted_at is null`
    if (stateFilter && allowedStates.includes(stateFilter as EstimatePushWorkflowState)) {
      params.push(stateFilter)
      where += ` and status = $${params.length}`
    }
    const result = await ctx.pool.query<EstimatePushRow>(
      `select ${ESTIMATE_PUSH_COLUMNS}
       from estimate_pushes
       where ${where}
       order by created_at desc
       limit 200`,
      params,
    )
    ctx.sendJson(200, { estimatePushes: result.rows })
    return true
  }

  // -------------------------------------------------------------------------
  // GET /api/estimate-pushes/:id → WorkflowSnapshot
  // -------------------------------------------------------------------------
  const snapshotMatch = url.pathname.match(/^\/api\/estimate-pushes\/([^/]+)$/)
  if (req.method === 'GET' && snapshotMatch) {
    const pushId = snapshotMatch[1]!
    const result = await ctx.pool.query<EstimatePushRow>(
      `select ${ESTIMATE_PUSH_COLUMNS}
       from estimate_pushes
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, pushId],
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'estimate_push not found' })
      return true
    }
    const lines = await fetchPushLines(ctx.pool, ctx.company.id, pushId)
    ctx.sendJson(200, snapshotResponse(row, lines))
    return true
  }

  // -------------------------------------------------------------------------
  // POST /api/estimate-pushes/:id/events
  // -------------------------------------------------------------------------
  const eventMatch = url.pathname.match(/^\/api\/estimate-pushes\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const pushId = eventMatch[1]!
    const body = await ctx.readBody()
    const parsed = parseEstimatePushEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion } = parsed.value

    try {
      const result = await withMutationTx(async (client) => {
        const lockedResult = await client.query<EstimatePushRow>(
          `select ${ESTIMATE_PUSH_COLUMNS}
           from estimate_pushes
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, pushId],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, row: current }
        }

        const reducerEvent = buildReducerEvent(eventType, ctx.currentUserId)
        let nextSnapshot: EstimatePushWorkflowSnapshot
        try {
          nextSnapshot = transitionEstimatePushWorkflow(rowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            row: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<EstimatePushRow>(
          `update estimate_pushes
             set status = $3,
                 state_version = $4,
                 reviewed_at = $5,
                 reviewed_by = $6,
                 approved_at = $7,
                 approved_by = $8,
                 posted_at = $9,
                 failed_at = $10,
                 error = $11,
                 qbo_estimate_id = $12,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${ESTIMATE_PUSH_COLUMNS}`,
          [
            ctx.company.id,
            pushId,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.reviewed_at ?? null,
            nextSnapshot.reviewed_by ?? null,
            nextSnapshot.approved_at ?? null,
            nextSnapshot.approved_by ?? null,
            nextSnapshot.posted_at ?? null,
            nextSnapshot.failed_at ?? null,
            nextSnapshot.error ?? null,
            nextSnapshot.qbo_estimate_id ?? null,
          ],
        )
        const updated = updateResult.rows[0]!

        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: ESTIMATE_PUSH_WORKFLOW_NAME,
          schemaVersion: ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
          entityType: 'estimate_push',
          entityId: updated.id,
          stateVersion: stateVersion,
          eventType,
          eventPayload: reducerEvent as unknown as Record<string, unknown>,
          snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
          actorUserId: ctx.currentUserId,
        })

        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'estimate_push',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          idempotencyKey: `estimate_push:event:${updated.id}:${updated.state_version}`,
        })

        if (eventType === 'POST_REQUESTED') {
          const lines = await fetchPushLines(client, ctx.company.id, pushId)
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'estimate_push',
            entityId: updated.id,
            action: 'post_qbo_estimate',
            mutationType: 'post_qbo_estimate',
            row: updated,
            outboxPayload: {
              estimate_push_id: updated.id,
              project_id: updated.project_id,
              customer_id: updated.customer_id,
              subtotal: updated.subtotal,
              lines,
            },
            idempotencyKey: `estimate_push:post:${updated.id}`,
          })
        }

        const lines = await fetchPushLines(client, ctx.company.id, pushId)
        return { kind: 'ok' as const, row: updated, lines, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'estimate_push not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        const lines = await fetchPushLines(ctx.pool, ctx.company.id, pushId)
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: snapshotResponse(result.row, lines),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        const lines = await fetchPushLines(ctx.pool, ctx.company.id, pushId)
        ctx.sendJson(409, {
          error: result.message,
          snapshot: snapshotResponse(result.row, lines),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'estimate_push',
        entityId: result.row.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.row,
      })
      observeAudit('estimate_push', `event:${result.eventType.toLowerCase()}`)
      ctx.sendJson(200, snapshotResponse(result.row, result.lines))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}

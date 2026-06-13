import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  nextProjectLifecycleEvents,
  parseProjectLifecycleEventRequest,
  PROJECT_LIFECYCLE_WORKFLOW_NAME,
  projectLifecycleWorkflow,
  projectStatusToLifecycleState,
  type ProjectLifecycleHumanEventType,
  type ProjectLifecycleWorkflowEvent,
  type ProjectLifecycleWorkflowSnapshot,
  type ProjectLifecycleWorkflowState,
} from '@sitelayer/workflows'
import type { WorkflowNextEvent } from '@sitelayer/workflows'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import { recordAudit } from '../audit.js'
import { observeAudit, observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { HttpError, isValidUuid } from '../http-utils.js'

export type ProjectLifecycleRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

// Exported so the estimate-share path (`estimate-share-helpers.ts`) can route
// portal-driven SEND/ACCEPT/DECLINE through the SAME column mapping + reducer
// instead of hand-rolling a parallel transition table (which silently dropped
// reducer-carried fields like `sent_at` and produced replay-divergent
// workflow_event_log rows). One canonical mapping, two call sites.
export const PROJECT_LIFECYCLE_COLUMNS = `
  id, company_id, name, customer_name, status,
  lifecycle_state, lifecycle_state_version,
  lifecycle_sent_at, lifecycle_accepted_at,
  lifecycle_declined_at, lifecycle_decline_reason,
  lifecycle_started_at, lifecycle_completed_at, lifecycle_archived_at,
  version, created_at, updated_at
`

export type ProjectLifecycleRow = {
  id: string
  company_id: string
  name: string
  customer_name: string
  status: string
  lifecycle_state: ProjectLifecycleWorkflowState
  lifecycle_state_version: number
  lifecycle_sent_at: string | null
  lifecycle_accepted_at: string | null
  lifecycle_declined_at: string | null
  lifecycle_decline_reason: string | null
  lifecycle_started_at: string | null
  lifecycle_completed_at: string | null
  lifecycle_archived_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export function rowToSnapshot(row: ProjectLifecycleRow): ProjectLifecycleWorkflowSnapshot {
  return {
    state: projectStatusToLifecycleState(row.lifecycle_state),
    state_version: row.lifecycle_state_version,
    sent_at: row.lifecycle_sent_at,
    accepted_at: row.lifecycle_accepted_at,
    declined_at: row.lifecycle_declined_at,
    decline_reason: row.lifecycle_decline_reason,
    started_at: row.lifecycle_started_at,
    completed_at: row.lifecycle_completed_at,
    archived_at: row.lifecycle_archived_at,
  }
}

function snapshotResponse(row: ProjectLifecycleRow): {
  state: ProjectLifecycleWorkflowState
  state_version: number
  context: {
    id: string
    company_id: string
    name: string
    customer_name: string
    status: string
    sent_at: string | null
    accepted_at: string | null
    declined_at: string | null
    decline_reason: string | null
    started_at: string | null
    completed_at: string | null
    archived_at: string | null
    version: number
    created_at: string
    updated_at: string
  }
  next_events: Array<WorkflowNextEvent<ProjectLifecycleHumanEventType>>
} {
  return {
    state: row.lifecycle_state,
    state_version: row.lifecycle_state_version,
    context: {
      id: row.id,
      company_id: row.company_id,
      name: row.name,
      customer_name: row.customer_name,
      status: row.status,
      sent_at: row.lifecycle_sent_at,
      accepted_at: row.lifecycle_accepted_at,
      declined_at: row.lifecycle_declined_at,
      decline_reason: row.lifecycle_decline_reason,
      started_at: row.lifecycle_started_at,
      completed_at: row.lifecycle_completed_at,
      archived_at: row.lifecycle_archived_at,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    // Computed from the registered reducer selector (single source of
    // truth) — never hand-listed in the route. Carries disabled_reason
    // end-to-end (banner.tsx reads it) and stays typed against the event
    // union. See packages/workflows/src/project-lifecycle.ts.
    next_events: nextProjectLifecycleEvents(row.lifecycle_state),
  }
}

function buildReducerEvent(
  eventType: ProjectLifecycleHumanEventType,
  actorUserId: string,
  reason: string | undefined,
): ProjectLifecycleWorkflowEvent {
  // Routes are responsible for stamping `occurred_at` at the boundary
  // — the reducer is pure and never reads the clock itself.
  const occurredAt = new Date().toISOString()
  if (eventType === 'DECLINE') {
    return reason !== undefined
      ? { type: 'DECLINE', actor_user_id: actorUserId, occurred_at: occurredAt, reason }
      : { type: 'DECLINE', actor_user_id: actorUserId, occurred_at: occurredAt }
  }
  return { type: eventType, actor_user_id: actorUserId, occurred_at: occurredAt }
}

/**
 * Project lifecycle workflow routes.
 *
 * - GET  /api/projects/:id/lifecycle           WorkflowSnapshot
 * - POST /api/projects/:id/lifecycle/events    { event, state_version, reason? }
 *
 * The lifecycle workflow runs alongside the older project_closeout
 * workflow on the same `projects` row — they own different columns
 * (`state_version` + `closed_at` for closeout, `lifecycle_state` +
 * `lifecycle_state_version` here). The legacy `status` column is left
 * untouched so analytics/summary readers keep working.
 */
export async function handleProjectLifecycleRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectLifecycleRouteCtx,
): Promise<boolean> {
  const snapshotMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/lifecycle$/)
  if (req.method === 'GET' && snapshotMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const id = snapshotMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ProjectLifecycleRow>(
        `select ${PROJECT_LIFECYCLE_COLUMNS}
       from projects
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
        [ctx.company.id, id],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(result.rows[0]))
    return true
  }

  const eventMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/lifecycle\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseProjectLifecycleEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion, reason } = parsed.value

    try {
      const result = await withMutationTx((client: PoolClient) =>
        dispatchWorkflowEvent<ProjectLifecycleRow, ProjectLifecycleWorkflowSnapshot, ProjectLifecycleWorkflowEvent>(
          client,
          {
            definition: projectLifecycleWorkflow,
            companyId: ctx.company.id,
            entityType: 'project',
            entityId: id,
            expectedStateVersion: stateVersion,
            actorUserId: ctx.currentUserId,
            loadSnapshot: async (c) => {
              const lockedResult = await c.query<ProjectLifecycleRow>(
                `select ${PROJECT_LIFECYCLE_COLUMNS}
           from projects
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
                [ctx.company.id, id],
              )
              const current = lockedResult.rows[0]
              if (!current) return null
              return { row: current, snapshot: rowToSnapshot(current) }
            },
            buildEvent: () => buildReducerEvent(eventType as ProjectLifecycleHumanEventType, ctx.currentUserId, reason),
            persist: async (c, nextSnapshot) => {
              const updateResult = await c.query<ProjectLifecycleRow>(
                `update projects
             set lifecycle_state = $3,
                 lifecycle_state_version = $4,
                 lifecycle_sent_at = $5,
                 lifecycle_accepted_at = $6,
                 lifecycle_declined_at = $7,
                 lifecycle_decline_reason = $8,
                 lifecycle_started_at = $9,
                 lifecycle_completed_at = $10,
                 lifecycle_archived_at = $11,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${PROJECT_LIFECYCLE_COLUMNS}`,
                [
                  ctx.company.id,
                  id,
                  nextSnapshot.state,
                  nextSnapshot.state_version,
                  nextSnapshot.sent_at ?? null,
                  nextSnapshot.accepted_at ?? null,
                  nextSnapshot.declined_at ?? null,
                  nextSnapshot.decline_reason ?? null,
                  nextSnapshot.started_at ?? null,
                  nextSnapshot.completed_at ?? null,
                  nextSnapshot.archived_at ?? null,
                ],
              )
              const updated = updateResult.rows[0]
              if (!updated) throw new HttpError(500, 'project lifecycle update returned no row')
              return updated
            },
            // The primitive appends the workflow_event_log row (keyed on
            // the BEFORE state_version) between persist and these side
            // effects — same in-tx order as the hand-rolled pipeline.
            sideEffects: async (c, _next, updated, reducerEvent) => {
              await recordMutationLedger(c, {
                companyId: ctx.company.id,
                entityType: 'project',
                entityId: updated.id,
                action: `lifecycle:${eventType.toLowerCase()}`,
                row: updated,
                // Per-state_version key so REOPEN → COMPLETE → REOPEN cycles
                // produce distinct outbox rows.
                idempotencyKey: `project_lifecycle:event:${updated.id}:${updated.lifecycle_state_version}`,
              })

              // ACCEPT (sent → accepted) and START_WORK (accepted → in_progress)
              // enqueue notify_foreman_assignment so the worker can resolve a
              // foreman from project_assignments and insert a notifications
              // row. Idempotency key is per-state_version so a replay (same
              // request retried) is a no-op, but a later REOPEN → ACCEPT
              // cycle generates a distinct row.
              if (eventType === 'ACCEPT' || eventType === 'START_WORK') {
                const transition: 'accepted' | 'started' = eventType === 'ACCEPT' ? 'accepted' : 'started'
                await recordMutationLedger(c, {
                  companyId: ctx.company.id,
                  entityType: 'project',
                  entityId: updated.id,
                  action: `notify_foreman_${transition}`,
                  mutationType: 'notify_foreman_assignment',
                  row: updated,
                  outboxPayload: {
                    project_id: updated.id,
                    project_name: updated.name,
                    customer_name: updated.customer_name,
                    transition,
                    actor_user_id: ctx.currentUserId,
                    occurred_at: reducerEvent.occurred_at,
                  },
                  idempotencyKey: `project_lifecycle:notify_foreman:${updated.id}:${updated.lifecycle_state_version}`,
                })
              }
            },
          },
        ),
      )

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: snapshotResponse(result.row),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: result.message,
          snapshot: snapshotResponse(result.row),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'project',
        entityId: result.row.id,
        action: `lifecycle:${eventType.toLowerCase()}`,
        after: result.row,
      })
      observeAudit('project', `lifecycle:${eventType.toLowerCase()}`)
      const outcome = workflowEventOutcome(eventType)
      if (outcome) observeWorkflowEvent(PROJECT_LIFECYCLE_WORKFLOW_NAME, outcome)
      ctx.sendJson(200, snapshotResponse(result.row))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}

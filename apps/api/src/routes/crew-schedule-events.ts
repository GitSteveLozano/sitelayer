import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  parseCrewScheduleEventRequest,
  transitionCrewScheduleWorkflow,
  type CrewScheduleHumanEventType,
  type CrewScheduleWorkflowEvent,
  type CrewScheduleWorkflowSnapshot,
  type CrewScheduleWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'
import { isValidDateInput, isValidUuid, parseExpectedVersion } from '../http-utils.js'

// Crew-schedule workflow surface — mirrors the rental-billing-state and
// time-review-runs route shape (see docs/DETERMINISTIC_WORKFLOWS.md).
//
// - GET   /api/schedules/:id              → WorkflowSnapshot
// - POST  /api/schedules/:id/events       → { event, state_version, ... }
//                                            applies the reducer in one tx.
// - PATCH /api/schedules/:id              → { scheduled_for? } drag-to-reschedule.
//
// The legacy POST /api/schedules/:id/confirm route in routes/schedules.ts
// stays as-is for back-compat with offline-replay queues; new clients
// should use POST /api/schedules/:id/events.

export type CrewScheduleEventRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

const CREW_SCHEDULE_COLUMNS = `
  id, project_id, scheduled_for, crew, status, version,
  state_version, confirmed_at, confirmed_by,
  start_time, end_time, takeoff_measurement_id,
  deleted_at, created_at
`

type CrewScheduleRow = {
  id: string
  project_id: string
  scheduled_for: string
  crew: unknown
  status: CrewScheduleWorkflowState
  version: number
  state_version: number
  confirmed_at: string | null
  confirmed_by: string | null
  start_time: string | null
  end_time: string | null
  takeoff_measurement_id: string | null
  deleted_at: string | null
  created_at: string
}

function rowToSnapshot(row: CrewScheduleRow): CrewScheduleWorkflowSnapshot {
  return {
    state: row.status,
    state_version: row.state_version,
    confirmed_at: row.confirmed_at,
    confirmed_by: row.confirmed_by,
  }
}

function workflowNextEvents(state: CrewScheduleWorkflowState): Array<{ type: string; label: string }> {
  switch (state) {
    case 'draft':
      return [{ type: 'CONFIRM', label: 'Confirm crew schedule' }]
    case 'confirmed':
      return []
  }
}

function snapshotResponse(row: CrewScheduleRow): {
  state: CrewScheduleWorkflowState
  state_version: number
  context: Omit<CrewScheduleRow, 'status' | 'state_version' | 'deleted_at'>
  next_events: ReturnType<typeof workflowNextEvents>
} {
  const { status, state_version, deleted_at, ...rest } = row
  void deleted_at
  return {
    state: status,
    state_version,
    context: {
      ...rest,
      status,
    } as unknown as Omit<CrewScheduleRow, 'status' | 'state_version' | 'deleted_at'>,
    next_events: workflowNextEvents(status),
  }
}

function buildReducerEvent(
  eventType: CrewScheduleHumanEventType,
  actorUserId: string,
  body: Record<string, unknown>,
): CrewScheduleWorkflowEvent {
  const nowIso = new Date().toISOString()
  const confirmedAt = typeof body.confirmed_at === 'string' && body.confirmed_at ? body.confirmed_at : nowIso
  const confirmedBy = typeof body.confirmed_by === 'string' && body.confirmed_by ? body.confirmed_by : actorUserId
  return { type: eventType, confirmed_at: confirmedAt, confirmed_by: confirmedBy }
}

/**
 * Handle crew-schedule workflow routes. Returns true when the route was
 * matched and the response sent; false to let downstream dispatchers try.
 */
export async function handleCrewScheduleEventRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CrewScheduleEventRouteCtx,
): Promise<boolean> {
  // GET /api/schedules/:id — workflow snapshot. Skip the company-wide
  // GET /api/schedules collection (handled in routes/schedules.ts).
  const detailMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await ctx.pool.query<CrewScheduleRow>(
      `select ${CREW_SCHEDULE_COLUMNS}
       from crew_schedules
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, id],
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'schedule not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(row))
    return true
  }

  // POST /api/schedules/:id/events — apply a workflow event.
  const eventMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'foreman'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseCrewScheduleEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion } = parsed.value

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<CrewScheduleRow>(
          `select ${CREW_SCHEDULE_COLUMNS}
           from crew_schedules
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, id],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, row: current }
        }

        const reducerEvent = buildReducerEvent(eventType as CrewScheduleHumanEventType, ctx.currentUserId, body)
        let nextSnapshot: CrewScheduleWorkflowSnapshot
        try {
          nextSnapshot = transitionCrewScheduleWorkflow(rowToSnapshot(current), reducerEvent)
        } catch (err) {
          // Treat already-confirmed retries as a no-op success — matches
          // the legacy /confirm route's idempotent-on-replay behavior.
          if (current.status === 'confirmed') {
            return { kind: 'ok' as const, row: current, eventType, noop: true }
          }
          return {
            kind: 'illegal_transition' as const,
            row: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<CrewScheduleRow>(
          `update crew_schedules
             set status = $3,
                 state_version = $4,
                 confirmed_at = $5,
                 confirmed_by = $6,
                 version = version + 1
           where company_id = $1 and id = $2
           returning ${CREW_SCHEDULE_COLUMNS}`,
          [
            ctx.company.id,
            id,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.confirmed_at ?? null,
            nextSnapshot.confirmed_by ?? null,
          ],
        )
        const updated = updateResult.rows[0]!

        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: CREW_SCHEDULE_WORKFLOW_NAME,
          schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
          entityType: 'crew_schedule',
          entityId: updated.id,
          stateVersion,
          eventType,
          eventPayload: reducerEvent as unknown as Record<string, unknown>,
          snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
          actorUserId: ctx.currentUserId,
        })
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'crew_schedule',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated as unknown as Record<string, unknown>,
          syncPayload: { action: 'confirm', schedule: updated },
          idempotencyKey: `crew_schedule:event:${updated.id}:${updated.state_version}`,
        })

        return { kind: 'ok' as const, row: updated, eventType, noop: false }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'schedule not found' })
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

      if (!result.noop) {
        await recordAudit(ctx.pool, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          entityType: 'crew_schedule',
          entityId: result.row.id,
          action: `event:${result.eventType.toLowerCase()}`,
          after: result.row,
        })
        observeAudit('crew_schedule', `event:${result.eventType.toLowerCase()}`)
      }
      ctx.sendJson(200, snapshotResponse(result.row))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  // PATCH /api/schedules/:id — drag-to-reschedule. Only `scheduled_for`
  // is editable through this surface today; other field edits go through
  // the existing per-field endpoints. Optimistic concurrency on `version`
  // returns 409 on conflict so the SPA can reload.
  const patchMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/)
  if (req.method === 'PATCH' && patchMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = patchMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const scheduledFor = typeof body.scheduled_for === 'string' ? body.scheduled_for.trim() : null
    if (scheduledFor != null && !isValidDateInput(scheduledFor)) {
      ctx.sendJson(400, { error: 'scheduled_for must be YYYY-MM-DD' })
      return true
    }
    if (scheduledFor == null) {
      ctx.sendJson(400, { error: 'scheduled_for is required' })
      return true
    }
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)

    const result = await withMutationTx(async (client: PoolClient) => {
      const lockedResult = await client.query<CrewScheduleRow>(
        `select ${CREW_SCHEDULE_COLUMNS}
         from crew_schedules
         where company_id = $1 and id = $2 and deleted_at is null
         for update`,
        [ctx.company.id, id],
      )
      const current = lockedResult.rows[0]
      if (!current) return null
      if (expectedVersion != null && current.version !== expectedVersion) return null

      const updated = await client.query<CrewScheduleRow>(
        `update crew_schedules
           set scheduled_for = $3::date,
               version = version + 1
         where company_id = $1 and id = $2
         returning ${CREW_SCHEDULE_COLUMNS}`,
        [ctx.company.id, id, scheduledFor],
      )
      const row = updated.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: row.id,
        action: 'reschedule',
        row,
        syncPayload: { action: 'reschedule', schedule: row, scheduled_for: scheduledFor },
      })
      return row
    })

    if (!result) {
      if (
        !(await ctx.checkVersion(
          'crew_schedules',
          'company_id = $1 and id = $2',
          [ctx.company.id, id],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'schedule not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(result))
    return true
  }

  return false
}

import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  nextCrewScheduleEvents,
  parseCrewScheduleEventRequest,
  transitionCrewScheduleWorkflow,
  type CrewScheduleHumanEventType,
  type CrewScheduleLaborEntryInput,
  type CrewScheduleWorkflowEvent,
  type CrewScheduleWorkflowSnapshot,
  type CrewScheduleWorkflowState,
} from '@sitelayer/workflows'
import type { PermissionAction } from '@sitelayer/domain'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit, observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { HttpError, isValidDateInput, isValidUuid, parseExpectedVersion } from '../http-utils.js'

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
  /** LAYER 2 named-action overlay; runs AFTER requireRole. See server.ts. */
  requirePermission: (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

const CREW_SCHEDULE_COLUMNS = `
  id, project_id, scheduled_for, crew, status, version,
  state_version, confirmed_at, confirmed_by, created_by,
  declined_at, declined_by, decline_reason,
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
  created_by: string | null
  declined_at: string | null
  declined_by: string | null
  decline_reason: string | null
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
    created_by: row.created_by,
    declined_at: row.declined_at,
    declined_by: row.declined_by,
    decline_reason: row.decline_reason,
  }
}

function snapshotResponse(row: CrewScheduleRow): {
  state: CrewScheduleWorkflowState
  state_version: number
  context: Omit<CrewScheduleRow, 'state_version' | 'deleted_at'>
  // Single source of truth: the registered reducer's nextEvents selector
  // (Gap 3 — the route no longer hand-duplicates the transition table).
  next_events: ReturnType<typeof nextCrewScheduleEvents>
} {
  const { status, state_version, deleted_at, ...rest } = row
  void deleted_at
  // `status` is preserved for backwards-compat with the existing JSON
  // response shape (some clients still read it instead of `state`); the
  // declared return type now includes it so callers see the same shape
  // the runtime emits. Cast no longer needed.
  const context = { ...rest, status }
  return {
    state: status,
    state_version,
    context,
    next_events: nextCrewScheduleEvents(status),
  }
}

function buildReducerEvent(
  eventType: CrewScheduleHumanEventType,
  actorUserId: string,
  body: Record<string, unknown>,
): CrewScheduleWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'DECLINE') {
    const declinedAt = typeof body.declined_at === 'string' && body.declined_at ? body.declined_at : nowIso
    const declinedBy = typeof body.declined_by === 'string' && body.declined_by ? body.declined_by : actorUserId
    const reason = typeof body.reason === 'string' ? body.reason : ''
    return { type: 'DECLINE', declined_at: declinedAt, declined_by: declinedBy, reason }
  }
  if (eventType === 'REASSIGN') {
    return { type: 'REASSIGN' }
  }
  const confirmedAt = typeof body.confirmed_at === 'string' && body.confirmed_at ? body.confirmed_at : nowIso
  const confirmedBy = typeof body.confirmed_by === 'string' && body.confirmed_by ? body.confirmed_by : actorUserId
  return { type: 'CONFIRM', confirmed_at: confirmedAt, confirmed_by: confirmedBy }
}

/** Validated per-worker labor entries on a CONFIRM body, for the
 * materialize_labor_entries outbox payload (Gap 1). */
function parseConfirmEntries(body: Record<string, unknown>): CrewScheduleLaborEntryInput[] {
  if (!Array.isArray(body.entries)) return []
  const out: CrewScheduleLaborEntryInput[] = []
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.service_item_code !== 'string' || typeof e.hours !== 'number' || typeof e.occurred_on !== 'string') {
      continue
    }
    out.push({
      worker_id: typeof e.worker_id === 'string' ? e.worker_id : null,
      service_item_code: e.service_item_code,
      hours: e.hours,
      sqft_done: typeof e.sqft_done === 'number' ? e.sqft_done : null,
      occurred_on: e.occurred_on,
    })
  }
  return out
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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<CrewScheduleRow>(
        `select ${CREW_SCHEDULE_COLUMNS}
       from crew_schedules
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
        [ctx.company.id, id],
      ),
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

    // LAYER 2: brief_crew — gates the CONFIRM event (the act that briefs the
    // crew: confirms the schedule and locks the labor entries). Matrix base
    // owner+foreman, so this round-trips the requireRole(['admin','foreman'])
    // gate above for built-in roles; a custom role can narrow it. DECLINE /
    // REASSIGN stay on the requireRole gate alone (schedule housekeeping, not
    // the brief itself).
    if (eventType === 'CONFIRM' && !ctx.requirePermission('brief_crew')) return true

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
                 declined_at = $7,
                 declined_by = $8,
                 decline_reason = $9,
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
            nextSnapshot.declined_at ?? null,
            nextSnapshot.declined_by ?? null,
            nextSnapshot.decline_reason ?? null,
          ],
        )
        const updated = updateResult.rows[0]
        if (!updated) throw new HttpError(500, 'crew schedule update returned no row')

        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: CREW_SCHEDULE_WORKFLOW_NAME,
          schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
          entityType: 'crew_schedule',
          entityId: updated.id,
          stateVersion,
          eventType,
          eventPayload: reducerEvent,
          snapshotAfter: nextSnapshot,
          actorUserId: ctx.currentUserId,
        })
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'crew_schedule',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          syncPayload: { action: eventType.toLowerCase(), schedule: updated },
          idempotencyKey: `crew_schedule:event:${updated.id}:${updated.state_version}`,
        })

        // Declared outbox side effects (mirrors rental-billing-state.ts).
        if (eventType === 'CONFIRM') {
          // Gap 1 — labor-entry materialization + project version bump move
          // out of the legacy /confirm route body and behind the CONFIRM
          // event as a declared, worker-drained side effect so BOTH confirm
          // paths produce identical labor_entries. Per-entity idempotency key
          // (NOT per-state_version) so a replay/retry upserts the same row.
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'crew_schedule',
            entityId: updated.id,
            action: 'materialize_labor_entries',
            mutationType: 'materialize_labor_entries',
            row: updated,
            outboxPayload: {
              schedule_id: updated.id,
              project_id: updated.project_id,
              scheduled_for: updated.scheduled_for,
              crew: updated.crew,
              confirmed_by: nextSnapshot.confirmed_by ?? ctx.currentUserId,
              entries: parseConfirmEntries(body),
            },
            idempotencyKey: `crew_schedule:materialize_labor:${updated.id}`,
          })
        } else if (eventType === 'DECLINE') {
          // Gap 5 — notify the project foreman in-band (replaces the old
          // /api/worker-issues note). Per-transition key so a re-decline
          // after REASSIGN is a genuinely new notification.
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'crew_schedule',
            entityId: updated.id,
            action: 'notify_foreman_decline',
            mutationType: 'notify_foreman_decline',
            row: updated,
            outboxPayload: {
              schedule_id: updated.id,
              project_id: updated.project_id,
              scheduled_for: updated.scheduled_for,
              declined_by: nextSnapshot.declined_by ?? ctx.currentUserId,
              reason: nextSnapshot.decline_reason ?? '',
              state_version: updated.state_version,
            },
            idempotencyKey: `crew_schedule:notify_decline:${updated.id}:${updated.state_version}`,
          })
        }

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
        const outcome = workflowEventOutcome(result.eventType)
        if (outcome) observeWorkflowEvent(CREW_SCHEDULE_WORKFLOW_NAME, outcome)
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
      const row = updated.rows[0]
      if (!row) throw new HttpError(500, 'crew schedule reschedule returned no row')
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

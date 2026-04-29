import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  transitionCrewScheduleWorkflow,
  type CrewScheduleWorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, parseExpectedVersion, parseJsonBody } from '../http-utils.js'

// POST /api/schedules wire-format validation. Mirrors the
// workflow-event parser pattern (see packages/workflows/src/*.ts) so
// shape errors surface as explicit 400s rather than runtime null/NaN
// drift downstream.
//
// `project_id` is required and must look like a UUID (constraint
// enforced by the FK; we just shape-check). `scheduled_for` must be
// YYYY-MM-DD per existing isValidDateInput. `crew` is jsonb; we
// accept any array (workers + roles vary). `status` defaults to
// 'draft' on insert; we constrain the legal values the route accepts.
const CreateScheduleBodySchema = z.object({
  project_id: z.uuid(),
  scheduled_for: z.string().refine((v) => isValidDateInput(v), {
    message: 'must be YYYY-MM-DD',
  }),
  crew: z.array(z.unknown()).optional(),
  status: z.enum(['draft', 'confirmed']).optional(),
})

export type ScheduleRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /** Currently-active Clerk user id (for the workflow event log actor). */
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

/**
 * Handle crew_schedule routes:
 * - POST /api/schedules                    — admin/foreman/office create
 * - GET  /api/projects/<id>/schedules      — list active schedules per project
 * - POST /api/schedules/<id>/confirm       — admin/foreman; flips status,
 *                                            inserts confirmed labor_entries,
 *                                            bumps the parent project version
 */
export async function handleScheduleRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ScheduleRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const parsed = parseJsonBody(CreateScheduleBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const schedule = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version)
        values ($1, $2, $3, $4::jsonb, coalesce($5, 'draft'), 1)
        returning id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
        `,
        [ctx.company.id, body.project_id, body.scheduled_for, JSON.stringify(body.crew ?? []), body.status ?? 'draft'],
      )
      const row = result.rows[0]
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', schedule: row },
      })
      return row
    })
    ctx.sendJson(201, schedule)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/schedules$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    if (!projectId) {
      ctx.sendJson(400, { error: 'project id is required' })
      return true
    }
    const result = await ctx.pool.query(
      `
      select id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
      from crew_schedules
      where company_id = $1 and project_id = $2 and deleted_at is null
      order by scheduled_for desc, created_at desc
      `,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { schedules: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/schedules\/[^/]+\/confirm$/)) {
    if (!ctx.requireRole(['admin', 'foreman'])) return true
    const scheduleId = url.pathname.split('/')[3] ?? ''
    if (!scheduleId) {
      ctx.sendJson(400, { error: 'schedule id is required' })
      return true
    }
    const body = await ctx.readBody()
    const entries = Array.isArray(body.entries) ? body.entries : []
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const confirmation = await withMutationTx(async (client: PoolClient) => {
      // Load the row first so we can run the deterministic reducer
      // against its current snapshot. The optimistic version check
      // (expected_version) stays on `version` for back-compat with the
      // SPA's existing PATCH plumbing; the workflow's `state_version`
      // is bumped by the reducer.
      const lockedResult = await client.query<{
        id: string
        project_id: string
        scheduled_for: string
        crew: unknown
        status: 'draft' | 'confirmed'
        state_version: number
        confirmed_at: string | null
        confirmed_by: string | null
        version: number
        created_at: string
      }>(
        `select id, project_id, scheduled_for, crew, status, state_version,
                confirmed_at, confirmed_by, version, created_at
         from crew_schedules
         where company_id = $1 and id = $2 and deleted_at is null
         for update`,
        [ctx.company.id, scheduleId],
      )
      const current = lockedResult.rows[0]
      if (!current) return null
      if (expectedVersion != null && current.version !== expectedVersion) {
        // Surface as null so the route's not-found branch hits the
        // version-conflict path that already exists below.
        return null
      }

      const reducerEvent = {
        type: 'CONFIRM' as const,
        confirmed_at: new Date().toISOString(),
        confirmed_by: ctx.currentUserId,
      }
      const beforeStateVersion = current.state_version
      let nextSnapshot: CrewScheduleWorkflowSnapshot
      try {
        nextSnapshot = transitionCrewScheduleWorkflow(
          {
            state: current.status,
            state_version: current.state_version,
            confirmed_at: current.confirmed_at,
            confirmed_by: current.confirmed_by,
          },
          reducerEvent,
        )
      } catch (err) {
        // Already-confirmed row: treat as a no-op success rather than a
        // 500. The SPA hits /confirm idempotently after offline replay,
        // and we don't want a 4xx if the row already moved.
        if (current.status === 'confirmed') {
          return { schedule: current, laborEntries: [] }
        }
        throw err
      }

      const updateResult = await client.query(
        `update crew_schedules
           set status = $3,
               state_version = $4,
               confirmed_at = $5,
               confirmed_by = $6,
               version = version + 1
         where company_id = $1 and id = $2
         returning id, project_id, scheduled_for, crew, status, state_version,
                   confirmed_at, confirmed_by, version, created_at`,
        [
          ctx.company.id,
          scheduleId,
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.confirmed_at,
          nextSnapshot.confirmed_by,
        ],
      )
      const schedule = updateResult.rows[0]
      const createdLaborEntries: Record<string, unknown>[] = []
      for (const entry of entries) {
        if (!entry.service_item_code || entry.hours === undefined || !entry.occurred_on) continue
        const inserted = await client.query(
          `
          insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
          values ($1, $2, $3, $4, $5, coalesce($6, 0), 'confirmed', $7)
          returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, created_at
          `,
          [
            ctx.company.id,
            schedule.project_id,
            entry.worker_id ?? null,
            entry.service_item_code,
            entry.hours,
            entry.sqft_done ?? 0,
            entry.occurred_on,
          ],
        )
        createdLaborEntries.push(inserted.rows[0])
      }
      await client.query(
        'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
        [ctx.company.id, schedule.project_id],
      )
      // Workflow event log row in the same tx as the state update.
      // Replay corpus for regression: feeding the log back through
      // transitionCrewScheduleWorkflow must reproduce the persisted
      // snapshot. Unique (entity_id, state_version) prevents duplicate
      // writes if a retry replays this transition.
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: CREW_SCHEDULE_WORKFLOW_NAME,
        schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
        entityType: 'crew_schedule',
        entityId: scheduleId,
        stateVersion: beforeStateVersion,
        eventType: 'CONFIRM',
        eventPayload: reducerEvent as unknown as Record<string, unknown>,
        snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: scheduleId,
        action: 'confirm',
        row: schedule,
        syncPayload: { action: 'confirm', schedule, laborEntries: createdLaborEntries },
        outboxPayload: { schedule, laborEntries: createdLaborEntries },
      })
      return { schedule, laborEntries: createdLaborEntries }
    })
    if (!confirmation) {
      if (
        !(await ctx.checkVersion(
          'crew_schedules',
          'company_id = $1 and id = $2',
          [ctx.company.id, scheduleId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'schedule not found' })
      return true
    }
    ctx.sendJson(200, confirmation)
    return true
  }

  // POST /api/schedules/copy-week
  // Body: { from_monday, to_monday }
  // Clones every crew_schedules row whose scheduled_for falls in the
  // [from_monday, from_monday+6] range to the matching offset day in
  // [to_monday, to_monday+6]. New rows always come back as status='draft'
  // so the foreman re-confirms — copying a week shouldn't auto-confirm
  // labor entries on the new dates. Idempotent at the (project_id,
  // scheduled_for) level: if a row already exists for the target day +
  // project, it's left alone (the office can edit it directly).
  if (req.method === 'POST' && url.pathname === '/api/schedules/copy-week') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const body = await ctx.readBody()
    const fromMonday = typeof body.from_monday === 'string' ? body.from_monday.trim() : ''
    const toMonday = typeof body.to_monday === 'string' ? body.to_monday.trim() : ''
    if (!fromMonday || !isValidDateInput(fromMonday) || !toMonday || !isValidDateInput(toMonday)) {
      ctx.sendJson(400, { error: 'from_monday and to_monday must be YYYY-MM-DD' })
      return true
    }
    const result = await withMutationTx(async (client: PoolClient) => {
      // Pull all source rows in [fromMonday, fromMonday+6]
      const source = await client.query(
        `
        select project_id, scheduled_for, crew
        from crew_schedules
        where company_id = $1
          and deleted_at is null
          and scheduled_for >= $2::date
          and scheduled_for <= ($2::date + interval '6 days')
        `,
        [ctx.company.id, fromMonday],
      )
      let copied = 0
      let skipped = 0
      const created: Array<Record<string, unknown>> = []
      for (const src of source.rows) {
        const offsetDays = Math.round(
          (new Date(`${src.scheduled_for}T00:00:00Z`).getTime() - new Date(`${fromMonday}T00:00:00Z`).getTime()) /
            86_400_000,
        )
        const targetDate = new Date(`${toMonday}T00:00:00Z`)
        targetDate.setUTCDate(targetDate.getUTCDate() + offsetDays)
        const targetISO = targetDate.toISOString().slice(0, 10)
        // Don't clobber an existing schedule on the target day for the
        // same project; the office can edit it directly.
        const existing = await client.query(
          `select 1 from crew_schedules
           where company_id = $1 and project_id = $2 and scheduled_for = $3::date
             and deleted_at is null`,
          [ctx.company.id, src.project_id, targetISO],
        )
        if (existing.rowCount && existing.rowCount > 0) {
          skipped += 1
          continue
        }
        const insert = await client.query(
          `
          insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version)
          values ($1, $2, $3::date, $4::jsonb, 'draft', 1)
          returning id, project_id, scheduled_for, crew, status, version, created_at
          `,
          [ctx.company.id, src.project_id, targetISO, JSON.stringify(src.crew)],
        )
        const row = insert.rows[0]
        copied += 1
        created.push(row)
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'crew_schedule',
          entityId: row.id,
          action: 'copy_week_clone',
          row,
          idempotencyKey: `crew_schedule:copy_week_clone:${row.id}`,
          syncPayload: { action: 'create', schedule: row, source_week: fromMonday, target_week: toMonday },
        })
      }
      return { copied, skipped, total: source.rowCount ?? 0, schedules: created }
    })
    ctx.sendJson(200, result)
    return true
  }

  return false
}

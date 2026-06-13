import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  transitionCrewScheduleWorkflow,
  type CrewScheduleWorkflowEvent,
  type CrewScheduleWorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import { HttpError, isValidDateInput, parseExpectedVersion, parseJsonBody } from '../http-utils.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

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

// HH:MM or HH:MM:SS — Postgres `time` accepts both. Anchored so we
// reject anything trailing (e.g. timezone suffixes the SPA shouldn't
// be sending for a wall-clock crew start).
const TIME_OF_DAY_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/

const CreateScheduleBodySchema = z
  .object({
    project_id: z.uuid(),
    scheduled_for: z.string().refine((v) => isValidDateInput(v), {
      message: 'must be YYYY-MM-DD',
    }),
    crew: z.array(z.unknown()).optional(),
    status: z.enum(['draft', 'confirmed']).optional(),
    start_time: z.string().regex(TIME_OF_DAY_RE, { message: 'must be HH:MM' }).nullish(),
    end_time: z.string().regex(TIME_OF_DAY_RE, { message: 'must be HH:MM' }).nullish(),
    takeoff_measurement_id: z.uuid().nullish(),
    // Free-text work scope (migration 019). The New Assignment sheet's SCOPE
    // textarea threads through here so the crew sees what the day is for.
    scope: z.string().max(2000).nullish(),
  })
  .refine(
    (v) => {
      // Both-or-neither for time range: it's allowed to have neither,
      // but a one-sided range is meaningless and would render half a
      // pill in the day stream. Easier to reject at the boundary than
      // to render a partial in the UI.
      const hasStart = v.start_time != null && v.start_time !== ''
      const hasEnd = v.end_time != null && v.end_time !== ''
      return hasStart === hasEnd
    },
    { message: 'start_time and end_time must be provided together', path: ['end_time'] },
  )

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
    // P0.2 — new crew assignments auto-confirm by default. A `draft` row is
    // dropped by the confirmed-only read surfaces (the foreman's today/active
    // views), so a freshly-created assignment would silently never appear.
    // Defaulting to `confirmed` makes it land in those views immediately;
    // passing an explicit `status:'draft'` still parks the row for the office
    // to confirm later.
    const effectiveStatus = body.status ?? 'confirmed'
    const schedule = await withMutationTx(async (client: PoolClient) => {
      // Always insert + log the genesis as draft@1. When auto-confirming we
      // then walk the CONFIRM transition through the reducer below (rather
      // than inserting `confirmed` directly), so the row and its event log
      // stay consistent: CREATE@0 → CONFIRM@1, the row ends at confirmed@2,
      // and the same materialize_labor_entries outbox the /confirm route
      // enqueues is emitted. A direct `confirmed` insert would orphan the
      // CREATE event at draft@1 and diverge on replay.
      const result = await client.query(
        `
        insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version,
                                    created_by, start_time, end_time, takeoff_measurement_id, scope)
        values ($1, $2, $3, $4::jsonb, 'draft', 1, $5, $6, $7, $8, $9)
        returning id, project_id, scheduled_for, crew, status, version, state_version, created_by,
                  deleted_at, created_at, start_time, end_time, takeoff_measurement_id, scope
        `,
        [
          ctx.company.id,
          body.project_id,
          body.scheduled_for,
          JSON.stringify(body.crew ?? []),
          ctx.currentUserId,
          body.start_time ?? null,
          body.end_time ?? null,
          body.takeoff_measurement_id ?? null,
          typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new HttpError(500, 'crew schedule insert returned no row')
      // Gap 2 — model creation as the synthetic genesis CREATE event so the
      // very first workflow_event_log row is the creation, giving the replay
      // corpus a true origin. CREATE advances the {draft, state_version:0}
      // pre-seed origin to draft@1; it is logged at state_version 0 (the
      // version before the transition), distinct from the first human
      // transition's state_version 1 so the (entity_id, workflow_name,
      // state_version) unique key never collides.
      const createEvent = { type: 'CREATE' as const, created_by: ctx.currentUserId }
      const seededSnapshot = transitionCrewScheduleWorkflow(
        { state: 'draft', state_version: 0, created_by: ctx.currentUserId },
        createEvent,
      )
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: CREW_SCHEDULE_WORKFLOW_NAME,
        schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
        entityType: 'crew_schedule',
        entityId: row.id,
        stateVersion: 0,
        eventType: 'CREATE',
        eventPayload: createEvent,
        snapshotAfter: seededSnapshot,
        actorUserId: ctx.currentUserId,
      })
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: row.id,
        action: 'create',
        row,
        syncPayload: { action: 'create', schedule: row },
      })

      if (effectiveStatus !== 'confirmed') {
        return row
      }

      // Auto-confirm at birth: dispatch the same CONFIRM transition the
      // legacy /confirm route uses (draft@1 → confirmed@2) through the
      // generic `dispatchWorkflowEvent` primitive so the row, its event
      // log, and the worker-drained side effect stay identical to the
      // two-step create-then-confirm flow. The freshly-inserted row is
      // already locked by this tx's INSERT, so loadSnapshot hands back the
      // in-memory row instead of re-selecting. No per-worker labor entries
      // are supplied at creation time, so the materializer inserts none
      // (it still bumps projects.version) — equivalent to confirming with
      // an empty `entries` body.
      const beforeStateVersion: number = row.state_version
      const confirmResult = await dispatchWorkflowEvent<
        typeof row,
        CrewScheduleWorkflowSnapshot,
        CrewScheduleWorkflowEvent
      >(client, {
        definition: {
          name: CREW_SCHEDULE_WORKFLOW_NAME,
          schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
          reduce: transitionCrewScheduleWorkflow,
        },
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: row.id,
        expectedStateVersion: beforeStateVersion,
        actorUserId: ctx.currentUserId,
        loadSnapshot: async () => ({
          row,
          snapshot: { state: 'draft', state_version: beforeStateVersion, confirmed_at: null, confirmed_by: null },
        }),
        buildEvent: () => ({
          type: 'CONFIRM',
          confirmed_at: new Date().toISOString(),
          confirmed_by: ctx.currentUserId,
        }),
        persist: async (c, next) => {
          const confirmedResult = await c.query(
            `update crew_schedules
                 set status = $3,
                     state_version = $4,
                     confirmed_at = $5,
                     confirmed_by = $6,
                     version = version + 1
               where company_id = $1 and id = $2
               returning id, project_id, scheduled_for, crew, status, version, state_version, created_by,
                         deleted_at, created_at, start_time, end_time, takeoff_measurement_id, scope`,
            [ctx.company.id, row.id, next.state, next.state_version, next.confirmed_at, next.confirmed_by],
          )
          const confirmedRow = confirmedResult.rows[0]
          if (!confirmedRow) throw new HttpError(500, 'crew schedule confirm returned no row')
          return confirmedRow
        },
        sideEffects: async (c, next, confirmedRow) => {
          const confirmOutcome = workflowEventOutcome('CONFIRM')
          if (confirmOutcome) observeWorkflowEvent(CREW_SCHEDULE_WORKFLOW_NAME, confirmOutcome)
          await recordMutationLedger(c, {
            companyId: ctx.company.id,
            entityType: 'crew_schedule',
            entityId: row.id,
            action: 'materialize_labor_entries',
            mutationType: 'materialize_labor_entries',
            row: confirmedRow,
            syncPayload: { action: 'confirm', schedule: confirmedRow },
            outboxPayload: {
              schedule_id: confirmedRow.id,
              project_id: confirmedRow.project_id,
              scheduled_for: confirmedRow.scheduled_for,
              crew: confirmedRow.crew,
              confirmed_by: next.confirmed_by ?? ctx.currentUserId,
              entries: [],
            },
            idempotencyKey: `crew_schedule:materialize_labor:${confirmedRow.id}`,
          })
        },
      })
      if (confirmResult.kind !== 'ok') {
        // Unreachable: the row was inserted in this tx at draft@1 and the
        // snapshot/expected version are taken from it, so neither a
        // version conflict nor an illegal transition can occur.
        throw new HttpError(500, 'crew schedule auto-confirm dispatch failed')
      }
      return confirmResult.row
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
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `
      select s.id, s.project_id, s.scheduled_for, s.crew, s.status, s.version, s.deleted_at, s.created_at,
             s.start_time, s.end_time, s.takeoff_measurement_id, s.scope,
             tm.service_item_code as takeoff_service_item_code,
             tm.elevation        as takeoff_elevation,
             tm.quantity         as takeoff_quantity,
             tm.unit             as takeoff_unit
      from crew_schedules s
      left join takeoff_measurements tm
             on tm.id = s.takeoff_measurement_id
            and tm.company_id = s.company_id
            and tm.deleted_at is null
      where s.company_id = $1 and s.project_id = $2 and s.deleted_at is null
      order by s.scheduled_for desc, s.created_at desc
      `,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { schedules: result.rows })
    return true
  }

  // Company-wide schedule list with optional date filters. Used by
  // fm-today to render the "Today's schedule" card without needing a
  // project_id upfront. The hot-path index from migration 013
  // (crew_schedules_company_scheduled_idx) covers this query.
  if (req.method === 'GET' && url.pathname === '/api/schedules') {
    const from = String(url.searchParams.get('from') ?? '').trim()
    const to = String(url.searchParams.get('to') ?? '').trim()
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      ctx.sendJson(400, { error: 'from must be YYYY-MM-DD' })
      return true
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      ctx.sendJson(400, { error: 'to must be YYYY-MM-DD' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `
      select s.id, s.project_id, s.scheduled_for, s.crew, s.status, s.version,
             s.deleted_at, s.created_at,
             s.start_time, s.end_time, s.takeoff_measurement_id, s.scope,
             p.name as project_name,
             tm.service_item_code as takeoff_service_item_code,
             tm.elevation        as takeoff_elevation,
             tm.quantity         as takeoff_quantity,
             tm.unit             as takeoff_unit
      from crew_schedules s
      left join projects p on p.id = s.project_id and p.company_id = s.company_id
      left join takeoff_measurements tm
             on tm.id = s.takeoff_measurement_id
            and tm.company_id = s.company_id
            and tm.deleted_at is null
      where s.company_id = $1
        and s.deleted_at is null
        and ($2 = '' or s.scheduled_for >= $2::date)
        and ($3 = '' or s.scheduled_for <= $3::date)
      order by s.scheduled_for asc, s.created_at asc
      limit 200
      `,
        [ctx.company.id, from, to],
      ),
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
    // Locked-row shape for the /confirm dispatch (also what the no-op
    // already-confirmed response carries).
    type ScheduleConfirmRow = {
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
    }
    // The optimistic version check (expected_version) stays on `version`
    // for back-compat with the SPA's existing PATCH plumbing — it runs
    // inside loadSnapshot; the workflow-level state_version check is
    // disabled by echoing the locked row's own state_version back
    // (the resolvedExpected pattern from daily-logs.ts).
    let resolvedExpected = -1
    const result = await withMutationTx((client: PoolClient) =>
      dispatchWorkflowEvent<ScheduleConfirmRow, CrewScheduleWorkflowSnapshot, CrewScheduleWorkflowEvent>(client, {
        definition: {
          name: CREW_SCHEDULE_WORKFLOW_NAME,
          schemaVersion: CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
          reduce: transitionCrewScheduleWorkflow,
        },
        companyId: ctx.company.id,
        entityType: 'crew_schedule',
        entityId: scheduleId,
        get expectedStateVersion() {
          return resolvedExpected
        },
        actorUserId: ctx.currentUserId,
        loadSnapshot: async (c) => {
          const lockedResult = await c.query<ScheduleConfirmRow>(
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
            // Surface as not_found so the route's existing
            // version-conflict fallback (ctx.checkVersion) runs below.
            return null
          }
          resolvedExpected = current.state_version
          return {
            row: current,
            snapshot: {
              state: current.status,
              state_version: current.state_version,
              confirmed_at: current.confirmed_at,
              confirmed_by: current.confirmed_by,
            },
          }
        },
        buildEvent: () => ({
          type: 'CONFIRM',
          confirmed_at: new Date().toISOString(),
          confirmed_by: ctx.currentUserId,
        }),
        persist: async (c, next) => {
          const updateResult = await c.query<ScheduleConfirmRow>(
            `update crew_schedules
               set status = $3,
                   state_version = $4,
                   confirmed_at = $5,
                   confirmed_by = $6,
                   version = version + 1
             where company_id = $1 and id = $2
             returning id, project_id, scheduled_for, crew, status, state_version,
                       confirmed_at, confirmed_by, version, created_at`,
            [ctx.company.id, scheduleId, next.state, next.state_version, next.confirmed_at, next.confirmed_by],
          )
          const schedule = updateResult.rows[0]
          if (!schedule) throw new HttpError(500, 'crew schedule update returned no row')
          return schedule
        },
        sideEffects: async (c, next, schedule) => {
          const confirmOutcome = workflowEventOutcome('CONFIRM')
          if (confirmOutcome) observeWorkflowEvent(CREW_SCHEDULE_WORKFLOW_NAME, confirmOutcome)
          // Gap 1 convergence (expand phase): the labor-entry materialization +
          // projects.version bump are NO LONGER inline here. Both confirm paths
          // (this legacy /confirm and the headless /events) now enqueue the SAME
          // stable-keyed `materialize_labor_entries` outbox row; the worker runner
          // (apps/worker/src/runners/crew-schedule-confirm.ts) is the single
          // materializer, so the two paths are behaviorally equivalent. Per-entity
          // idempotency key (NOT per-state_version) so a replay upserts one row.
          await recordMutationLedger(c, {
            companyId: ctx.company.id,
            entityType: 'crew_schedule',
            entityId: scheduleId,
            action: 'materialize_labor_entries',
            mutationType: 'materialize_labor_entries',
            row: schedule,
            syncPayload: { action: 'confirm', schedule },
            outboxPayload: {
              schedule_id: schedule.id,
              project_id: schedule.project_id,
              scheduled_for: schedule.scheduled_for,
              crew: schedule.crew,
              confirmed_by: next.confirmed_by ?? ctx.currentUserId,
              entries,
            },
            idempotencyKey: `crew_schedule:materialize_labor:${schedule.id}`,
          })
        },
      }),
    )
    if (result.kind === 'not_found') {
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
    if (result.kind === 'version_conflict') {
      // Unreachable: expectedStateVersion echoes the locked row's own
      // state_version. Kept so the dispatch-result arms stay exhaustive.
      throw new Error('crew schedule confirm dispatched against a stale state_version')
    }
    if (result.kind === 'illegal_transition') {
      // Already-confirmed row: treat as a no-op success rather than a
      // 500. The SPA hits /confirm idempotently after offline replay,
      // and we don't want a 4xx if the row already moved.
      if (result.row.status === 'confirmed') {
        ctx.sendJson(200, { schedule: result.row, laborEntries: [] })
        return true
      }
      // Any other illegal transition (e.g. a declined row) keeps the
      // legacy rethrow → generic 500 path.
      throw new Error(result.message)
    }
    ctx.sendJson(200, { schedule: result.row, laborEntries: [] })
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
        select project_id, scheduled_for, crew, start_time, end_time, takeoff_measurement_id, scope
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
        // pg returns the `date` column `scheduled_for` as a JS Date
        // (and over the wire it can also arrive as a full ISO string).
        // `new Date(scheduled_for)` parses both shapes correctly, whereas
        // appending `T00:00:00Z` to either produces an Invalid Date and
        // makes the downstream toISOString() throw RangeError.
        const offsetDays = Math.round(
          (new Date(src.scheduled_for).getTime() - new Date(`${fromMonday}T00:00:00Z`).getTime()) / 86_400_000,
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
          insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version,
                                      start_time, end_time, takeoff_measurement_id, scope)
          values ($1, $2, $3::date, $4::jsonb, 'draft', 1, $5, $6, $7, $8)
          returning id, project_id, scheduled_for, crew, status, version, created_at,
                    start_time, end_time, takeoff_measurement_id, scope
          `,
          [
            ctx.company.id,
            src.project_id,
            targetISO,
            JSON.stringify(src.crew),
            src.start_time,
            src.end_time,
            src.takeoff_measurement_id,
            src.scope ?? null,
          ],
        )
        const row = insert.rows[0]
        if (!row) throw new HttpError(500, 'crew schedule copy insert returned no row')
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

/**
 * Self-registered dispatch descriptor for the `schedules` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const schedulesRouteDescriptor: DispatchRouteDescriptor = {
  name: 'schedules',
  order: 570,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion }) =>
    handleScheduleRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      checkVersion,
    }),
}

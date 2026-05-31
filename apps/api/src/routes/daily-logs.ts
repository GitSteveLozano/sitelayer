import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidDateInput, isValidUuid } from '../http-utils.js'
import { parseDailyLogPhotoMultipart, DailyLogPhotoUploadError } from '../daily-log-photo-upload.js'
import { type BlueprintStorage, assertKeyInCompany } from '../storage.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import {
  dailyLogStatusToWorkflowState,
  dailyLogWorkflow,
  nextDailyLogEvents,
  parseDailyLogEventRequest,
  type DailyLogHumanEventType,
  type DailyLogWorkflowEvent,
  type DailyLogWorkflowSnapshot,
  type DailyLogWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'

export type DailyLogRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  /** Storage + photo upload limit; supplied from the dispatch layer. */
  storage: BlueprintStorage
  /** Per-photo cap (bytes). Not the JSON body limit. */
  maxPhotoBytes: number
  /** Whether the daily-log photo download path returns presigned URLs. */
  photoDownloadPresigned: boolean
  /** Stream-back response shaping for photo downloads. */
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void
}

const DAILY_LOG_COLUMNS = `
  id, company_id, project_id, occurred_on, foreman_user_id,
  scope_progress, weather, notes, schedule_deviations,
  crew_summary, photo_keys, status, submitted_at,
  origin, version, state_version, created_at, updated_at
`

type DailyLogRow = {
  id: string
  company_id: string
  project_id: string
  occurred_on: string
  foreman_user_id: string
  scope_progress: unknown
  weather: unknown
  notes: string | null
  schedule_deviations: unknown
  crew_summary: unknown
  photo_keys: string[]
  status: 'draft' | 'submitted'
  submitted_at: string | null
  origin: string | null
  version: number
  state_version: number
  created_at: string
  updated_at: string
}

type DailyLogPhotoRow = {
  id: string
  storage_key: string
  scope_step_id: string | null
  scope_step_label: string | null
  captured_at: string
}

/**
 * The `context` carried inside the daily-log `WorkflowSnapshot`. The
 * reducer's own snapshot is intentionally narrow (state/state_version/
 * submitted_at/submitted_by); the editor screens still need the full
 * entity, so the snapshot context surfaces the whole row. `next_events`
 * is always computed from the registered reducer's `nextDailyLogEvents`,
 * never hand-listed — that is the UI-bypass guard.
 */
type DailyLogWorkflowContext = {
  id: string
  project_id: string
  occurred_on: string
  foreman_user_id: string
  status: 'draft' | 'submitted'
  scope_progress: unknown
  weather: unknown
  notes: string | null
  schedule_deviations: unknown
  crew_summary: unknown
  photo_keys: string[]
  submitted_at: string | null
  version: number
  state_version: number
  origin: string | null
  created_at: string
  updated_at: string
}

function rowToDailyLogSnapshot(
  row: DailyLogRow,
): WorkflowSnapshot<DailyLogWorkflowState, DailyLogHumanEventType, DailyLogWorkflowContext> {
  const state = dailyLogStatusToWorkflowState(row.status)
  return {
    state,
    state_version: row.state_version,
    next_events: nextDailyLogEvents(state),
    context: {
      id: row.id,
      project_id: row.project_id,
      occurred_on: row.occurred_on,
      foreman_user_id: row.foreman_user_id,
      status: row.status,
      scope_progress: row.scope_progress,
      weather: row.weather,
      notes: row.notes,
      schedule_deviations: row.schedule_deviations,
      crew_summary: row.crew_summary,
      photo_keys: row.photo_keys,
      submitted_at: row.submitted_at,
      version: row.version,
      state_version: row.state_version,
      origin: row.origin,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }
}

/**
 * Shared in-tx SUBMIT dispatch for both the canonical `/events` route
 * and the legacy `/submit` alias, so the two surfaces can never drift.
 * Runs the registered daily_log reducer through the generic
 * `dispatchWorkflowEvent` primitive: FOR UPDATE lock + post-lock
 * state_version check + pure reduce + the single UPDATE + the
 * always-appended workflow_event_log row + the `daily_log:submit:<id>`
 * ledger row. Returns the discriminated dispatch result so the caller
 * maps it to 200/404/409.
 */
function dispatchDailyLogSubmit(
  client: PoolClient,
  ctx: DailyLogRouteCtx,
  id: string,
  ownerFilter: string,
  /**
   * The workflow state_version the caller is acting on. `null` disables
   * the optimistic check (the legacy /submit path, which gates on the
   * content `expected_version` instead). We capture the resolved value so
   * the primitive's post-lock compare is satisfied with the row's own
   * state_version when the caller opts out.
   */
  expectedStateVersion: number | null,
) {
  // For the legacy null path, capture the locked row's state_version and
  // feed it back as the "expected" version so the primitive's optimistic
  // check is a no-op. We can't know it before the lock, so a mutable slot
  // bridges loadSnapshot → expectedStateVersion.
  let resolvedExpected = expectedStateVersion ?? -1
  return dispatchWorkflowEvent<DailyLogRow, DailyLogWorkflowSnapshot, DailyLogWorkflowEvent>(client, {
    definition: dailyLogWorkflow,
    companyId: ctx.company.id,
    entityType: 'daily_log',
    entityId: id,
    get expectedStateVersion() {
      return resolvedExpected
    },
    actorUserId: ctx.currentUserId,
    loadSnapshot: async (c) => {
      const locked = await c.query<DailyLogRow>(
        `select ${DAILY_LOG_COLUMNS}
         from daily_logs
         where company_id = $1
           and id = $2
           and ($3 = '' or foreman_user_id = $3)
         for update`,
        [ctx.company.id, id, ownerFilter],
      )
      const row = locked.rows[0]
      if (!row) return null
      if (expectedStateVersion === null) resolvedExpected = row.state_version
      return {
        row,
        snapshot: {
          state: dailyLogStatusToWorkflowState(row.status),
          state_version: row.state_version,
          submitted_at: row.submitted_at,
          submitted_by: null,
        },
      }
    },
    buildEvent: () => ({
      type: 'SUBMIT',
      submitted_at: new Date().toISOString(),
      submitted_by: ctx.currentUserId,
    }),
    persist: async (c, next) => {
      const updateResult = await c.query<DailyLogRow>(
        `update daily_logs
           set status = $4,
               state_version = $5,
               submitted_at = $6::timestamptz,
               version = version + 1,
               updated_at = now()
         where company_id = $1
           and id = $2
           and ($3 = '' or foreman_user_id = $3)
           and status = 'draft'
         returning ${DAILY_LOG_COLUMNS}`,
        [ctx.company.id, id, ownerFilter, next.state, next.state_version, next.submitted_at],
      )
      const row = updateResult.rows[0]
      if (!row) throw new HttpError(500, 'daily log submit update returned no row')
      return row
    },
    sideEffects: async (c, _next, row) => {
      await recordMutationLedger(c, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: row.id,
        action: 'submit',
        row,
        actorUserId: ctx.currentUserId,
        idempotencyKey: `daily_log:submit:${row.id}`,
      })
    },
  })
}

/**
 * Foreman daily logs (Sitemap.html § fm-log).
 *
 * - GET    /api/daily-logs?project_id&from&to&status
 * - GET    /api/daily-logs/:id              raw row (list/photo consumers)
 * - GET    /api/daily-logs/:id/snapshot     WorkflowSnapshot {state,state_version,context,next_events}
 * - POST   /api/daily-logs                  create draft (or upsert today's
 *                                           draft for current foreman)
 * - PATCH  /api/daily-logs/:id              update draft (version-checked)
 * - POST   /api/daily-logs/:id/events       { event:'SUBMIT', state_version } → submitted
 * - POST   /api/daily-logs/:id/submit       DEPRECATED alias → submitted
 *
 * Foreman role required for write paths; admin/office can read all.
 * Worker role can't see daily logs (the Worker tab in the design has no
 * route to them).
 */
export async function handleDailyLogRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: DailyLogRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/daily-logs') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = String(url.searchParams.get('project_id') ?? '').trim()
    const from = String(url.searchParams.get('from') ?? '').trim()
    const to = String(url.searchParams.get('to') ?? '').trim()
    const status = String(url.searchParams.get('status') ?? '').trim()
    if (projectId && !isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
      return true
    }
    if (from && !isValidDateInput(from)) {
      ctx.sendJson(400, { error: 'from must be YYYY-MM-DD' })
      return true
    }
    if (to && !isValidDateInput(to)) {
      ctx.sendJson(400, { error: 'to must be YYYY-MM-DD' })
      return true
    }
    if (status && status !== 'draft' && status !== 'submitted') {
      ctx.sendJson(400, { error: 'status must be draft or submitted' })
      return true
    }

    // Foreman role only sees their own logs (the design's wk-log
    // surface is per-foreman). Admin/office see every log on the
    // company so they can audit submissions.
    const foremanFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''

    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<DailyLogRow>(
        `select ${DAILY_LOG_COLUMNS}
       from daily_logs
       where company_id = $1
         and ($2 = '' or project_id = $2::uuid)
         and ($3 = '' or occurred_on >= $3::date)
         and ($4 = '' or occurred_on <= $4::date)
         and ($5 = '' or status = $5)
         and ($6 = '' or foreman_user_id = $6)
       order by occurred_on desc, created_at desc
       limit 200`,
        [ctx.company.id, projectId, from, to, status, foremanFilter],
      ),
    )
    ctx.sendJson(200, { dailyLogs: result.rows })
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    // Foreman can only read their own log; admin/office unrestricted.
    // Without this filter a foreman could read another foreman's log
    // by guessing the uuid (the list endpoint already isolates by
    // foreman_user_id; the detail path must match).
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<DailyLogRow>(
        `select ${DAILY_LOG_COLUMNS}
       from daily_logs
       where company_id = $1 and id = $2
         and ($3 = '' or foreman_user_id = $3)
       limit 1`,
        [ctx.company.id, id, ownerFilter],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'daily log not found' })
      return true
    }
    ctx.sendJson(200, { dailyLog: result.rows[0] })
    return true
  }

  // GET /api/daily-logs/:id/snapshot → canonical WorkflowSnapshot
  // { state, state_version, context, next_events }. The editor screens
  // read this; the raw-row GET above stays for list/photo-timeline
  // consumers that want the bare row.
  const snapshotMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)\/snapshot$/)
  if (req.method === 'GET' && snapshotMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = snapshotMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<DailyLogRow>(
        `select ${DAILY_LOG_COLUMNS}
       from daily_logs
       where company_id = $1 and id = $2
         and ($3 = '' or foreman_user_id = $3)
       limit 1`,
        [ctx.company.id, id, ownerFilter],
      ),
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'daily log not found' })
      return true
    }
    ctx.sendJson(200, rowToDailyLogSnapshot(result.rows[0]))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/daily-logs') {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const body = await ctx.readBody()
    const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : ''
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id is required and must be a valid uuid' })
      return true
    }
    const occurredOn =
      typeof body.occurred_on === 'string' && isValidDateInput(body.occurred_on)
        ? body.occurred_on
        : new Date().toISOString().slice(0, 10)

    // Upsert: if a draft already exists for (project, day, foreman), return it.
    // The unique constraint guarantees we can ON CONFLICT DO NOTHING + RETURNING
    // to make this idempotent without an explicit transaction.
    const projectExists = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string }>(
        `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
        [ctx.company.id, projectId],
      ),
    )
    if (!projectExists.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    const created = await withMutationTx(async (client: PoolClient) => {
      const upsert = await client.query<DailyLogRow>(
        `insert into daily_logs (
           company_id, project_id, occurred_on, foreman_user_id,
           scope_progress, weather, notes, schedule_deviations, crew_summary, photo_keys
         )
         values ($1, $2, $3, $4, '[]'::jsonb, null, null, '[]'::jsonb, '[]'::jsonb, '{}')
         on conflict (company_id, project_id, occurred_on, foreman_user_id) do update
           set updated_at = daily_logs.updated_at
         returning ${DAILY_LOG_COLUMNS}`,
        [ctx.company.id, projectId, occurredOn, ctx.currentUserId],
      )
      const row = upsert.rows[0]
      if (!row) throw new HttpError(500, 'daily log upsert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: row.id,
        action: 'create',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })

    ctx.sendJson(201, { dailyLog: created })
    return true
  }

  if (req.method === 'PATCH' && detailMatch) {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = typeof body.expected_version === 'number' ? body.expected_version : null
    const versionOk = await ctx.checkVersion(
      'daily_logs',
      'company_id = $1 and id = $2',
      [ctx.company.id, id],
      expectedVersion,
    )
    if (!versionOk) return true

    const setClauses: string[] = []
    const params: unknown[] = [ctx.company.id, id]
    const pushSet = (column: string, raw: unknown, cast?: string) => {
      params.push(cast === 'jsonb' ? JSON.stringify(raw) : raw)
      setClauses.push(cast ? `${column} = $${params.length}::${cast}` : `${column} = $${params.length}`)
    }
    if (body.scope_progress !== undefined) pushSet('scope_progress', body.scope_progress, 'jsonb')
    if (body.weather !== undefined) pushSet('weather', body.weather, 'jsonb')
    if (body.notes !== undefined) pushSet('notes', typeof body.notes === 'string' ? body.notes.slice(0, 16_000) : null)
    if (body.schedule_deviations !== undefined) pushSet('schedule_deviations', body.schedule_deviations, 'jsonb')
    if (body.crew_summary !== undefined) pushSet('crew_summary', body.crew_summary, 'jsonb')
    if (Array.isArray(body.photo_keys)) {
      pushSet(
        'photo_keys',
        body.photo_keys.filter((k): k is string => typeof k === 'string'),
      )
    }
    if (setClauses.length === 0) {
      ctx.sendJson(400, { error: 'no editable fields supplied' })
      return true
    }

    // Foreman ownership: a foreman can only PATCH their own draft.
    // Admin / office may PATCH any draft (e.g. correcting a foreman's
    // entry before submission). We add the ownership predicate to the
    // WHERE rather than running a separate ownership SELECT so the
    // check is atomic with the update.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    params.push(ownerFilter)

    const updated = await withMutationTx(async (client: PoolClient) => {
      const updateResult = await client.query<DailyLogRow>(
        `update daily_logs
           set ${setClauses.join(', ')},
               version = version + 1,
               updated_at = now()
         where company_id = $1
           and id = $2
           and status = 'draft'
           and ($${params.length} = '' or foreman_user_id = $${params.length})
         returning ${DAILY_LOG_COLUMNS}`,
        params,
      )
      const row = updateResult.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: row.id,
        action: 'update',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })

    if (!updated) {
      ctx.sendJson(409, { error: 'daily log not found, already submitted, or not yours to edit' })
      return true
    }
    ctx.sendJson(200, { dailyLog: updated })
    return true
  }

  // POST /api/daily-logs/:id/events — canonical { event, state_version }
  // surface. Dispatches the registered daily_log reducer through the
  // generic workflow primitive (FOR UPDATE lock + state_version check +
  // pure reduce + UPDATE + workflow_event_log + daily_log:submit ledger).
  // The reducer's only human event is SUBMIT; parseDailyLogEventRequest
  // rejects anything else (and coerces a numeric-string state_version for
  // offline replay).
  const eventsMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventsMatch) {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const id = eventsMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseDailyLogEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { state_version: stateVersion } = parsed.value

    // Foreman can only submit their own draft. Admin/office unrestricted.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''

    const result = await withMutationTx((client: PoolClient) =>
      dispatchDailyLogSubmit(client, ctx, id, ownerFilter, stateVersion),
    )

    if (result.kind === 'not_found') {
      // Collapse not-found / not-yours to the legacy 409 so a foreman
      // probing another foreman's id cannot distinguish "missing" from
      // "not yours" (matches the /submit and PATCH ownership behaviour).
      ctx.sendJson(409, { error: 'daily log not found, already submitted, or not yours to submit' })
      return true
    }
    if (result.kind === 'version_conflict') {
      ctx.sendJson(409, {
        error: 'state_version mismatch — reload and retry',
        snapshot: rowToDailyLogSnapshot(result.row),
      })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, {
        error: result.message,
        snapshot: rowToDailyLogSnapshot(result.row),
      })
      return true
    }
    ctx.sendJson(200, rowToDailyLogSnapshot(result.row))
    return true
  }

  // POST /api/daily-logs/:id/submit — DEPRECATED legacy alias kept for one
  // release so already-enqueued offline mutations (and old clients) still
  // submit cleanly. It delegates to the same in-tx dispatch as /events so
  // the two surfaces cannot drift. Legacy clients send the content
  // `expected_version`; we translate it to the locked row's state_version
  // inside the tx so a stale content version still 409s.
  const submitMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)\/submit$/)
  if (req.method === 'POST' && submitMatch) {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const id = submitMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const expectedVersion = typeof body.expected_version === 'number' ? body.expected_version : null
    const versionOk = await ctx.checkVersion(
      'daily_logs',
      'company_id = $1 and id = $2',
      [ctx.company.id, id],
      expectedVersion,
    )
    if (!versionOk) return true

    // Foreman can only submit their own draft. Admin/office unrestricted.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''

    // Legacy callers do not send a workflow state_version (they gate on
    // the content `expected_version` checked above). Delegate to the same
    // in-tx dispatch as /events with the post-lock state_version check
    // disabled, so the only remaining gate is the draft→submitted reducer
    // transition and the two surfaces cannot drift.
    const result = await withMutationTx((client: PoolClient) =>
      dispatchDailyLogSubmit(client, ctx, id, ownerFilter, null),
    )

    // version_conflict can't happen with the check disabled; not_found /
    // illegal_transition both collapse to the legacy 409.
    if (result.kind !== 'ok') {
      ctx.sendJson(409, { error: 'daily log not found, already submitted, or not yours to submit' })
      return true
    }
    ctx.sendJson(200, { dailyLog: result.row })
    return true
  }

  // ----- Photo upload / delete / fetch -----------------------------------
  // POST   /api/daily-logs/:id/photos              multipart upload, append key
  // DELETE /api/daily-logs/:id/photos              { key } JSON body, remove from
  //                                                photo_keys + storage
  // GET    /api/daily-logs/:id/photos/file?key=    return presigned URL or stream

  const photoUploadMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)\/photos$/)
  if (req.method === 'POST' && photoUploadMatch) {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const id = photoUploadMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }

    // Owner check + status check rolled into one read so we don't upload
    // bytes for a row that's submitted (locked) or not visible.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const existing = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string; status: string; foreman_user_id: string }>(
        `select id, status, foreman_user_id
       from daily_logs
       where company_id = $1 and id = $2
         and ($3 = '' or foreman_user_id = $3)
       limit 1`,
        [ctx.company.id, id, ownerFilter],
      ),
    )
    const row = existing.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'daily log not found or not yours' })
      return true
    }
    if (row.status !== 'draft') {
      ctx.sendJson(409, { error: 'daily log already submitted; photos are locked' })
      return true
    }

    let upload
    try {
      upload = await parseDailyLogPhotoMultipart(req, ctx.storage, ctx.company.id, id, 'photo.jpg', {
        maxFileBytes: ctx.maxPhotoBytes,
      })
    } catch (err) {
      if (err instanceof DailyLogPhotoUploadError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    // Pull scope-step metadata from the multipart fields. Both are
    // optional — workers may capture before tapping a step, foreman/admin
    // may upload outside of any step. We persist label denormalized so
    // the timeline keeps rendering even after a brief step is edited.
    const rawStepId = typeof upload.fields.scope_step_id === 'string' ? upload.fields.scope_step_id.trim() : ''
    const scopeStepId = rawStepId && isValidUuid(rawStepId) ? rawStepId : null
    const rawStepLabel = typeof upload.fields.scope_step_label === 'string' ? upload.fields.scope_step_label.trim() : ''
    const scopeStepLabel = rawStepLabel ? rawStepLabel.slice(0, 200) : null

    // Append the key to photo_keys (back-compat), bump version, and
    // insert a row in daily_log_photos with the scope-step metadata.
    const result = await withMutationTx(async (client: PoolClient) => {
      const update = await client.query<DailyLogRow>(
        `update daily_logs
           set photo_keys = array_append(photo_keys, $3),
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and status = 'draft'
         returning ${DAILY_LOG_COLUMNS}`,
        [ctx.company.id, id, upload.storagePath],
      )
      const updatedRow = update.rows[0]
      if (!updatedRow) return null
      const photoInsert = await client.query<DailyLogPhotoRow>(
        `insert into daily_log_photos (
           company_id, daily_log_id, storage_key, scope_step_id, scope_step_label
         )
         values ($1, $2, $3, $4, $5)
         on conflict (daily_log_id, storage_key) do update
           set scope_step_id = excluded.scope_step_id,
               scope_step_label = excluded.scope_step_label
         returning id, storage_key, scope_step_id, scope_step_label, captured_at`,
        [ctx.company.id, updatedRow.id, upload.storagePath, scopeStepId, scopeStepLabel],
      )
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: updatedRow.id,
        action: 'photo_add',
        row: updatedRow,
        actorUserId: ctx.currentUserId,
      })
      return { dailyLog: updatedRow, photoRow: photoInsert.rows[0] ?? null }
    })

    if (!result) {
      ctx.sendJson(409, { error: 'daily log changed during upload — refresh and retry' })
      return true
    }
    ctx.sendJson(201, {
      dailyLog: result.dailyLog,
      photo: {
        key: upload.storagePath,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        bytes: upload.bytes,
        scope_step_id: result.photoRow?.scope_step_id ?? null,
        scope_step_label: result.photoRow?.scope_step_label ?? null,
        captured_at: result.photoRow?.captured_at ?? null,
      },
    })
    return true
  }

  // GET /api/daily-logs/:id/photos — list per-photo metadata for the
  // timeline (scope_step_id / scope_step_label / captured_at).
  if (req.method === 'GET' && photoUploadMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = photoUploadMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const ownership = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ exists: boolean }>(
        `select exists(
         select 1 from daily_logs
         where company_id = $1 and id = $2
           and ($3 = '' or foreman_user_id = $3)
       ) as exists`,
        [ctx.company.id, id, ownerFilter],
      ),
    )
    if (!ownership.rows[0]?.exists) {
      ctx.sendJson(404, { error: 'daily log not found or not yours' })
      return true
    }
    const photos = await withCompanyClient(ctx.company.id, (c) =>
      c.query<DailyLogPhotoRow>(
        `select id, storage_key, scope_step_id, scope_step_label, captured_at
       from daily_log_photos
       where company_id = $1 and daily_log_id = $2
       order by captured_at asc, id asc`,
        [ctx.company.id, id],
      ),
    )
    ctx.sendJson(200, { photos: photos.rows })
    return true
  }

  if (req.method === 'DELETE' && photoUploadMatch) {
    if (!ctx.requireRole(['foreman', 'admin', 'office'])) return true
    const id = photoUploadMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key) {
      ctx.sendJson(400, { error: 'key is required' })
      return true
    }
    // Defense-in-depth: refuse keys that don't belong to this company.
    try {
      assertKeyInCompany(ctx.company.id, key)
    } catch (err) {
      ctx.sendJson(400, { error: err instanceof Error ? err.message : 'invalid key' })
      return true
    }

    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<DailyLogRow>(
        `update daily_logs
           set photo_keys = array_remove(photo_keys, $3),
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and status = 'draft'
           and ($4 = '' or foreman_user_id = $4)
           and $3 = any(photo_keys)
         returning ${DAILY_LOG_COLUMNS}`,
        [ctx.company.id, id, key, ownerFilter],
      )
      const updatedRow = result.rows[0]
      if (!updatedRow) return null
      await client.query(
        `delete from daily_log_photos
         where company_id = $1 and daily_log_id = $2 and storage_key = $3`,
        [ctx.company.id, updatedRow.id, key],
      )
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: updatedRow.id,
        action: 'photo_remove',
        row: updatedRow,
        actorUserId: ctx.currentUserId,
      })
      return updatedRow
    })

    if (!updated) {
      ctx.sendJson(404, { error: 'photo not found on this daily log' })
      return true
    }
    // Best-effort blob delete — orphaned objects are tolerable; failing
    // the request after we've already rotated the row would leave the UI
    // in a confusing state.
    // (Storage abstraction doesn't currently expose a delete; the blob
    // becomes orphaned. Phase 2 nightly GC sweeps `daily-logs/<id>/`
    // keys not referenced by any row. Recording the action above gives
    // that sweeper its input.)
    ctx.sendJson(200, { dailyLog: updated })
    return true
  }

  const photoFetchMatch = url.pathname.match(/^\/api\/daily-logs\/([^/]+)\/photos\/file$/)
  if (req.method === 'GET' && photoFetchMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = photoFetchMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const key = String(url.searchParams.get('key') ?? '').trim()
    if (!key) {
      ctx.sendJson(400, { error: 'key is required' })
      return true
    }
    try {
      assertKeyInCompany(ctx.company.id, key)
    } catch (err) {
      ctx.sendJson(400, { error: err instanceof Error ? err.message : 'invalid key' })
      return true
    }

    // Confirm the key belongs to this row before exposing the bytes.
    const ownerFilter = ctx.company.role === 'foreman' ? ctx.currentUserId : ''
    const ownership = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ exists: boolean }>(
        `select exists(
         select 1 from daily_logs
         where company_id = $1 and id = $2
           and $3 = any(photo_keys)
           and ($4 = '' or foreman_user_id = $4)
       ) as exists`,
        [ctx.company.id, id, key, ownerFilter],
      ),
    )
    if (!ownership.rows[0]?.exists) {
      ctx.sendJson(404, { error: 'photo not found on this daily log' })
      return true
    }

    if (ctx.photoDownloadPresigned) {
      const url = await ctx.storage.getDownloadUrl(key)
      if (url) {
        ctx.sendFileRedirect(url)
        return true
      }
    }
    const buf = await ctx.storage.get(key)
    const fileName = key.split('/').pop() || 'photo.jpg'
    const mime = inferMimeFromName(fileName)
    ctx.sendFileContent(mime, fileName, buf)
    return true
  }

  return false
}

function inferMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'heic') return 'image/heic'
  if (ext === 'heif') return 'image/heif'
  return 'application/octet-stream'
}

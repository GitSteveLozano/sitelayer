import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, isValidUuid } from '../http-utils.js'

export type DailyLogRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

const DAILY_LOG_COLUMNS = `
  id, company_id, project_id, occurred_on, foreman_user_id,
  scope_progress, weather, notes, schedule_deviations,
  crew_summary, photo_keys, status, submitted_at,
  origin, version, created_at, updated_at
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
  created_at: string
  updated_at: string
}

/**
 * Foreman daily logs (Sitemap.html § fm-log).
 *
 * - GET    /api/daily-logs?project_id&from&to&status
 * - GET    /api/daily-logs/:id
 * - POST   /api/daily-logs                  create draft (or upsert today's
 *                                           draft for current foreman)
 * - PATCH  /api/daily-logs/:id              update draft (version-checked)
 * - POST   /api/daily-logs/:id/submit       draft → submitted
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

    const result = await ctx.pool.query<DailyLogRow>(
      `select ${DAILY_LOG_COLUMNS}
       from daily_logs
       where company_id = $1
         and ($2 = '' or project_id = $2::uuid)
         and ($3 = '' or occurred_on >= $3::date)
         and ($4 = '' or occurred_on <= $4::date)
         and ($5 = '' or status = $5)
       order by occurred_on desc, created_at desc
       limit 200`,
      [ctx.company.id, projectId, from, to, status],
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
    const result = await ctx.pool.query<DailyLogRow>(
      `select ${DAILY_LOG_COLUMNS}
       from daily_logs
       where company_id = $1 and id = $2
       limit 1`,
      [ctx.company.id, id],
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'daily log not found' })
      return true
    }
    ctx.sendJson(200, { dailyLog: result.rows[0] })
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
    const projectExists = await ctx.pool.query<{ id: string }>(
      `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
      [ctx.company.id, projectId],
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
      const row = upsert.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: row.id,
        action: 'create',
        row: row as unknown as Record<string, unknown>,
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

    const updated = await withMutationTx(async (client: PoolClient) => {
      const updateResult = await client.query<DailyLogRow>(
        `update daily_logs
           set ${setClauses.join(', ')},
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and status = 'draft'
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
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })

    if (!updated) {
      ctx.sendJson(409, { error: 'daily log not found or already submitted' })
      return true
    }
    ctx.sendJson(200, { dailyLog: updated })
    return true
  }

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

    const submitted = await withMutationTx(async (client: PoolClient) => {
      const updateResult = await client.query<DailyLogRow>(
        `update daily_logs
           set status = 'submitted',
               submitted_at = now(),
               version = version + 1,
               updated_at = now()
         where company_id = $1 and id = $2 and status = 'draft'
         returning ${DAILY_LOG_COLUMNS}`,
        [ctx.company.id, id],
      )
      const row = updateResult.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'daily_log',
        entityId: row.id,
        action: 'submit',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
        idempotencyKey: `daily_log:submit:${row.id}`,
      })
      return row
    })

    if (!submitted) {
      ctx.sendJson(409, { error: 'daily log not found or already submitted' })
      return true
    }
    ctx.sendJson(200, { dailyLog: submitted })
    return true
  }

  return false
}

import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'

// POST /api/projects/:id/briefs wire-format. `goal` + `effective_date` are
// required downstream (the handler 400s on blank/invalid). steps/crew/
// materials are JSON arrays the handler runs through `parseJsonArray`
// (anything non-array falls back to []); typed as arrays here without
// validating inner shape. `.loose()` keeps unknown keys.
const ProjectBriefCreateBodySchema = z
  .object({
    goal: z.string().optional(),
    effective_date: z.string().optional(),
    steps: z.array(z.unknown()).nullish(),
    crew: z.array(z.unknown()).nullish(),
    materials: z.array(z.unknown()).nullish(),
  })
  .loose()

/**
 * Foreman morning brief routes (`fm-brief`). The brief is a write-only
 * record of "what the crew is building today" plus optional structured
 * steps/crew/materials. Workers read the most-recent brief for their
 * project on `wk-today` and `wk-scope`.
 *
 * - POST  /api/projects/:id/briefs               create or upsert today's
 *                                                brief for the actor; goal
 *                                                + effective_date required.
 * - GET   /api/projects/:id/briefs?date=Y-M-D    list briefs for a project
 *                                                (most recent first), or
 *                                                a specific day if ?date=
 *                                                is provided.
 *
 * Concurrency: the unique index (company, project, effective_date,
 * foreman_user_id) lets us upsert idempotently — a foreman re-submitting
 * later in the morning updates their existing row instead of writing a
 * duplicate. The non-foreman roles (admin/office) submit on their own
 * key so it doesn't clobber a foreman who later submits.
 */
export type ProjectBriefRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type BriefRow = {
  id: string
  company_id: string
  project_id: string
  foreman_user_id: string
  effective_date: string
  goal: string
  steps: unknown
  crew: unknown
  materials: unknown
  version: number
  created_at: string
  updated_at: string
}

const BRIEF_COLUMNS = `
  id, company_id, project_id, foreman_user_id, effective_date,
  goal, steps, crew, materials, version, created_at, updated_at
`

function isValidDateInput(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return []
}

export async function handleProjectBriefRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectBriefRouteCtx,
): Promise<boolean> {
  const createMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/briefs$/)
  if (req.method === 'POST' && createMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const projectId = createMatch[1]!
    const parsed = parseJsonBody(ProjectBriefCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      ctx.sendJson(400, { error: 'goal is required' })
      return true
    }
    if (goal.length > 2000) {
      ctx.sendJson(400, { error: 'goal must be 2000 characters or fewer' })
      return true
    }
    const effectiveDate = isValidDateInput(body.effective_date) ? body.effective_date : null
    if (!effectiveDate) {
      ctx.sendJson(400, { error: 'effective_date must be YYYY-MM-DD' })
      return true
    }
    const steps = parseJsonArray(body.steps)
    const crew = parseJsonArray(body.crew)
    const materials = parseJsonArray(body.materials)

    // Verify the project exists in this company.
    const projectCheck = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string }>(`select id from projects where company_id = $1 and id = $2 limit 1`, [
        ctx.company.id,
        projectId,
      ]),
    )
    if (!projectCheck.rows[0]) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }

    const inserted = await withMutationTx(async (client) => {
      const result = await client.query<BriefRow>(
        `insert into project_briefs
           (company_id, project_id, foreman_user_id, effective_date,
            goal, steps, crew, materials)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
         on conflict (company_id, project_id, effective_date, foreman_user_id)
         do update set
           goal = excluded.goal,
           steps = excluded.steps,
           crew = excluded.crew,
           materials = excluded.materials,
           version = project_briefs.version + 1,
           updated_at = now()
         returning ${BRIEF_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          ctx.currentUserId,
          effectiveDate,
          goal,
          JSON.stringify(steps),
          JSON.stringify(crew),
          JSON.stringify(materials),
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('project_briefs upsert returned no row')
      return row
    })
    ctx.sendJson(201, { brief: inserted })
    return true
  }

  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/briefs$/)
  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    const dateParam = url.searchParams.get('date')
    if (dateParam !== null && !isValidDateInput(dateParam)) {
      ctx.sendJson(400, { error: 'date must be YYYY-MM-DD' })
      return true
    }
    const result = dateParam
      ? await withCompanyClient(ctx.company.id, (c) =>
          c.query<BriefRow>(
            `select ${BRIEF_COLUMNS}
           from project_briefs
           where company_id = $1 and project_id = $2 and effective_date = $3
           order by created_at desc`,
            [ctx.company.id, projectId, dateParam],
          ),
        )
      : await withCompanyClient(ctx.company.id, (c) =>
          c.query<BriefRow>(
            `select ${BRIEF_COLUMNS}
           from project_briefs
           where company_id = $1 and project_id = $2
           order by effective_date desc, created_at desc
           limit 30`,
            [ctx.company.id, projectId],
          ),
        )
    ctx.sendJson(200, { briefs: result.rows })
    return true
  }

  return false
}

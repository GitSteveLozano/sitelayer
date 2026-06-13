import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany } from '../auth-types.js'
import { parseJsonBody } from '../http-utils.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

// POST /api/projects/:id/assignments wire-format. Both fields are validated
// downstream (clerk_user_id non-empty; role ∈ foreman|worker) — the schema
// just rejects non-string shapes up front. `.loose()` keeps unknown keys.
const AssignmentCreateBodySchema = z
  .object({
    clerk_user_id: z.string().optional(),
    role: z.string().optional(),
  })
  .loose()

export type ProjectAssignmentRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  getCurrentUserId: () => string
}

// Columns shared by every assignment read. `assignee_name` / `assignee_email`
// are resolved from the global clerk_users mirror (096_clerk_user_mirror.sql)
// via LEFT JOIN — null when the webhook hasn't mirrored that identity yet, so
// the client falls back to the clerk_user_id. The name is composed from
// first/last (either may be null) and trimmed; an all-null name stays null
// rather than becoming an empty string.
const ASSIGNMENT_SELECT_COLUMNS = `
  pa.id, pa.project_id, pa.clerk_user_id, pa.role, pa.assigned_by_clerk_user_id,
  pa.created_at, pa.deleted_at,
  nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), '') as assignee_name,
  cu.email as assignee_email`

/**
 * Handle assignment requests. Returns true when the request matched a route in
 * this module (regardless of response status); false to let the parent
 * dispatch fall through. Routes:
 *   GET    /api/assignments                              -> company-wide list
 *   GET    /api/projects/:projectId/assignments          -> one project's list
 *   POST   /api/projects/:projectId/assignments          -> add (admin/office)
 *   DELETE /api/projects/:projectId/assignments/:id       -> remove (admin/office)
 *
 * Reads are open to any company member — useful for the foreman's "who's on
 * this site" view and the web portfolio "Assignments" screen. Writes are
 * admin/office-only.
 *
 * Both list routes resolve the assignee's name/email from the clerk_users
 * mirror (LEFT JOIN, falls back to the id when unmapped).
 */
export async function handleProjectAssignmentRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectAssignmentRouteCtx,
): Promise<boolean> {
  const companyListMatch = url.pathname.match(/^\/api\/assignments$/)
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assignments$/)
  const itemMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assignments\/([^/]+)$/)

  // Company-wide list: every project's assignments in one query, so the web
  // portfolio view doesn't fan out one request per project (N+1).
  if (req.method === 'GET' && companyListMatch) {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${ASSIGNMENT_SELECT_COLUMNS}
         from project_assignments pa
         left join clerk_users cu on cu.clerk_user_id = pa.clerk_user_id and cu.deleted_at is null
         where pa.company_id = $1 and pa.deleted_at is null
         order by pa.project_id asc, pa.created_at asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { assignments: result.rows })
    return true
  }

  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    if (!(await projectBelongsToCompany(ctx.pool, ctx.company.id, projectId))) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${ASSIGNMENT_SELECT_COLUMNS}
         from project_assignments pa
         left join clerk_users cu on cu.clerk_user_id = pa.clerk_user_id and cu.deleted_at is null
         where pa.company_id = $1 and pa.project_id = $2 and pa.deleted_at is null
         order by pa.created_at asc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { assignments: result.rows })
    return true
  }

  if (req.method === 'POST' && listMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = listMatch[1]!
    if (!(await projectBelongsToCompany(ctx.pool, ctx.company.id, projectId))) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const parsed = parseJsonBody(AssignmentCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const assignee = String(body.clerk_user_id ?? '').trim()
    const role = String(body.role ?? '').trim()
    if (!assignee) {
      ctx.sendJson(400, { error: 'clerk_user_id is required' })
      return true
    }
    if (role !== 'foreman' && role !== 'worker') {
      ctx.sendJson(400, { error: "role must be 'foreman' or 'worker'" })
      return true
    }
    const created = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        insert into project_assignments
          (company_id, project_id, clerk_user_id, role, assigned_by_clerk_user_id)
        values ($1, $2, $3, $4, $5)
        on conflict (project_id, clerk_user_id, role) where deleted_at is null
          do nothing
        returning id, project_id, clerk_user_id, role, assigned_by_clerk_user_id, created_at, deleted_at
        `,
        [ctx.company.id, projectId, assignee, role, ctx.getCurrentUserId()],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project_assignment',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    if (!created) {
      ctx.sendJson(409, { error: 'assignment already exists' })
      return true
    }
    ctx.sendJson(201, created)
    return true
  }

  if (req.method === 'DELETE' && itemMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = itemMatch[1]!
    const assignmentId = itemMatch[2]!
    const removed = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `
        update project_assignments
          set deleted_at = now()
          where company_id = $1 and project_id = $2 and id = $3 and deleted_at is null
        returning id, project_id, clerk_user_id, role, assigned_by_clerk_user_id, created_at, deleted_at
        `,
        [ctx.company.id, projectId, assignmentId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'project_assignment',
        entityId: row.id,
        action: 'delete',
        row,
      })
      return row
    })
    if (!removed) {
      ctx.sendJson(404, { error: 'assignment not found' })
      return true
    }
    ctx.sendJson(200, removed)
    return true
  }

  return false
}

async function projectBelongsToCompany(pool: Pool, companyId: string, projectId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>('select id from projects where company_id = $1 and id = $2 limit 1', [
    companyId,
    projectId,
  ])
  return result.rows.length > 0
}

/**
 * Self-registered dispatch descriptor for the `project-assignments` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const projectAssignmentsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'project-assignments',
  order: 300,
  handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, ctx }) =>
    handleProjectAssignmentRoutes(req, url, {
      pool,
      company,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      getCurrentUserId: ctx.getCurrentUserId,
    }),
}

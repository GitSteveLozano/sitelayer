import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'

export type ProjectAssignmentRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  getCurrentUserId: () => string
}

/**
 * Handle /api/projects/:projectId/assignments* requests. Returns true when
 * the request matched a route in this module (regardless of response status);
 * false to let the parent dispatch fall through.
 *
 * Reads are open to any company member — useful for the foreman's "who's on
 * this site" view. Writes are admin-only — only company admins assign or
 * remove foreman/worker roles.
 */
export async function handleProjectAssignmentRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectAssignmentRouteCtx,
): Promise<boolean> {
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assignments$/)
  const itemMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assignments\/([^/]+)$/)

  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    if (!(await projectBelongsToCompany(ctx.pool, ctx.company.id, projectId))) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select id, project_id, clerk_user_id, role, assigned_by_clerk_user_id, created_at, deleted_at
         from project_assignments
         where company_id = $1 and project_id = $2 and deleted_at is null
         order by created_at asc`,
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
    const body = await ctx.readBody()
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

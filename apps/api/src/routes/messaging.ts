import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { Broadcast, ProjectMessage } from '@sitelayer/domain'
import { BROADCAST_AUDIENCES } from '@sitelayer/domain'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid } from '../http-utils.js'

export type MessagingRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const MESSAGE_COLUMNS = `
  id, company_id, project_id, author_user_id, author_role, body, version, created_at, updated_at
`
const BROADCAST_COLUMNS = `
  id, company_id, author_user_id, audience, body, project_id, version, created_at, updated_at
`

/**
 * Cross-role comms routes (100_messaging.sql):
 *   GET  /api/projects/:id/messages   project chat thread (oldest first)
 *   POST /api/projects/:id/messages   { body, author_role? }
 *   GET  /api/broadcasts              company broadcasts (newest first)
 *   POST /api/broadcasts              { body, audience?, project_id? }
 */
export async function handleMessagingRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: MessagingRouteCtx,
): Promise<boolean> {
  // ---- project chat thread ----
  const threadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages$/)
  if (threadMatch) {
    const projectId = threadMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    if (req.method === 'GET') {
      if (!ctx.requireRole(['admin', 'foreman', 'office', 'member', 'bookkeeper'])) return true
      const rows = await withCompanyClient(ctx.company.id, (c) =>
        c.query<ProjectMessage>(
          `select ${MESSAGE_COLUMNS} from project_messages
           where company_id = $1 and project_id = $2 and deleted_at is null
           order by created_at asc`,
          [ctx.company.id, projectId],
        ),
      )
      ctx.sendJson(200, { messages: rows.rows })
      return true
    }
    if (req.method === 'POST') {
      if (!ctx.requireRole(['admin', 'foreman', 'office', 'member', 'bookkeeper'])) return true
      const body = await ctx.readBody()
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      const authorRole = typeof body.author_role === 'string' ? body.author_role : ''
      if (!text) {
        ctx.sendJson(400, { error: 'body is required' })
        return true
      }
      try {
        const created = await withMutationTx(async (client: PoolClient) => {
          const proj = await client.query<{ id: string }>(
            `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
            [ctx.company.id, projectId],
          )
          if (!proj.rows[0]) return { kind: 'not_found' as const }
          const inserted = await client.query<ProjectMessage>(
            `insert into project_messages (company_id, project_id, author_user_id, author_role, body)
             values ($1, $2, $3, $4, $5)
             returning ${MESSAGE_COLUMNS}`,
            [ctx.company.id, projectId, ctx.currentUserId, authorRole, text],
          )
          const row = inserted.rows[0]!
          await recordAudit(client, {
            companyId: ctx.company.id,
            actorUserId: ctx.currentUserId,
            action: 'project_message.created',
            entityType: 'project_message',
            entityId: row.id,
            after: { project_id: projectId },
          })
          return { kind: 'ok' as const, row }
        })
        if (created.kind === 'not_found') {
          ctx.sendJson(404, { error: 'project not found' })
          return true
        }
        ctx.sendJson(201, { message: created.row })
      } catch (err) {
        ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to post message' })
      }
      return true
    }
  }

  // ---- broadcasts ----
  if (url.pathname === '/api/broadcasts') {
    if (req.method === 'GET') {
      if (!ctx.requireRole(['admin', 'foreman', 'office', 'member', 'bookkeeper'])) return true
      const rows = await withCompanyClient(ctx.company.id, (c) =>
        c.query<Broadcast>(
          `select ${BROADCAST_COLUMNS} from broadcasts
           where company_id = $1 and deleted_at is null
           order by created_at desc limit 100`,
          [ctx.company.id],
        ),
      )
      ctx.sendJson(200, { broadcasts: rows.rows })
      return true
    }
    if (req.method === 'POST') {
      // Owner/office only — broadcast is a one-way owner announcement.
      if (!ctx.requireRole(['admin', 'office'])) return true
      const body = await ctx.readBody()
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      const audience = typeof body.audience === 'string' ? body.audience : 'all'
      const projectId = typeof body.project_id === 'string' && isValidUuid(body.project_id) ? body.project_id : null
      if (!text) {
        ctx.sendJson(400, { error: 'body is required' })
        return true
      }
      if (!(BROADCAST_AUDIENCES as readonly string[]).includes(audience)) {
        ctx.sendJson(400, { error: `audience must be one of ${BROADCAST_AUDIENCES.join(', ')}` })
        return true
      }
      try {
        const row = await withMutationTx(async (client: PoolClient) => {
          const inserted = await client.query<Broadcast>(
            `insert into broadcasts (company_id, author_user_id, audience, body, project_id)
             values ($1, $2, $3, $4, $5)
             returning ${BROADCAST_COLUMNS}`,
            [ctx.company.id, ctx.currentUserId, audience, text, projectId],
          )
          const b = inserted.rows[0]!
          await recordAudit(client, {
            companyId: ctx.company.id,
            actorUserId: ctx.currentUserId,
            action: 'broadcast.created',
            entityType: 'broadcast',
            entityId: b.id,
            after: { audience },
          })
          return b
        })
        ctx.sendJson(201, { broadcast: row })
      } catch (err) {
        ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to broadcast' })
      }
      return true
    }
  }

  return false
}

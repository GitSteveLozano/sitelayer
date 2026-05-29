import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { Broadcast, ProjectMessage, ProjectMessageMeta, ProjectMessageSummary } from '@sitelayer/domain'
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
  id, company_id, project_id, author_user_id, author_role, body, meta, version, created_at, updated_at
`
const BROADCAST_COLUMNS = `
  id, company_id, author_user_id, audience, body, project_id, version, created_at, updated_at
`

/**
 * Cross-role comms routes (100_messaging.sql, 105_message_reads_and_meta.sql):
 *   GET  /api/projects/:id/messages           project chat thread (oldest first)
 *   POST /api/projects/:id/messages           { body, author_role?, meta? }
 *   GET  /api/projects/:id/messages/summary   { last_message|null, unread_count }
 *   POST /api/projects/:id/messages/read      mark thread read for the caller
 *   GET  /api/broadcasts                      company broadcasts (newest first)
 *   POST /api/broadcasts                      { body, audience?, project_id? }
 */

/**
 * Coerce an untrusted request value into a structured message marker
 * (project_messages.meta). Accepts only a plain JSON object; anything else
 * (string / array / number / null / missing) maps to null so the column stays
 * NULL for legacy/unmarked messages. The shape is open (ProjectMessageMeta),
 * so we don't reject unknown keys — we just refuse non-objects.
 */
export function parseMessageMeta(value: unknown): ProjectMessageMeta | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as ProjectMessageMeta
}
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
      const meta = parseMessageMeta(body.meta)
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
            `insert into project_messages (company_id, project_id, author_user_id, author_role, body, meta)
             values ($1, $2, $3, $4, $5, $6::jsonb)
             returning ${MESSAGE_COLUMNS}`,
            [
              ctx.company.id,
              projectId,
              ctx.currentUserId,
              authorRole,
              text,
              meta === null ? null : JSON.stringify(meta),
            ],
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

  // ---- thread summary: last message preview + caller's unread count ----
  const summaryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages\/summary$/)
  if (summaryMatch) {
    const projectId = summaryMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    if (req.method === 'GET') {
      if (!ctx.requireRole(['admin', 'foreman', 'office', 'member', 'bookkeeper'])) return true
      const summary = await withCompanyClient(ctx.company.id, async (c) => {
        // Latest non-deleted message in the thread (preview for the list row).
        const last = await c.query<{
          body: string
          author_user_id: string
          author_role: string
          created_at: string
        }>(
          `select body, author_user_id, author_role, created_at
             from project_messages
            where company_id = $1 and project_id = $2 and deleted_at is null
            order by created_at desc
            limit 1`,
          [ctx.company.id, projectId],
        )
        // Unread = messages newer than the caller's read marker (NULL marker =>
        // everything counts as unread). The caller's own messages still count;
        // the read POST that fires on thread-open clears them immediately.
        const unread = await c.query<{ unread_count: string }>(
          `select count(*)::text as unread_count
             from project_messages m
            where m.company_id = $1
              and m.project_id = $2
              and m.deleted_at is null
              and m.created_at > coalesce(
                (select r.last_read_at
                   from message_reads r
                  where r.company_id = $1
                    and r.project_id = $2
                    and r.user_id = $3),
                '-infinity'::timestamptz
              )`,
          [ctx.company.id, projectId, ctx.currentUserId],
        )
        const lastRow = last.rows[0] ?? null
        const result: ProjectMessageSummary = {
          last_message: lastRow,
          unread_count: Number(unread.rows[0]?.unread_count ?? 0),
        }
        return result
      })
      ctx.sendJson(200, summary)
      return true
    }
  }

  // ---- mark thread read: upsert the caller's last_read_at = now() ----
  const readMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages\/read$/)
  if (readMatch) {
    const projectId = readMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    if (req.method === 'POST') {
      if (!ctx.requireRole(['admin', 'foreman', 'office', 'member', 'bookkeeper'])) return true
      try {
        const result = await withMutationTx(async (client: PoolClient) => {
          const proj = await client.query<{ id: string }>(
            `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
            [ctx.company.id, projectId],
          )
          if (!proj.rows[0]) return { kind: 'not_found' as const }
          const upserted = await client.query<{ last_read_at: string }>(
            `insert into message_reads (company_id, project_id, user_id, last_read_at)
             values ($1, $2, $3, now())
             on conflict (company_id, project_id, user_id)
             do update set last_read_at = now()
             returning last_read_at`,
            [ctx.company.id, projectId, ctx.currentUserId],
          )
          return { kind: 'ok' as const, lastReadAt: upserted.rows[0]!.last_read_at }
        })
        if (result.kind === 'not_found') {
          ctx.sendJson(404, { error: 'project not found' })
          return true
        }
        ctx.sendJson(200, { last_read_at: result.lastReadAt })
      } catch (err) {
        ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to mark read' })
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

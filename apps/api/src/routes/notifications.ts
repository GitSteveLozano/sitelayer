import type http from 'node:http'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { isValidUuid } from '../http-utils.js'

export type NotificationRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * Shape returned to the client. `read_at` is stored inside the `payload`
 * jsonb (no migration in this slice — the worker drain owns the row's
 * delivery columns; the user-read flag is an additive extension we keep
 * inline for now). When migration `054_notifications_read_at.sql` lands
 * and adds a real column, the SELECT/UPDATE here flips to it without
 * touching consumers.
 */
type NotificationRow = {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  kind: string
  subject: string
  body_text: string
  payload: Record<string, unknown>
  read_at: string | null
  created_at: string
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(parsed)), MAX_LIMIT)
}

// Project the schema's columns plus a synthesized `read_at` derived from
// payload->>'read_at'. Keeping this string in one constant means the
// list and read-mark queries return the same shape.
const SELECT_PROJECTION = `
  id, company_id, recipient_clerk_user_id,
  kind, subject, body_text, payload,
  (payload->>'read_at') as read_at,
  created_at
`

/**
 * Per-user notification feed. Reads the same `notifications` ledger that
 * the worker drains into for Loop 2 (Field Event Escalation) and the
 * project-lifecycle assignment fan-out. Scoped to
 * `recipient_clerk_user_id = currentUserId` and the active company so a
 * user can only see their own queue.
 *
 * - GET  /api/notifications?unread=1&kind=worker_issue_resolved&limit=20
 *        Returns rows ordered by created_at desc.
 * - POST /api/notifications/:id/read
 *        Marks read_at = now() for a single row owned by the caller.
 *        404s when the row exists but isn't theirs (no leak).
 *
 * The route does not gate on role — any authenticated user can poll
 * their own notifications row, the same way wk-issue lets any user file
 * a ticket. Recipient scoping is enforced via the WHERE clause.
 */
export async function handleNotificationRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: NotificationRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const unreadOnly = url.searchParams.get('unread') === '1'
    const kind = url.searchParams.get('kind')
    const limit = clampLimit(url.searchParams.get('limit'))

    const filters: string[] = ['company_id = $1', 'recipient_clerk_user_id = $2']
    const params: unknown[] = [ctx.company.id, ctx.currentUserId]
    if (unreadOnly) filters.push("(payload->>'read_at') is null")
    if (kind) {
      params.push(kind)
      filters.push(`kind = $${params.length}`)
    }
    params.push(limit)

    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<NotificationRow>(
        `select ${SELECT_PROJECTION}
       from notifications
       where ${filters.join(' and ')}
       order by created_at desc
       limit $${params.length}`,
        params,
      ),
    )
    ctx.sendJson(200, { notifications: result.rows })
    return true
  }

  const readMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
  if (req.method === 'POST' && readMatch) {
    const id = readMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    // Scope the update to (company, recipient) so a caller can never
    // mark someone else's notification read — even if they guess the id.
    // jsonb_set with create_missing=true on payload->>'read_at' keeps the
    // existing payload contents intact while stamping the read time.
    const updated = await withMutationTx(ctx.company.id, (c) =>
      c.query<NotificationRow>(
        `update notifications
         set payload = jsonb_set(
           coalesce(payload, '{}'::jsonb),
           '{read_at}',
           to_jsonb(coalesce(payload->>'read_at', now()::text)),
           true
         )
       where id = $1
         and company_id = $2
         and recipient_clerk_user_id = $3
       returning ${SELECT_PROJECTION}`,
        [id, ctx.company.id, ctx.currentUserId],
      ),
    )
    if (updated.rowCount === 0) {
      ctx.sendJson(404, { error: 'notification not found' })
      return true
    }
    ctx.sendJson(200, { notification: updated.rows[0] })
    return true
  }

  return false
}
